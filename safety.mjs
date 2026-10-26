import { randomBytes } from "node:crypto";
export function createSafety(db, { json, body, userFor, notify }) {
  db.exec(`CREATE TABLE IF NOT EXISTS blocks (
    owner_id TEXT NOT NULL REFERENCES users(id), blocked_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL, PRIMARY KEY(owner_id,blocked_id), CHECK(owner_id<>blocked_id));
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES users(id), reported_id TEXT NOT NULL REFERENCES users(id),
      conversation_id TEXT REFERENCES conversations(id), message_id INTEGER REFERENCES messages(id),
      reason TEXT NOT NULL, details TEXT NOT NULL, evidence TEXT,
      created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')),
      reviewed_at INTEGER, review_note TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS reports_open_unique ON reports(reporter_id,reported_id,COALESCE(message_id,0)) WHERE status='open';`);
  const reasons = ["spam", "harassment", "abuse", "illegal", "other"];
  function blocked(a, b) {
    return !!db
      .prepare(
        "SELECT 1 FROM blocks WHERE (owner_id=? AND blocked_id=?) OR (owner_id=? AND blocked_id=?)",
      )
      .get(a, b, b, a);
  }
  async function route(req, res, path) {
    if (!["/api/blocks", "/api/blocks/remove", "/api/reports"].includes(path))
      return false;
    const user = userFor(req);
    if (!user) {
      json(res, 401, { error: "로그인이 필요합니다." });
      return true;
    }
    if (path === "/api/blocks" && req.method === "GET") {
      json(res, 200, {
        blocks: db
          .prepare(
            "SELECT u.id,u.name,b.created_at FROM blocks b JOIN users u ON u.id=b.blocked_id WHERE b.owner_id=? ORDER BY b.created_at DESC",
          )
          .all(user.id),
      });
      return true;
    }
    if (
      ["/api/blocks", "/api/blocks/remove"].includes(path) &&
      req.method === "POST"
    ) {
      const data = await body(req);
      if (
        typeof data.userId !== "string" ||
        data.userId === user.id ||
        !db.prepare("SELECT id FROM users WHERE id=?").get(data.userId)
      ) {
        json(res, 400, { error: "차단할 사용자를 선택해 주세요." });
        return true;
      }
      if (path.endsWith("/remove"))
        db.prepare("DELETE FROM blocks WHERE owner_id=? AND blocked_id=?").run(
          user.id,
          data.userId,
        );
      else {
        db.exec("BEGIN IMMEDIATE;");
        try {
          db.prepare("INSERT OR IGNORE INTO blocks VALUES(?,?,?)").run(
            user.id,
            data.userId,
            Date.now(),
          );
          db.prepare(
            "DELETE FROM friends WHERE owner_id=? AND friend_id=?",
          ).run(user.id, data.userId);
          db.exec("COMMIT;");
        } catch (error) {
          db.exec("ROLLBACK;");
          throw error;
        }
      }
      notify([user.id, data.userId]);
      json(res, 200, { ok: true });
      return true;
    }
    if (path === "/api/reports" && req.method === "GET") {
      const reports = db
        .prepare(
          `SELECT r.id,u.name AS reported_name,r.reason,r.status,r.created_at FROM reports r JOIN users u ON u.id=r.reported_id WHERE reporter_id=? ORDER BY created_at DESC LIMIT 100`,
        )
        .all(user.id);
      json(res, 200, { reports });
      return true;
    }
    if (path === "/api/reports" && req.method === "POST") {
      const data = await body(req);
      let target = data.userId,
        conversationId = null,
        messageId = null,
        evidence = null;
      if (data.messageId !== undefined) {
        if (!Number.isSafeInteger(data.messageId) || data.messageId < 1) {
          json(res, 400, { error: "올바른 메시지를 선택해 주세요." });
          return true;
        }
        const message = db
          .prepare(
            `SELECT msg.* FROM messages msg JOIN conversation_members m ON m.conversation_id=msg.conversation_id WHERE msg.id=? AND m.user_id=?`,
          )
          .get(data.messageId, user.id);
        if (!message) {
          json(res, 404, { error: "메시지를 찾을 수 없습니다." });
          return true;
        }
        if (target !== undefined && target !== message.sender_id) {
          json(res, 400, { error: "메시지 작성자가 일치하지 않습니다." });
          return true;
        }
        target = message.sender_id;
        conversationId = message.conversation_id;
        messageId = message.id;
        evidence = message.text;
      }
      const details =
        typeof data.details === "string" ? data.details.trim() : "";
      if (
        typeof target !== "string" ||
        target === user.id ||
        !db.prepare("SELECT id FROM users WHERE id=?").get(target) ||
        !reasons.includes(data.reason) ||
        details.length > 2000
      ) {
        json(res, 400, {
          error: "신고 대상과 사유를 확인해 주세요. 설명은 2000자 이내입니다.",
        });
        return true;
      }
      const existing = db
        .prepare(
          "SELECT id,status FROM reports WHERE reporter_id=? AND reported_id=? AND COALESCE(message_id,0)=? AND status='open'",
        )
        .get(user.id, target, messageId || 0);
      if (existing) {
        json(res, 200, { report: existing });
        return true;
      }
      const count = db
        .prepare(
          "SELECT count(*) AS n FROM reports WHERE reporter_id=? AND created_at>?",
        )
        .get(user.id, Date.now() - 3600000).n;
      if (count >= 20) {
        res.setHeader("Retry-After", "3600");
        json(res, 429, {
          error: "신고는 한 시간에 20건까지 접수할 수 있습니다.",
        });
        return true;
      }
      const id = randomBytes(16).toString("hex");
      db.prepare(
        "INSERT INTO reports(id,reporter_id,reported_id,conversation_id,message_id,reason,details,evidence,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        user.id,
        target,
        conversationId,
        messageId,
        data.reason,
        details,
        evidence,
        Date.now(),
      );
      json(res, 201, { report: { id, status: "open" } });
      return true;
    }
    json(res, 404, { error: "요청을 찾을 수 없습니다." });
    return true;
  }
  return { route, blocked };
}
