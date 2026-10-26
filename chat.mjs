import { randomBytes } from 'node:crypto';

// One process owns the live streams; SQLite owns durable conversation history.
export function createChat(db, { json, body, userFor, sessionToken, hash }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_a TEXT NOT NULL REFERENCES users(id),
      user_b TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      UNIQUE(user_a, user_b), CHECK(user_a < user_b)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      sender_id TEXT NOT NULL REFERENCES users(id),
      client_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(sender_id, client_id)
    );
    CREATE INDEX IF NOT EXISTS messages_conversation_id ON messages(conversation_id, id);
  `);
  const streams = new Set();
  const rates = new Map();
  function notify(ids) {
    for (const stream of streams) {
      if (!ids.includes(stream.userId)) continue;
      if (!userFor(stream.req)) { stream.res.write('event: expired\ndata: {}\n\n'); stream.res.end(); continue; }
      if (stream.res.writableLength > 65536) { stream.res.destroy(); continue; }
      stream.res.write('event: sync\ndata: {}\n\n');
    }
  }
  function revoke(token) {
    for (const stream of streams) if (stream.tokenHash === hash(token)) {
      stream.res.write('event: expired\ndata: {}\n\n'); stream.res.end();
    }
  }
  const timer = setInterval(() => {
    for (const stream of streams) {
      if (!userFor(stream.req)) { stream.res.write('event: expired\ndata: {}\n\n'); stream.res.end(); }
      else stream.res.write(': heartbeat\n\n');
    }
    for (const [id, value] of rates) if (value.until < Date.now()) rates.delete(id);
  }, 15000); timer.unref();
  function member(id, userId) {
    return db.prepare('SELECT * FROM conversations WHERE id=? AND (user_a=? OR user_b=?)').get(id, userId, userId);
  }
  async function route(req, res, url) {
    const path = url.pathname;
    if (!['/api/users', '/api/conversations', '/api/events'].includes(path) && !path.startsWith('/api/conversations/')) return false;
    const user = userFor(req);
    if (!user) { json(res, 401, { error: '로그인이 필요합니다.' }); return true; }
    if (path === '/api/events' && req.method === 'GET') {
      if ([...streams].filter(s => s.userId === user.id).length >= 10) { json(res, 429, { error: '열린 채팅 창이 너무 많습니다.' }); return true; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
      const stream = { req, res, userId: user.id, tokenHash: hash(sessionToken(req)) };
      streams.add(stream);
      res.on('close', () => streams.delete(stream));
      res.write('retry: 2000\nevent: sync\ndata: {}\n\n');
      return true;
    }
    if (path === '/api/users' && req.method === 'GET') {
      const query = (url.searchParams.get('q') || '').trim();
      if (query.length < 2 || query.length > 254) { json(res, 400, { error: '이름은 두 글자 이상, 이메일은 전체 주소를 입력해 주세요.' }); return true; }
      const users = query.includes('@')
        ? db.prepare('SELECT id,name FROM users WHERE email=? AND id<>? LIMIT 20').all(query.toLowerCase(), user.id)
        : db.prepare('SELECT id,name FROM users WHERE instr(lower(name),lower(?))>0 AND id<>? ORDER BY name,id LIMIT 20').all(query, user.id);
      json(res, 200, { users }); return true;
    }
    if (path === '/api/conversations' && req.method === 'GET') {
      const conversations = db.prepare(`SELECT c.id,c.created_at,u.id AS peer_id,u.name AS peer_name,
        (SELECT text FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_text,
        (SELECT created_at FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_at
        FROM conversations c JOIN users u ON u.id=CASE WHEN c.user_a=? THEN c.user_b ELSE c.user_a END
        WHERE c.user_a=? OR c.user_b=? ORDER BY COALESCE(last_at,c.created_at) DESC,c.id`).all(user.id, user.id, user.id);
      json(res, 200, { conversations }); return true;
    }
    if (path === '/api/conversations' && req.method === 'POST') {
      const data = await body(req);
      if (typeof data.userId !== 'string' || data.userId === user.id || !db.prepare('SELECT id FROM users WHERE id=?').get(data.userId)) {
        json(res, 400, { error: '대화할 상대방을 선택해 주세요.' }); return true;
      }
      const [a, b] = [user.id, data.userId].sort();
      const inserted = db.prepare('INSERT OR IGNORE INTO conversations VALUES(?,?,?,?)').run(randomBytes(16).toString('hex'), a, b, Date.now());
      const conversation = db.prepare('SELECT id FROM conversations WHERE user_a=? AND user_b=?').get(a, b);
      notify([a, b]); json(res, inserted.changes ? 201 : 200, { conversation }); return true;
    }
    const match = path.match(/^\/api\/conversations\/([a-f0-9]{32})\/messages$/);
    if (match && ['GET', 'POST'].includes(req.method)) {
      const conversation = member(match[1], user.id);
      if (!conversation) { json(res, 404, { error: '대화를 찾을 수 없습니다.' }); return true; }
      if (req.method === 'GET') {
        const before = url.searchParams.get('before');
        if (before !== null && (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)))) { json(res, 400, { error: '올바른 메시지 위치가 필요합니다.' }); return true; }
        const rows = db.prepare('SELECT id,sender_id,text,created_at FROM messages WHERE conversation_id=? AND id<? ORDER BY id DESC LIMIT 51').all(conversation.id, before === null ? Number.MAX_SAFE_INTEGER : Number(before));
        const hasMore = rows.length > 50;
        json(res, 200, { messages: rows.slice(0, 50).reverse(), hasMore }); return true;
      }
      const data = await body(req);
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      if (!text || text.length > 2000 || typeof data.clientId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(data.clientId)) {
        json(res, 400, { error: '메시지는 1~2000자이며 올바른 전송 ID가 필요합니다.' }); return true;
      }
      // Retries after a lost response cannot create a second copy of a message.
      const existing = db.prepare('SELECT * FROM messages WHERE sender_id=? AND client_id=?').get(user.id, data.clientId);
      if (existing) {
        if (existing.conversation_id !== conversation.id || existing.text !== text) json(res, 409, { error: '전송 ID가 다른 메시지에 사용되었습니다.' });
        else { const { client_id, conversation_id, ...message } = existing; json(res, 200, { message }); }
        return true;
      }
      let rate = rates.get(user.id);
      if (!rate || rate.until <= Date.now()) { rate = { count: 0, until: Date.now() + 60000 }; rates.set(user.id, rate); }
      if (++rate.count > 120) { res.setHeader('Retry-After', '60'); json(res, 429, { error: '메시지를 너무 빠르게 보내고 있습니다. 잠시 후 다시 시도해 주세요.' }); return true; }
      const result = db.prepare('INSERT INTO messages(conversation_id,sender_id,client_id,text,created_at) VALUES(?,?,?,?,?)').run(conversation.id, user.id, data.clientId, text, Date.now());
      const message = db.prepare('SELECT id,sender_id,text,created_at FROM messages WHERE id=?').get(result.lastInsertRowid);
      notify([conversation.user_a, conversation.user_b]);
      json(res, 201, { message }); return true;
    }
    json(res, 404, { error: '요청을 찾을 수 없습니다.' }); return true;
  }
  return { route, revoke };
}
