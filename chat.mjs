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
  // Upgrade existing direct-chat databases without losing message IDs or history.
  if (!db.prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'kind')) {
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
    try {
      db.exec(`CREATE TABLE conversations_next (
        id TEXT PRIMARY KEY,
        user_a TEXT REFERENCES users(id), user_b TEXT REFERENCES users(id),
        created_at INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('direct','group')),
        title TEXT, created_by TEXT NOT NULL REFERENCES users(id),
        UNIQUE(user_a,user_b),
        CHECK((kind='direct' AND user_a IS NOT NULL AND user_b IS NOT NULL AND user_a<user_b)
           OR (kind='group' AND user_a IS NULL AND user_b IS NULL AND length(title) BETWEEN 1 AND 60))
      );
      INSERT INTO conversations_next SELECT id,user_a,user_b,created_at,'direct',NULL,user_a FROM conversations;
      DROP TABLE conversations;
      ALTER TABLE conversations_next RENAME TO conversations;`);
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw Error('Conversation migration failed integrity check');
      db.exec('COMMIT;');
    } catch (error) { db.exec('ROLLBACK;'); throw error; }
    finally { db.exec('PRAGMA foreign_keys=ON;'); }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(conversation_id,user_id)
  );
  CREATE INDEX IF NOT EXISTS conversation_members_user ON conversation_members(user_id,conversation_id);
  INSERT OR IGNORE INTO conversation_members SELECT id,user_a FROM conversations WHERE kind='direct';
  INSERT OR IGNORE INTO conversation_members SELECT id,user_b FROM conversations WHERE kind='direct';`);
  db.exec(`CREATE TABLE IF NOT EXISTS friends (
    owner_id TEXT NOT NULL REFERENCES users(id),
    friend_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id,friend_id), CHECK(owner_id<>friend_id)
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_preferences (
    conversation_id TEXT NOT NULL, user_id TEXT NOT NULL,
    pinned_at INTEGER, hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
    PRIMARY KEY(conversation_id,user_id),
    FOREIGN KEY(conversation_id,user_id) REFERENCES conversation_members(conversation_id,user_id)
  );`);
  function members(id) {
    return db.prepare('SELECT u.id,u.name FROM conversation_members m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=? ORDER BY u.name,u.id').all(id);
  }
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
    return db.prepare('SELECT c.* FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id WHERE c.id=? AND m.user_id=?').get(id, userId);
  }
  async function route(req, res, url) {
    const path = url.pathname;
    if (!['/api/users', '/api/conversations', '/api/events', '/api/friends', '/api/friends/remove'].includes(path) && !path.startsWith('/api/conversations/')) return false;
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
    if (path === '/api/friends' && req.method === 'GET') {
      const friends = db.prepare(`SELECT u.id,u.name,f.created_at FROM friends f
        JOIN users u ON u.id=f.friend_id WHERE f.owner_id=? ORDER BY u.name,u.id`).all(user.id);
      json(res, 200, { friends }); return true;
    }
    if ((path === '/api/friends' || path === '/api/friends/remove') && req.method === 'POST') {
      const data = await body(req);
      if (typeof data.userId !== 'string' || data.userId === user.id || !db.prepare('SELECT id FROM users WHERE id=?').get(data.userId)) {
        json(res, 400, { error: '친구로 저장할 가입자를 선택해 주세요.' }); return true;
      }
      if (path === '/api/friends/remove') {
        db.prepare('DELETE FROM friends WHERE owner_id=? AND friend_id=?').run(user.id, data.userId);
        notify([user.id]); json(res, 200, { ok: true }); return true;
      }
      const added = db.prepare('INSERT OR IGNORE INTO friends VALUES(?,?,?)').run(user.id, data.userId, Date.now());
      const friend = db.prepare(`SELECT u.id,u.name,f.created_at FROM friends f JOIN users u ON u.id=f.friend_id WHERE f.owner_id=? AND f.friend_id=?`).get(user.id, data.userId);
      notify([user.id]); json(res, added.changes ? 201 : 200, { friend }); return true;
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
      const conversations = db.prepare(`SELECT c.id,c.created_at,c.kind,c.title,c.created_by,p.pinned_at,
        (SELECT text FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_text,
        (SELECT created_at FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_at
        FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id
        LEFT JOIN conversation_preferences p ON p.conversation_id=c.id AND p.user_id=m.user_id
        WHERE m.user_id=? AND COALESCE(p.hidden,0)=0
        ORDER BY (p.pinned_at IS NOT NULL) DESC,p.pinned_at DESC,COALESCE(last_at,c.created_at) DESC,c.id`).all(user.id).map(c => {
          const participants = members(c.id), peer = participants.find(p => p.id !== user.id);
          return { ...c, peer_id: c.kind === 'direct' ? peer.id : null,
            peer_name: c.kind === 'group' ? c.title : peer.name,
            member_count: participants.length, members: participants };
        });
      json(res, 200, { conversations }); return true;
    }
    if (path === '/api/conversations' && req.method === 'POST') {
      const data = await body(req);
      if (data.kind === 'group') {
        const title = typeof data.title === 'string' ? data.title.trim() : '';
        if (!title || title.length > 60 || !Array.isArray(data.userIds) || data.userIds.length < 2 || data.userIds.length > 49 || data.userIds.some(id => typeof id !== 'string')) {
          json(res, 400, { error: '방 이름(1~60자)과 초대할 친구 2~49명을 선택해 주세요.' }); return true;
        }
        const ids = [...new Set([user.id, ...data.userIds])];
        if (ids.length !== data.userIds.length + 1 || ids.some(id => !db.prepare('SELECT id FROM users WHERE id=?').get(id))) {
          json(res, 400, { error: '중복되지 않은 가입자를 선택해 주세요. 본인은 자동 포함됩니다.' }); return true;
        }
        const id = randomBytes(16).toString('hex');
        db.exec('BEGIN IMMEDIATE;');
        try {
          db.prepare("INSERT INTO conversations(id,created_at,kind,title,created_by) VALUES(?,?,'group',?,?)").run(id, Date.now(), title, user.id);
          for (const userId of ids) db.prepare('INSERT INTO conversation_members VALUES(?,?)').run(id, userId);
          db.exec('COMMIT;');
        } catch (error) { db.exec('ROLLBACK;'); throw error; }
        notify(ids); json(res, 201, { conversation: { id } }); return true;
      }
      if ((data.kind !== undefined && data.kind !== 'direct') || typeof data.userId !== 'string' || data.userId === user.id || !db.prepare('SELECT id FROM users WHERE id=?').get(data.userId)) {
        json(res, 400, { error: '대화할 상대방을 선택해 주세요.' }); return true;
      }
      const [a, b] = [user.id, data.userId].sort();
      let conversation = db.prepare("SELECT id FROM conversations WHERE kind='direct' AND user_a=? AND user_b=?").get(a, b);
      const created = !conversation;
      if (created) {
        const id = randomBytes(16).toString('hex');
        db.exec('BEGIN IMMEDIATE;');
        try {
          db.prepare("INSERT INTO conversations(id,user_a,user_b,created_at,kind,created_by) VALUES(?,?,?,?,'direct',?)").run(id, a, b, Date.now(), user.id);
          for (const userId of [a,b]) db.prepare('INSERT INTO conversation_members VALUES(?,?)').run(id, userId);
          db.exec('COMMIT;'); conversation = { id };
        } catch (error) { db.exec('ROLLBACK;'); throw error; }
      }
      db.prepare('UPDATE conversation_preferences SET hidden=0 WHERE conversation_id=? AND user_id=?').run(conversation.id, user.id);
      notify([a, b]); json(res, created ? 201 : 200, { conversation }); return true;
    }
    const preferenceMatch = path.match(/^\/api\/conversations\/([a-f0-9]{32})\/preferences$/);
    if (preferenceMatch && req.method === 'POST') {
      const conversation = member(preferenceMatch[1], user.id);
      if (!conversation) { json(res, 404, { error: '대화를 찾을 수 없습니다.' }); return true; }
      const data = await body(req);
      const pin = typeof data.pinned === 'boolean', hide = typeof data.hidden === 'boolean';
      if (pin === hide) { json(res, 400, { error: '고정 또는 삭제 설정 중 하나를 선택해 주세요.' }); return true; }
      if (pin) {
        db.prepare(`INSERT INTO conversation_preferences(conversation_id,user_id,pinned_at,hidden) VALUES(?,?,?,0)
          ON CONFLICT(conversation_id,user_id) DO UPDATE SET pinned_at=excluded.pinned_at,hidden=0`).run(conversation.id,user.id,data.pinned ? Date.now() : null);
      } else {
        db.prepare(`INSERT INTO conversation_preferences(conversation_id,user_id,pinned_at,hidden) VALUES(?,?,NULL,?)
          ON CONFLICT(conversation_id,user_id) DO UPDATE SET hidden=excluded.hidden,pinned_at=CASE WHEN excluded.hidden=1 THEN NULL ELSE conversation_preferences.pinned_at END`).run(conversation.id,user.id,data.hidden ? 1 : 0);
      }
      notify([user.id]); json(res, 200, { ok: true }); return true;
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
      db.prepare('UPDATE conversation_preferences SET hidden=0 WHERE conversation_id=?').run(conversation.id);
      notify(members(conversation.id).map(member => member.id));
      json(res, 201, { message }); return true;
    }
    json(res, 404, { error: '요청을 찾을 수 없습니다.' }); return true;
  }
  return { route, revoke };
}
