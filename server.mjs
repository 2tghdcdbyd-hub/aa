import http from 'node:http';
import { createChat } from './chat.mjs';
import { createRecovery } from './recovery.mjs';
import { createLocalFileStore } from './file-store.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
const scrypt = promisify(scryptCallback);
const dbPath = process.env.PINGO_DB_PATH || new URL('./.data/pingo.sqlite', import.meta.url).pathname;
await mkdir(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);`);
const secure = process.env.COOKIE_SECURE === 'true';
const cookieName = secure ? '__Host-pingo_session' : 'pingo_session';
const ttl = 7 * 24 * 60 * 60;
const hash = token => createHash('sha256').update(token).digest('hex');
const publicUser = u => ({ id: u.id, name: u.name, email: u.email });
function sessionToken(req) { return (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || ''; }
function userFor(req) { return db.prepare('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires>?').get(hash(sessionToken(req)), Date.now()); }
function setSession(req, res, user) {
  db.prepare('DELETE FROM sessions WHERE token_hash=? OR expires<=?').run(hash(sessionToken(req)), Date.now());
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), user.id, Date.now() + ttl * 1000);
  res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttl}${secure ? '; Secure' : ''}`);
}
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
async function body(req) {
  let text = ''; let size = 0;
  for await (const part of req) { size += part.length; if (size > 16384) throw Object.assign(new Error('요청이 너무 큽니다.'), { status: 413 }); text += part; }
  try { const result = JSON.parse(text); if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error(); return result; }
  catch { throw Object.assign(new Error('올바른 JSON 요청이 필요합니다.'), { status: 400 }); }
}
const attempts = new Map();
const cleanup = setInterval(() => { for (const [key, value] of attempts) if (value.until <= Date.now()) attempts.delete(key); db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now()); }, 60_000); cleanup.unref();
function limited(req) {
  const key = req.socket.remoteAddress;
  let entry = attempts.get(key);
  if (!entry || entry.until <= Date.now()) { entry = { count: 0, until: Date.now() + 15 * 60_000 }; attempts.set(key, entry); }
  return ++entry.count > 30;
}
const storage = createLocalFileStore(process.env.PINGO_UPLOAD_DIR || new URL('./.data/uploads',import.meta.url).pathname);
const chat = createChat(db, { json, body, userFor, sessionToken, hash, storage });
const recovery = createRecovery(db,{json,body,userFor,scrypt,hash,limited,revokeUser:chat.revokeUser});
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/auth.js': ['auth.js', 'text/javascript'], '/safety.js': ['safety.js','text/javascript'], '/attachments-client.js':['attachments-client.js','text/javascript'], '/style.css': ['style.css', 'text/css'] };
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (path.startsWith('/api/')) {
      if (req.method === 'POST') {
        // Require JSON and reject cross-origin requests; cookies never authorize cross-site writes.
        let sameOrigin = true;
        if (req.headers.origin) { try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { sameOrigin = false; } }
        if (!sameOrigin || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '다른 사이트의 요청은 허용되지 않습니다.' });
        const uploadRoute = /^\/api\/conversations\/[a-f0-9]{32}\/files$/.test(path);
        if (req.headers['content-type']?.split(';')[0].trim() !== (uploadRoute ? 'application/octet-stream' : 'application/json')) return json(res, 415, { error: uploadRoute ? '파일은 바이너리 전송 형식으로 보내 주세요.' : 'JSON 요청이 필요합니다.' });
      }
      if (await recovery.route(req,res,path)) return;
      if (await chat.route(req, res, url)) return;
      if (path === '/api/me' && req.method === 'GET') { const user = userFor(req); return json(res, user ? 200 : 401, user ? { user: publicUser(user) } : { error: '로그인이 필요합니다.' }); }
      if (path === '/api/logout' && req.method === 'POST') {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(sessionToken(req)));
        chat.revoke(sessionToken(req));
        res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      }
      if ((path === '/api/signup' || path === '/api/login') && req.method === 'POST') {
        if (limited(req)) { res.setHeader('Retry-After', '900'); return json(res, 429, { error: '시도가 너무 많습니다. 15분 후 다시 시도해 주세요.' }); }
        const data = await body(req);
        const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
        const password = typeof data.password === 'string' ? data.password : '';
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10 || password.length > 128) return json(res, 400, { error: '올바른 이메일과 10~128자의 비밀번호를 입력해 주세요.' });
        if (path === '/api/signup') {
          const name = typeof data.name === 'string' ? data.name.trim() : '';
          if (!name || name.length > 30) return json(res, 400, { error: '이름은 1~30자로 입력해 주세요.' });
          const salt = randomBytes(16).toString('hex');
          const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
          const user = { id: randomBytes(16).toString('hex'), email, name };
          try { db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(user.id, email, name, salt, passwordHash); }
          catch (e) { if (e.code?.includes('SQLITE_CONSTRAINT') || e.message.includes('UNIQUE constraint')) return json(res, 409, { error: '이 이메일로 가입할 수 없습니다. 로그인하거나 다른 이메일을 사용해 주세요.' }); throw e; }
          setSession(req, res, user); return json(res, 201, { user, recoveryCode: recovery.issue(user.id) });
        }
        const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
        const derived = await scrypt(password, user?.salt || 'pingo-missing-user-salt', 64);
        const valid = timingSafeEqual(derived, user ? Buffer.from(user.password_hash, 'hex') : Buffer.alloc(64));
        if (!user || !valid) return json(res, 401, { error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
        setSession(req, res, user); return json(res, 200, { user: publicUser(user) });
      }
      return json(res, 404, { error: '요청을 찾을 수 없습니다.' });
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    const file = files[path]; if (!file) { res.writeHead(404); return res.end('Not found'); }
    const content = await readFile(new URL(file[0], import.meta.url));
    res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) { if(res.headersSent||res.destroyed){res.destroy();return;} req.resume(); json(res, error.status || 500, { error: error.status ? error.message : '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' }); }
});
server.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => console.log('Pingo running on port ' + (process.env.PORT || 3000)));
