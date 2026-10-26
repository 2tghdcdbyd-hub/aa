import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { safeText, width, clip, wrap } from "../moderation-format.mjs";

test("terminal rendering, filters, pagination, short IDs and review safety", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pingo-moderation-")),
    path = join(dir, "test.sqlite");
  const first = "aaaaaaaa0".padEnd(32, "0"),
    second = "aaaaaaaa1".padEnd(32, "1"),
    third = "bbbbbbbb".padEnd(32, "2");
  const evidence = "첫 줄\n둘째 줄 💙\u001b[31m위험 제어문자\u0007\u202e";
  const db = new DatabaseSync(path);
  db.exec(
    `CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT);CREATE TABLE reports(id TEXT PRIMARY KEY,reporter_id TEXT,reported_id TEXT,conversation_id TEXT,message_id INTEGER,reason TEXT,details TEXT,evidence TEXT,created_at INTEGER,status TEXT,reviewed_at INTEGER,review_note TEXT);INSERT INTO users VALUES('alice','신고자 하나'),('bob','민준💙'),('carol','사용자 ESC');`,
  );
  const insert = db.prepare(
    "INSERT INTO reports VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  insert.run(
    first,
    "alice",
    "bob",
    "room",
    5,
    "spam",
    "광고 메시지가 반복돼요. 긴 설명 ".repeat(8),
    evidence,
    Date.UTC(2026, 9, 26, 0, 0),
    "open",
    null,
    null,
  );
  insert.run(
    second,
    "bob",
    "carol",
    null,
    null,
    "abuse",
    "욕설 신고",
    null,
    Date.UTC(2026, 9, 26, 1, 0),
    "resolved",
    Date.UTC(2026, 9, 26, 2, 0),
    "확인 완료",
  );
  insert.run(
    third,
    "carol",
    "bob",
    null,
    null,
    "other",
    "문자 그대로 % 검색",
    null,
    Date.UTC(2026, 9, 26, 3, 0),
    "open",
    null,
    null,
  );
  const targetId = "0123456789abcdef0123456789abcdef";
  db.prepare("UPDATE users SET id=? WHERE id='bob'").run(targetId);
  db.prepare("UPDATE reports SET reported_id=? WHERE reported_id='bob'").run(
    targetId,
  );
  db.prepare("UPDATE reports SET reporter_id=? WHERE reporter_id='bob'").run(
    targetId,
  );
  db.close();
  function run(args, dbPath = path) {
    return spawnSync(process.execPath, ["moderation.mjs", ...args], {
      cwd: new URL("../", import.meta.url),
      env: { ...process.env, PINGO_DB_PATH: dbPath },
      encoding: "utf8",
    });
  }
  try {
    const list = run(["list", "--width", "100"]);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /검토 대기 2건/);
    assert.match(list.stdout, /처리 완료 1건/);
    assert.match(list.stdout, /신고자/);
    assert.match(list.stdout, /대상 ID/);
    assert.ok(list.stdout.includes(targetId.slice(0, 12)));
    assert.ok(list.stdout.includes(targetId.slice(12, 24)));
    assert.ok(list.stdout.includes(targetId.slice(24)));
    const wide = run(["list", "--width", "200"]);
    assert.ok(wide.stdout.includes(targetId), "full ID shown in wide table");
    assert.match(list.stdout, /민준💙/);
    assert.match(list.stdout, /2026-10-26 09:00/);
    assert.match(list.stdout, /…/);
    for (const line of list.stdout
      .split("\n")
      .filter((line) => line.includes("│")))
      assert.ok(width(line) <= 100, line);
    const narrow = run(["list", "--width", "60"]);
    assert.equal(narrow.status, 0);
    assert.ok(!narrow.stdout.includes("│"));
    assert.match(narrow.stdout, /→/);
    assert.ok(
      narrow.stdout.includes(targetId),
      "narrow card retains full target ID",
    );
    const filtered = run([
      "list",
      "--status",
      "open",
      "--reason",
      "spam",
      "--search",
      "광고",
      "--json",
    ]);
    assert.deepEqual(
      JSON.parse(filtered.stdout).map((r) => r.id),
      [first],
    );
    assert.equal(
      JSON.parse(run(["list", "--search", "%", "--json"]).stdout)[0].id,
      third,
    );
    const page1 = JSON.parse(
        run(["list", "--page", "1", "--limit", "1", "--json"]).stdout,
      ),
      page2 = JSON.parse(
        run(["list", "--page", "2", "--limit", "1", "--json"]).stdout,
      );
    assert.equal(page1[0].id, third);
    assert.equal(page2[0].id, first);
    assert.match(
      run(["list", "--page", "20"]).stdout,
      /이 페이지에 신고가 없습니다/,
    );
    assert.match(
      run(["list", "--search", "없는 검색"]).stdout,
      /조건에 맞는 신고가 없습니다/,
    );
    for (const args of [
      ["list", "--limit", "0"],
      ["list", "--page", "-1"],
      ["list", "--width", "59"],
      ["list", "--status", "bad"],
      ["list", "--reason", "bad"],
      ["list", "--search"],
      ["show", "not-an-id"],
    ])
      assert.equal(run(args).status, 1, args.join(" "));
    assert.equal(
      run(["show", "aaaaaaaa"]).status,
      1,
      "ambiguous prefix rejected",
    );
    const detail = run(["show", "aaaaaaaa0", "--width", "60"]);
    assert.equal(detail.status, 0, detail.stderr);
    assert.match(detail.stdout, /메시지 증거/);
    assert.match(detail.stdout, /둘째 줄 💙/);
    assert.match(detail.stdout, /\\u001b/);
    assert.match(detail.stdout, /\\u0007/);
    assert.match(detail.stdout, /\\u202e/);
    assert.ok(!detail.stdout.includes("\u001b"));
    assert.ok(!detail.stdout.includes("\u202e"));
    assert.equal(
      JSON.parse(run(["show", first, "--json"]).stdout).evidence,
      evidence,
      "JSON preserves raw data",
    );
    assert.equal(
      run(["resolve", "aaaaaaaa", "검토"]).status,
      1,
      "ambiguous ID cannot be updated",
    );
    assert.equal(run(["resolve", "aaaaaaaa0", "확인 후 처리"]).status, 0);
    assert.equal(run(["resolve", "aaaaaaaa0", "중복"]).status, 1);
    const reviewed = JSON.parse(run(["show", first, "--json"]).stdout);
    assert.equal(reviewed.status, "resolved");
    assert.equal(reviewed.review_note, "확인 후 처리");
    assert.equal(run(["dismiss", "bbbbbbbb", "기타 종결"]).status, 0);
    assert.equal(run(["--help"], join(dir, "missing.sqlite")).status, 0);
    assert.equal(run(["list"], join(dir, "missing.sqlite")).status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CJK and emoji widths, wrapping and terminal control escaping", () => {
  assert.equal(width("한글"), 4);
  assert.equal(width("A💙"), 3);
  assert.equal(width("👨‍👩‍👧‍👦"), 2);
  assert.ok(width(clip("긴 한글 이름 💙", 8)) <= 8);
  assert.ok(
    wrap("한글과 이모지 💙".repeat(10), 20).every((line) => width(line) <= 20),
  );
  assert.equal(safeText("a\nb"), "a ↵ b");
  assert.equal(safeText("a\nb", true), "a\nb");
  assert.ok(!safeText("\x1b]52;clipboard\x07").includes("\x1b"));
});
