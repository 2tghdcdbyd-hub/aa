import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
test(
  "recovery single-use/races, session revocation, blocking and report review",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pingo-safety-")),
      dbPath = join(dir, "db.sqlite");
    const port = 20000 + Math.floor(Math.random() * 10000),
      base = `http://127.0.0.1:${port}`;
    let child;
    const password = "test-password-12345";
    async function start() {
      child = spawn(process.execPath, ["server.mjs"], {
        cwd: new URL("../", import.meta.url),
        env: { ...process.env, PORT: String(port), PINGO_DB_PATH: dbPath },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let ready = false;
      child.stdout.on("data", () => (ready = true));
      for (let i = 0; i < 100 && !ready; i++) {
        if (child.exitCode !== null) throw Error("Server failed");
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.ok(ready);
    }
    async function stop() {
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }
    async function req(path, person, data) {
      return fetch(base + "/api/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          ...(person
            ? { Cookie: typeof person === "string" ? person : person.cookie }
            : {}),
          ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    }
    async function signup(name) {
      const response = await req("signup", null, {
        name,
        email: name + "@example.com",
        password,
      });
      assert.equal(response.status, 201);
      const value = await response.json();
      return {
        ...value,
        cookie: response.headers.get("set-cookie").split(";")[0],
        email: name + "@example.com",
      };
    }
    async function send(id, person, text) {
      return req(`conversations/${id}/messages`, person, {
        text,
        clientId: randomUUID(),
      });
    }
    try {
      await start();
      const a = await signup("alice"),
        b = await signup("bobby"),
        c = await signup("carol");
      assert.equal(a.recoveryCode.length, 64);
      const db = new DatabaseSync(dbPath);
      assert.notEqual(
        db
          .prepare("SELECT code_hash FROM recovery_codes WHERE user_id=?")
          .get(a.user.id).code_hash,
        a.recoveryCode,
      );
      db.close();
      assert.equal(
        (await req("recovery-code", null, { password })).status,
        401,
      );
      assert.equal(
        (await req("recovery-code", a, { password: "wrong-password" })).status,
        400,
      );
      const rotated = await req("recovery-code", a, { password }).then((r) =>
        r.json(),
      );
      assert.equal(rotated.recoveryCode.length, 64);
      assert.equal(
        (
          await req("recover", null, {
            email: a.email,
            code: a.recoveryCode,
            password: "new-password-12345",
          })
        ).status,
        400,
      );
      const extra = await req("login", null, { email: a.email, password });
      const oldCookie = extra.headers.get("set-cookie").split(";")[0];
      const attempts = await Promise.all(
        [1, 2].map(() =>
          req("recover", null, {
            email: a.email,
            code: rotated.recoveryCode,
            password: "new-password-12345",
          }),
        ),
      );
      assert.deepEqual(
        attempts.map((r) => r.status).sort(),
        [200, 400],
        "a recovery code is consumed atomically",
      );
      assert.equal((await req("me", a)).status, 401);
      assert.equal((await req("me", oldCookie)).status, 401);
      assert.equal(
        (
          await req("recover", null, {
            email: a.email,
            code: rotated.recoveryCode,
            password: "another-password",
          })
        ).status,
        400,
      );
      assert.equal(
        (await req("login", null, { email: a.email, password })).status,
        401,
      );
      const login = await req("login", null, {
        email: a.email,
        password: "new-password-12345",
      });
      assert.equal(login.status, 200);
      a.cookie = login.headers.get("set-cookie").split(";")[0];
      assert.equal((await req("blocks")).status, 401);
      assert.equal((await req("reports")).status, 401);
      const direct = (
        await req("conversations", a, { userId: b.user.id }).then((r) =>
          r.json(),
        )
      ).conversation.id;
      const group = (
        await req("conversations", c, {
          kind: "group",
          title: "safety room",
          userIds: [a.user.id, b.user.id],
        }).then((r) => r.json())
      ).conversation.id;
      const fromB = await send(direct, b, "server evidence <script>");
      const message = (await fromB.json()).message;
      await req("friends", a, { userId: b.user.id });
      await req("friends", b, { userId: a.user.id });
      assert.equal((await req("blocks", a, { userId: a.user.id })).status, 400);
      assert.equal(
        (await req("blocks", a, { userId: b.user.id, owner_id: c.user.id }))
          .status,
        200,
      );
      assert.equal((await req("blocks", a, { userId: b.user.id })).status, 200);
      assert.equal(
        (await req("blocks", a).then((r) => r.json())).blocks.length,
        1,
      );
      assert.equal(
        (await req("blocks", b).then((r) => r.json())).blocks.length,
        0,
      );
      assert.equal(
        (await req("friends", a).then((r) => r.json())).friends.length,
        0,
      );
      assert.equal(
        (await req("friends", b).then((r) => r.json())).friends.length,
        1,
      );
      for (const person of [a, b]) {
        assert.equal(
          (await send(direct, person, "blocked direct")).status,
          403,
        );
        assert.equal((await send(group, person, "blocked group")).status, 403);
      }
      assert.equal(
        (await send(group, c, "unrelated participant can send")).status,
        201,
      );
      assert.equal(
        (await req("conversations", b, { userId: a.user.id })).status,
        403,
      );
      assert.equal(
        (await req("friends", b, { userId: a.user.id })).status,
        403,
      );
      assert.equal(
        (
          await req("conversations", c, {
            kind: "group",
            title: "bypass attempt",
            userIds: [a.user.id, b.user.id],
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await req("conversations", a).then((r) => r.json())
        ).conversations.find((x) => x.id === direct).send_restricted,
        true,
      );
      await req("blocks/remove", b, { userId: a.user.id });
      assert.equal((await send(direct, b, "still blocked")).status, 403);
      assert.equal(
        (await req("reports", c, { messageId: message.id, reason: "spam" }))
          .status,
        404,
      );
      assert.equal(
        (await req("reports", b, { messageId: message.id, reason: "spam" }))
          .status,
        400,
      );
      assert.equal(
        (
          await req("reports", a, {
            messageId: message.id,
            userId: c.user.id,
            reason: "spam",
          })
        ).status,
        400,
      );
      assert.equal(
        (await req("reports", a, { userId: b.user.id, reason: "invalid" }))
          .status,
        400,
      );
      const reportResponse = await req("reports", a, {
        messageId: message.id,
        userId: b.user.id,
        reason: "harassment",
        details: "review this",
        evidence: "forged",
        reporter_id: c.user.id,
      });
      assert.equal(reportResponse.status, 201);
      const report = (await reportResponse.json()).report;
      assert.equal(
        (
          await req("reports", a, {
            messageId: message.id,
            reason: "harassment",
          })
        ).status,
        200,
      );
      assert.equal(
        (await req("reports", b).then((r) => r.json())).reports.length,
        0,
      );
      const evidenceDb = new DatabaseSync(dbPath),
        saved = evidenceDb
          .prepare("SELECT * FROM reports WHERE id=?")
          .get(report.id);
      assert.equal(saved.evidence, message.text);
      assert.equal(saved.reporter_id, a.user.id);
      evidenceDb.close();
      const reviewed = spawnSync(
        process.execPath,
        [
          "moderation.mjs",
          "resolve",
          report.id,
          "Reviewed in integration test",
        ],
        {
          cwd: new URL("../", import.meta.url),
          env: { ...process.env, PINGO_DB_PATH: dbPath },
          encoding: "utf8",
        },
      );
      assert.equal(reviewed.status, 0, reviewed.stderr);
      assert.equal(
        (await req("reports", a).then((r) => r.json())).reports[0].status,
        "resolved",
      );
      await stop();
      await start();
      assert.equal(
        (await req("blocks", a).then((r) => r.json())).blocks[0].id,
        b.user.id,
      );
      assert.equal(
        (await req("reports", a).then((r) => r.json())).reports[0].status,
        "resolved",
      );
      await req("blocks/remove", a, { userId: b.user.id });
      assert.equal((await send(direct, b, "unblocked")).status, 201);
      assert.equal(
        (await req("friends", a).then((r) => r.json())).friends.length,
        0,
      );
      for (let i = 0; i < 19; i++) {
        const next = (
          await send(direct, b, "evidence " + i).then((r) => r.json())
        ).message;
        assert.equal(
          (await req("reports", a, { messageId: next.id, reason: "spam" }))
            .status,
          201,
        );
      }
      const last = (
        await send(direct, b, "rate limited report").then((r) => r.json())
      ).message;
      assert.equal(
        (await req("reports", a, { messageId: last.id, reason: "spam" }))
          .status,
        429,
      );
    } finally {
      if (child && child.exitCode === null) await stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
