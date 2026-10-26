import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  rm,
  readdir,
  readFile,
  writeFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createLocalFileStore } from "../file-store.mjs";
test(
  "private streamed attachments, retries, block rechecks and portable exports",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pingo-files-")),
      dbPath = join(dir, "db.sqlite"),
      uploads = join(dir, "uploads");
    const port = 30000 + Math.floor(Math.random() * 3000),
      base = `http://127.0.0.1:${port}`;
    let child;
    async function start() {
      child = spawn(process.execPath, ["server.mjs"], {
        cwd: new URL("../", import.meta.url),
        env: {
          ...process.env,
          PORT: String(port),
          PINGO_DB_PATH: dbPath,
          PINGO_UPLOAD_DIR: uploads,
        },
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
      const ended = once(child, "exit");
      child.kill();
      await ended;
    }
    async function req(path, cookie, data) {
      return fetch(base + "/api/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    }
    async function signup(name) {
      const r = await req("signup", null, {
        name,
        email: name + "@example.com",
        password: "test-password-12345",
      });
      return {
        user: (await r.json()).user,
        cookie: r.headers.get("set-cookie").split(";")[0],
      };
    }
    async function upload(
      room,
      person,
      name,
      content,
      clientId = randomUUID(),
      extra = {},
    ) {
      return fetch(base + `/api/conversations/${room}/files`, {
        method: "POST",
        headers: {
          ...(person ? { Cookie: person.cookie } : {}),
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeURIComponent(name),
          "X-Client-Id": clientId,
        },
        body: content,
        ...extra,
      });
    }
    async function files() {
      return (await readdir(uploads).catch(() => [])).filter(
        (x) => !x.startsWith("."),
      );
    }
    try {
      await start();
      const a = await signup("alice"),
        b = await signup("bobby"),
        c = await signup("carol");
      const room = (
        await req("conversations", a.cookie, { userId: b.user.id }).then((r) =>
          r.json(),
        )
      ).conversation.id;
      const data = Buffer.from("파일 공유 테스트 💙 O'Brien \\ example"),
        name = "공유 '메모'.txt",
        clientId = randomUUID();
      const first = await upload(room, a, name, data, clientId);
      assert.equal(first.status, 201);
      const message = (await first.json()).message,
        file = message.attachment;
      assert.equal(file.size, data.length);
      assert.equal(
        file.sha256,
        createHash("sha256").update(data).digest("hex"),
      );
      assert.equal(file.storage_key, undefined);
      const dl = await req("files/" + file.id, b.cookie);
      assert.equal(dl.status, 200);
      assert.deepEqual(Buffer.from(await dl.arrayBuffer()), data);
      assert.match(dl.headers.get("content-disposition"), /attachment;/);
      assert.match(dl.headers.get("content-disposition"), /UTF-8''/);
      assert.equal(dl.headers.get("content-type"), "application/octet-stream");
      assert.equal(dl.headers.get("x-content-type-options"), "nosniff");
      const head = await fetch(base + "/api/files/" + file.id, {
        method: "HEAD",
        headers: { Cookie: b.cookie },
      });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get("content-length"), String(data.length));
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      assert.equal((await req("files/" + file.id)).status, 401);
      assert.equal((await req("files/" + file.id, c.cookie)).status, 404);
      assert.equal((await upload(room, c, "intrusion.txt", data)).status, 404);
      assert.equal(
        (await fetch(base + "/.data/uploads/" + file.id)).status,
        404,
      );
      const again = await upload(room, a, name, data, clientId);
      assert.equal(again.status, 200);
      assert.equal((await again.json()).message.id, message.id);
      assert.equal((await files()).length, 1);
      assert.equal(
        (await upload(room, a, name, Buffer.from("different"), clientId))
          .status,
        409,
      );
      assert.equal((await files()).length, 1);
      for (const [n, bytes, status] of [
        ["bad.exe", Buffer.from("MZ"), 415],
        ["../../bad.txt", data, 400],
        ["fake.pdf", data, 415],
        ["run.txt", Buffer.from("MZfake-exe"), 415],
        ["empty.txt", Buffer.alloc(0), 400],
        ["bad.txt", Buffer.from([255]), 415],
      ])
        assert.equal((await upload(room, a, n, bytes)).status, status, n);
      const big = Readable.from(
        (async function* () {
          for (let i = 0; i < 21; i++) yield Buffer.alloc(1024 ** 2, 65);
        })(),
      );
      assert.equal(
        (
          await upload(room, a, "large.txt", big, randomUUID(), {
            duplex: "half",
          })
        ).status,
        413,
      );
      assert.equal((await files()).length, 1);
      assert.equal(
        (
          await req(`conversations/${room}/messages`, b.cookie).then((r) =>
            r.json(),
          )
        ).messages[0].attachment.id,
        file.id,
      );
      await req("blocks", a.cookie, { userId: b.user.id });
      assert.equal((await upload(room, b, "blocked.txt", data)).status, 403);
      assert.equal((await req("files/" + file.id, b.cookie)).status, 200);
      await req("blocks/remove", a.cookie, { userId: b.user.id });
      let release;
      const gate = new Promise((r) => (release = r));
      const slow = Readable.from(
        (async function* () {
          yield Buffer.from("first");
          await gate;
          yield Buffer.from("last");
        })(),
      );
      const inFlight = upload(room, a, "in-flight.txt", slow, randomUUID(), {
        duplex: "half",
      });
      for (let i = 0; i < 100; i++) {
        if ((await readdir(uploads)).some((x) => x.startsWith(".upload-")))
          break;
        await new Promise((r) => setTimeout(r, 10));
      }
      await req("blocks", b.cookie, { userId: a.user.id });
      release();
      assert.equal(
        (await inFlight).status,
        403,
        "a block during streaming prevents publication",
      );
      await req("blocks/remove", b.cookie, { userId: a.user.id });
      assert.equal((await files()).length, 1);
      const quota = new DatabaseSync(dbPath);
      quota
        .prepare("UPDATE attachments SET size=? WHERE id=?")
        .run(200 * 1024 ** 2, file.id);
      assert.equal((await upload(room, a, "quota.txt", data)).status, 413);
      quota
        .prepare("UPDATE attachments SET size=? WHERE id=?")
        .run(data.length, file.id);
      quota.close();
      assert.equal((await files()).length, 1);
      const env = {
          ...process.env,
          PINGO_DB_PATH: dbPath,
          PINGO_UPLOAD_DIR: uploads,
        },
        output = join(dir, "export");
      const exported = spawnSync(
        process.execPath,
        ["tools/export-data.mjs", output],
        { cwd: new URL("../", import.meta.url), env, encoding: "utf8" },
      );
      assert.equal(exported.status, 0, exported.stderr);
      const manifest = JSON.parse(
        await readFile(join(output, "manifest.json"), "utf8"),
      );
      assert.ok(manifest.omitted_data_tables.includes("sessions"));
      assert.equal(manifest.files.length, 1);
      assert.equal(manifest.files[0].attachment_id, file.id);
      assert.deepEqual(
        await readFile(join(output, "files", manifest.files[0].storage_key)),
        data,
      );
      const rows = (
        await readFile(join(output, "tables", "attachments.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(rows[0].id, file.id);
      const sql = await readFile(join(output, "postgres.sql"), "utf8");
      assert.match(sql, /GENERATED BY DEFAULT AS IDENTITY/);
      assert.match(sql, /FOREIGN KEY/);
      assert.match(sql, /CHECK/);
      assert.match(sql, /COMMIT;/);
      assert.ok(sql.includes('CREATE TABLE "sessions"'));
      assert.equal(
        manifest.tables.find((table) => table.name === "sessions").count,
        0,
      );
      assert.equal(
        spawnSync(process.execPath, ["tools/export-data.mjs", output], {
          cwd: new URL("../", import.meta.url),
          env,
          encoding: "utf8",
        }).status,
        1,
        "existing export is never overwritten",
      );
      assert.deepEqual(
        await readFile(join(output, "files", manifest.files[0].storage_key)),
        data,
      );
      const storedPath = join(uploads, manifest.files[0].storage_key),
        badOutput = join(dir, "bad-export");
      await writeFile(storedPath, Buffer.from("corrupted"));
      const failedExport = spawnSync(
        process.execPath,
        ["tools/export-data.mjs", badOutput],
        { cwd: new URL("../", import.meta.url), env, encoding: "utf8" },
      );
      assert.equal(failedExport.status, 1);
      assert.match(failedExport.stderr, /checksum mismatch/);
      await assert.rejects(stat(badOutput), { code: "ENOENT" });
      await writeFile(storedPath, data);
      await stop();
      await start();
      assert.deepEqual(
        Buffer.from(
          await req("files/" + file.id, b.cookie).then((r) => r.arrayBuffer()),
        ),
        data,
      );
    } finally {
      if (child && child.exitCode === null) await stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('interrupted storage streams clean temporary files and reject unsafe keys',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pingo-storage-abort-'));
 try{
  const storage=createLocalFileStore(dir);
  const source=Readable.from((async function*(){yield Buffer.from('partial');throw Error('cancelled');})());
  await assert.rejects(storage.put(source,{name:'interrupted.txt'}),/cancelled/);
  assert.deepEqual(await readdir(dir),[]);
  await assert.rejects(storage.open('../escape'));
  await assert.rejects(storage.remove('../escape'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
