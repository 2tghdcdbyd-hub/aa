import { randomBytes, timingSafeEqual } from "node:crypto";
export function createRecovery(
  db,
  { json, body, userFor, scrypt, hash, limited, revokeUser },
) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS recovery_codes(user_id TEXT PRIMARY KEY REFERENCES users(id),code_hash TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL);",
  );
  function issue(userId) {
    const code = randomBytes(32).toString("hex");
    db.prepare(
      "INSERT INTO recovery_codes VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash,created_at=excluded.created_at",
    ).run(userId, hash(code), Date.now());
    return code;
  }
  async function route(req, res, path) {
    if (!["/api/recovery-code", "/api/recover"].includes(path)) return false;
    if (req.method !== "POST") {
      json(res, 405, { error: "POST 요청이 필요합니다." });
      return true;
    }
    if (limited(req)) {
      res.setHeader("Retry-After", "900");
      json(res, 429, {
        error: "시도가 너무 많습니다. 15분 후 다시 시도해 주세요.",
      });
      return true;
    }
    const data = await body(req);
    if (path === "/api/recovery-code") {
      const user = userFor(req);
      if (!user) {
        json(res, 401, { error: "로그인이 필요합니다." });
        return true;
      }
      if (
        typeof data.password !== "string" ||
        data.password.length < 10 ||
        data.password.length > 128
      ) {
        json(res, 400, { error: "현재 비밀번호를 확인해 주세요." });
        return true;
      }
      const derived = (await scrypt(data.password, user.salt, 64)).toString(
        "hex",
      );
      // Recheck after asynchronous hashing so a concurrent reset cannot issue a fresh code.
      const fresh = userFor(req);
      if (
        !fresh ||
        fresh.id !== user.id ||
        fresh.password_hash !== user.password_hash ||
        !hashEqual(derived, user.password_hash)
      ) {
        json(res, 400, { error: "현재 비밀번호를 확인해 주세요." });
        return true;
      }
      json(res, 200, { recoveryCode: issue(user.id) });
      return true;
    }
    const email =
      typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
    const code = typeof data.code === "string" ? data.code.trim() : "";
    const password = typeof data.password === "string" ? data.password : "";
    if (password.length < 10 || password.length > 128) {
      json(res, 400, { error: "새 비밀번호는 10~128자로 입력해 주세요." });
      return true;
    }
    const user = db
      .prepare(
        "SELECT u.id,r.code_hash FROM users u JOIN recovery_codes r ON r.user_id=u.id WHERE u.email=?",
      )
      .get(email);
    if (!user || code.length !== 64 || !hashEqual(hash(code), user.code_hash)) {
      json(res, 400, {
        error: "이메일 또는 복구 코드가 올바르지 않거나 이미 사용되었습니다.",
      });
      return true;
    }
    const salt = randomBytes(16).toString("hex"),
      passwordHash = (await scrypt(password, salt, 64)).toString("hex");
    db.exec("BEGIN IMMEDIATE;");
    try {
      const consumed = db
        .prepare("DELETE FROM recovery_codes WHERE user_id=? AND code_hash=?")
        .run(user.id, user.code_hash);
      if (!consumed.changes) {
        db.exec("ROLLBACK;");
        json(res, 400, {
          error: "이메일 또는 복구 코드가 올바르지 않거나 이미 사용되었습니다.",
        });
        return true;
      }
      db.prepare("UPDATE users SET salt=?,password_hash=? WHERE id=?").run(
        salt,
        passwordHash,
        user.id,
      );
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
    revokeUser(user.id);
    json(res, 200, { ok: true });
    return true;
  }
  return { route, issue };
}
function hashEqual(a, b) {
  const left = Buffer.from(a, "hex"),
    right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
