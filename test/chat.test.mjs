import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

test('private live conversations, idempotent sends, paging and durable history', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pingo-chat-'));
  const port = 45000 + Math.floor(Math.random() * 10000), base = `http://127.0.0.1:${port}`;
  let child; const controllers = [];
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('../', import.meta.url), env: { ...process.env, PORT: String(port), PINGO_DB_PATH: join(dir, 'chat.sqlite') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let ready = false; child.stdout.on('data', () => { ready = true; });
    for (let i = 0; i < 100 && !ready; i++) { if (child.exitCode !== null) throw Error('Server failed'); await new Promise(r => setTimeout(r, 30)); }
    assert.ok(ready);
  }
  async function stop() { const exit = once(child, 'exit'); child.kill(); await exit; }
  async function request(path, cookie, data) {
    return fetch(base + '/api/' + path, { method: data === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
  }
  async function signup(name, email) {
    const response = await request('signup', null, { name, email, password: 'test-password-12345' }); assert.equal(response.status, 201);
    return { cookie: response.headers.get('set-cookie').split(';')[0], user: (await response.json()).user };
  }
  async function stream(cookie) {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(base + '/api/events', { headers: { Cookie: cookie }, signal: controller.signal }); assert.equal(response.status, 200);
    const reader = response.body.getReader(); let buffer = '';
    return { async nextEvent() {
      while (!buffer.includes('\n\n')) { const result = await reader.read(); if (result.done) return null; buffer += new TextDecoder().decode(result.value); }
      const end = buffer.indexOf('\n\n'); const event = buffer.slice(0, end); buffer = buffer.slice(end + 2); return event;
    } };
  }
  try {
    await start();
    const alice = await signup('앨리스', 'alice@example.com'), bob = await signup('밥친구', 'bob@example.com'), eve = await signup('이브', 'eve@example.com');
    assert.equal((await request('conversations')).status, 401); assert.equal((await request('events')).status, 401);
    assert.equal((await request('users?q=alice@example.com', bob.cookie).then(r => r.json())).users[0].id, alice.user.id);
    const found = await request('users?q=밥친구', alice.cookie).then(r => r.json()); assert.equal(found.users[0].id, bob.user.id); assert.equal(found.users[0].email, undefined);
    assert.equal((await request('users?q=alice@', bob.cookie).then(r => r.json())).users.length, 0);
    assert.equal((await request('conversations', alice.cookie, { userId: alice.user.id })).status, 400);
    const initial = await request('conversations', alice.cookie, { userId: bob.user.id }); assert.equal(initial.status, 201); const id = (await initial.json()).conversation.id;
    assert.equal((await request('conversations', bob.cookie, { userId: alice.user.id }).then(r => r.json())).conversation.id, id);
    assert.equal((await request('conversations', bob.cookie).then(r => r.json())).conversations.length, 1);
    const path = `conversations/${id}/messages`;
    assert.equal((await request(path, eve.cookie)).status, 404);
    assert.equal((await request(path, eve.cookie, { text: 'intrusion', clientId: randomUUID() })).status, 404);
    assert.equal((await request('conversations', eve.cookie).then(r => r.json())).conversations.length, 0);
    const live = await stream(bob.cookie); assert.match(await live.nextEvent(), /event: sync/);
    const payload = { text: '안녕 <script> 💙', clientId: randomUUID(), sender_id: eve.user.id };
    const sent = await request(path, alice.cookie, payload); assert.equal(sent.status, 201); const message = (await sent.json()).message; assert.equal(message.sender_id, alice.user.id);
    assert.match(await Promise.race([live.nextEvent(), new Promise((_, reject) => { const t=setTimeout(() => reject(Error('No realtime event')), 3000); t.unref(); })]), /event: sync/);
    assert.equal((await request(path, alice.cookie, payload)).status, 200);
    assert.equal((await request(path, bob.cookie).then(r => r.json())).messages.length, 1);
    assert.equal((await request(path, alice.cookie, { ...payload, text: 'different' })).status, 409);
    assert.equal((await request(path, alice.cookie, { text: '   ', clientId: randomUUID() })).status, 400);
    assert.equal((await request(path, alice.cookie, { text: 'x'.repeat(2001), clientId: randomUUID() })).status, 400);
    for(let i=0;i<54;i++) assert.equal((await request(path, alice.cookie, { text: 'message-'+i, clientId: randomUUID() })).status, 201);
    const latest = await request(path, bob.cookie).then(r => r.json()); assert.equal(latest.messages.length, 50); assert.equal(latest.hasMore, true);
    const earlier = await request(path+'?before='+latest.messages[0].id, bob.cookie).then(r => r.json()); assert.equal(earlier.messages.length, 5); assert.equal(earlier.hasMore, false);
    assert.equal((await request(path+'?before=invalid', bob.cookie)).status, 400);
    await request('logout', bob.cookie, {});
    let last; do { last = await live.nextEvent(); } while (last && !last.includes('event: expired'));
    assert.match(last, /event: expired/); assert.equal((await request('events', bob.cookie)).status, 401);
    controllers.forEach(c => c.abort()); await stop(); await start();
    const restored = await request(path, alice.cookie).then(r => r.json()); assert.equal(restored.messages.length, 50); assert.equal(restored.messages.at(-1).text, 'message-53');
    assert.equal((await request(path, eve.cookie)).status, 404);
  } finally { controllers.forEach(c => c.abort()); if (child && child.exitCode === null) await stop(); await rm(dir, { recursive: true, force: true }); }
});
