import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
test('account lifecycle, security boundaries and persistence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pingo-auth-'));
  const port = 34000 + Math.floor(Math.random() * 10000), base = `http://127.0.0.1:${port}`;
  const dbPath = join(dir, 'test.sqlite'); let child;
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('../', import.meta.url), env: { ...process.env, PORT: String(port), PINGO_DB_PATH: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    let ready = false; child.stdout.on('data', () => { ready = true; });
    for (let i = 0; i < 100 && !ready; i++) { if (child.exitCode !== null) throw Error('Server failed to start'); await new Promise(r => setTimeout(r, 30)); }
    assert.ok(ready, 'server ready');
  }
  async function stop() { const exited = once(child, 'exit'); child.kill(); await exited; }
  async function req(path, data, cookie, extra = {}) {
    return fetch(base + '/api/' + path, { method: data === undefined ? 'GET' : 'POST', headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: data === undefined ? undefined : JSON.stringify(data) });
  }
  const account = { name: '테스트 사용자', email: 'Alice@Example.com', password: 'correct horse battery' };
  try {
    await start();
    assert.equal((await req('me')).status, 401);
    assert.equal((await req('signup', { ...account, password: 'short' })).status, 400);
    const signup = await req('signup', account); assert.equal(signup.status, 201);
    const cookie = signup.headers.get('set-cookie'); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
    const user = (await signup.json()).user; assert.equal(user.email, 'alice@example.com'); assert.equal(user.password_hash, undefined);
    assert.equal((await req('me', undefined, cookie)).status, 200);
    assert.equal((await req('signup', account)).status, 409);
    assert.equal((await req('login', { ...account, password: 'wrong password here' })).status, 401);
    assert.equal((await req('logout', {}, cookie, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await req('logout', {}, cookie, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await req('me', undefined, 'pingo_session=forged')).status, 401);
    assert.equal((await fetch(base + '/.data/pingo.sqlite')).status, 404);
    await stop(); await start();
    assert.equal((await req('me', undefined, cookie)).status, 200, 'session survives restart');
    assert.equal((await req('logout', {}, cookie)).status, 200);
    assert.equal((await req('me', undefined, cookie)).status, 401, 'logout invalidates token');
    const login = await req('login', account); assert.equal(login.status, 200); const nextCookie = login.headers.get('set-cookie');
    assert.notEqual(nextCookie, cookie);
    const db = new DatabaseSync(dbPath); const stored = db.prepare('SELECT * FROM users').get(); assert.notEqual(stored.password_hash, account.password); assert.equal(stored.password_hash.length, 128);
    assert.notEqual(db.prepare('SELECT token_hash FROM sessions').get().token_hash, nextCookie.split(';')[0].split('=')[1]);
    db.prepare('UPDATE sessions SET expires=0').run(); db.close();
    assert.equal((await req('me', undefined, nextCookie)).status, 401, 'expired session rejected');
    let response; for(let i=0;i<31;i++) response=await req('login', { ...account, password: 'wrong password here' });
    assert.equal(response.status, 429);
  } finally { if(child && child.exitCode === null) await stop(); await rm(dir, { recursive: true, force: true }); }
});
