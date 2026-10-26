import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

test('chat, friends, personal pin/delete settings, realtime sync and persistence', { timeout: 30000 }, async () => {
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
    // A real pre-group schema exercises the automatic upgrade and preserves old IDs/history.
    const legacy = new DatabaseSync(join(dir, 'chat.sqlite'));
    legacy.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL);
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
      CREATE TABLE conversations(id TEXT PRIMARY KEY,user_a TEXT NOT NULL REFERENCES users(id),user_b TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,UNIQUE(user_a,user_b),CHECK(user_a<user_b));
      CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL REFERENCES conversations(id),sender_id TEXT NOT NULL REFERENCES users(id),client_id TEXT NOT NULL,text TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(sender_id,client_id));
      INSERT INTO users VALUES('legacy-a','legacy-a@example.com','예전 사용자 A','unused','unused'),('legacy-b','legacy-b@example.com','예전 사용자 B','unused','unused');
      INSERT INTO conversations VALUES('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','legacy-a','legacy-b',1);
      INSERT INTO messages VALUES(1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','legacy-a','legacy-message-id','보존할 기존 대화',1);`);
    legacy.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update('legacy-token').digest('hex'), 'legacy-a', Date.now()+60000);
    legacy.close();
    await start();
    const oldPath = 'conversations/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/messages';
    const oldHistory = await request(oldPath, 'pingo_session=legacy-token').then(r => r.json());
    assert.equal(oldHistory.messages[0].text, '보존할 기존 대화'); assert.equal(oldHistory.messages[0].id, 1);
    assert.equal((await request('conversations', 'pingo_session=legacy-token').then(r => r.json())).conversations[0].members.length, 2);
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
    const bobLogin = await request('login', null, { email: 'bob@example.com', password: 'test-password-12345' });
    bob.cookie = bobLogin.headers.get('set-cookie').split(';')[0];
    const outsider = await signup('외부 사용자', 'outsider@example.com');
    const groupData = { kind: 'group', title: '우리 모임', userIds: [bob.user.id, eve.user.id] };
    for (const invalid of [
      { ...groupData, title: ' ' }, { ...groupData, title: 'x'.repeat(61) },
      { ...groupData, userIds: [bob.user.id] }, { ...groupData, userIds: [bob.user.id,bob.user.id] },
      { ...groupData, userIds: [alice.user.id,bob.user.id] }, { ...groupData, userIds: [bob.user.id,'unknown-user'] },
      { ...groupData, userIds: Array(50).fill(bob.user.id) }
    ]) assert.equal((await request('conversations', alice.cookie, invalid)).status, 400);
    const groupResponse = await request('conversations', alice.cookie, groupData); assert.equal(groupResponse.status, 201);
    const groupId = (await groupResponse.json()).conversation.id, groupPath = `conversations/${groupId}/messages`;
    for (const person of [alice,bob,eve]) {
      const group = (await request('conversations', person.cookie).then(r => r.json())).conversations.find(c => c.id === groupId);
      assert.equal(group.kind,'group'); assert.equal(group.title,'우리 모임'); assert.equal(group.member_count,3);
      assert.deepEqual(group.members.map(m=>m.id).sort(),[alice.user.id,bob.user.id,eve.user.id].sort());
    }
    const bobLive = await stream(bob.cookie), eveLive = await stream(eve.cookie);
    await bobLive.nextEvent(); await eveLive.nextEvent();
    for (const person of [alice,bob,eve]) {
      const response=await request(groupPath,person.cookie,{text:person.user.name+'의 단체 메시지',clientId:randomUUID()});
      assert.equal(response.status,201); assert.equal((await response.json()).message.sender_id,person.user.id);
    }
    assert.match(await bobLive.nextEvent(),/event: sync/); assert.match(await eveLive.nextEvent(),/event: sync/);
    for (const person of [alice,bob,eve]) assert.equal((await request(groupPath,person.cookie).then(r=>r.json())).messages.length,3);
    assert.equal((await request(groupPath,outsider.cookie)).status,404);
    assert.equal((await request(groupPath,outsider.cookie,{text:'침입',clientId:randomUUID()})).status,404);
    assert.equal((await request('conversations',outsider.cookie).then(r=>r.json())).conversations.length,0);
    controllers.forEach(c=>c.abort()); await stop(); await start();
    assert.equal((await request(groupPath,eve.cookie).then(r=>r.json())).messages.length,3);
    assert.equal((await request(oldPath,'pingo_session=legacy-token').then(r=>r.json())).messages[0].text,'보존할 기존 대화');
    assert.equal((await request(path,alice.cookie).then(r=>r.json())).messages.at(-1).text,'message-53');
    assert.equal((await request('friends')).status,401);
    assert.equal((await request('friends',null,{userId:bob.user.id})).status,401);
    assert.equal((await request('friends',alice.cookie).then(r=>r.json())).friends.length,0);
    assert.equal((await request('friends',alice.cookie,{userId:alice.user.id})).status,400);
    assert.equal((await request('friends',alice.cookie,{userId:'missing'})).status,400);
    const friendLive=await stream(alice.cookie); await friendLive.nextEvent();
    const added=await request('friends',alice.cookie,{userId:bob.user.id,owner_id:eve.user.id});
    assert.equal(added.status,201); const friend=(await added.json()).friend;
    assert.equal(friend.name,bob.user.name); assert.equal(friend.email,undefined);
    assert.match(await friendLive.nextEvent(),/event: sync/);
    assert.equal((await request('friends',alice.cookie,{userId:bob.user.id})).status,200);
    assert.equal((await request('friends',alice.cookie).then(r=>r.json())).friends.length,1);
    assert.equal((await request('friends',bob.cookie).then(r=>r.json())).friends.length,0,'saving is personal, not mutual');
    assert.equal((await request('friends',eve.cookie).then(r=>r.json())).friends.length,0,'owner comes from session');
    await request('friends',eve.cookie,{userId:bob.user.id});
    await request('friends/remove',eve.cookie,{userId:bob.user.id,owner_id:alice.user.id});
    assert.equal((await request('friends',alice.cookie).then(r=>r.json())).friends.length,1,'another user cannot remove my friend');
    controllers.forEach(c=>c.abort()); await stop(); await start();
    const savedFriends=(await request('friends',alice.cookie).then(r=>r.json())).friends;
    assert.equal(savedFriends[0].id,bob.user.id); assert.equal(savedFriends[0].created_at,friend.created_at);
    const newLogin=await request('login',null,{email:'alice@example.com',password:'test-password-12345'});
    const otherDevice=newLogin.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('friends',otherDevice).then(r=>r.json())).friends[0].id,bob.user.id);
    assert.equal((await request('friends/remove',otherDevice,{userId:bob.user.id})).status,200);
    assert.equal((await request('friends',alice.cookie).then(r=>r.json())).friends.length,0);
    assert.equal((await request(path,alice.cookie).then(r=>r.json())).messages.at(-1).text,'message-53','friend removal preserves existing chat');
    assert.equal((await request(groupPath,alice.cookie).then(r=>r.json())).messages.length,3);
    const prefs=`conversations/${id}/preferences`, groupPrefs=`conversations/${groupId}/preferences`;
    assert.equal((await request(prefs,null,{pinned:true})).status,401);
    assert.equal((await request(groupPrefs,outsider.cookie,{hidden:true})).status,404);
    assert.equal((await request(groupPrefs,outsider.cookie,{pinned:true})).status,404);
    assert.equal((await request(prefs,alice.cookie,{pinned:'yes'})).status,400);
    assert.equal((await request(prefs,alice.cookie,{pinned:true,hidden:true})).status,400);
    assert.equal((await request(groupPrefs,alice.cookie,{pinned:true,user_id:bob.user.id})).status,200);
    let personalRooms=(await request('conversations',alice.cookie).then(r=>r.json())).conversations;
    assert.equal(personalRooms[0].id,groupId); assert.ok(personalRooms[0].pinned_at);
    assert.equal((await request('conversations',bob.cookie).then(r=>r.json())).conversations.find(c=>c.id===groupId).pinned_at,null);
    await request(path,bob.cookie,{text:'newer direct message',clientId:randomUUID()});
    assert.equal((await request('conversations',alice.cookie).then(r=>r.json())).conversations[0].id,groupId,'pin beats more recent messages');
    await request(groupPrefs,alice.cookie,{pinned:false});
    assert.equal((await request('conversations',alice.cookie).then(r=>r.json())).conversations[0].id,id);
    await request(prefs,alice.cookie,{pinned:true}); await request(groupPrefs,alice.cookie,{hidden:true});
    assert.equal((await request('conversations',alice.cookie).then(r=>r.json())).conversations.some(c=>c.id===groupId),false);
    assert.equal((await request('conversations',bob.cookie).then(r=>r.json())).conversations.some(c=>c.id===groupId),true);
    assert.equal((await request(groupPath,bob.cookie).then(r=>r.json())).messages.length,3,'deleting does not destroy messages');
    controllers.forEach(c=>c.abort()); await stop(); await start();
    personalRooms=(await request('conversations',alice.cookie).then(r=>r.json())).conversations;
    assert.equal(personalRooms.some(c=>c.id===groupId),false); assert.ok(personalRooms.find(c=>c.id===id).pinned_at,'pin survives restart');
    await request(groupPath,eve.cookie,{text:'group appears again',clientId:randomUUID()});
    const reappeared=(await request('conversations',alice.cookie).then(r=>r.json())).conversations.find(c=>c.id===groupId);
    assert.ok(reappeared); assert.equal(reappeared.pinned_at,null,'deleting clears the pin');
    await request(prefs,alice.cookie,{hidden:true});
    assert.equal((await request('conversations',alice.cookie).then(r=>r.json())).conversations.some(c=>c.id===id),false);
    await request('conversations',alice.cookie,{userId:bob.user.id});
    assert.equal((await request('conversations',alice.cookie).then(r=>r.json())).conversations.some(c=>c.id===id),true,'starting direct chat restores hidden room');
    const integrity=new DatabaseSync(join(dir,'chat.sqlite')); assert.equal(integrity.prepare('PRAGMA foreign_key_check').all().length,0); integrity.close();
  } finally { controllers.forEach(c => c.abort()); if (child && child.exitCode === null) await stop(); await rm(dir, { recursive: true, force: true }); }
});
