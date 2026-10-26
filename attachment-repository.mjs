// Only this adapter knows SQLite. Public message/file IDs and storage keys are portable.
export function createAttachmentRepository(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS attachments(
    id TEXT PRIMARY KEY,message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
    storage_key TEXT NOT NULL UNIQUE,name TEXT NOT NULL,size INTEGER NOT NULL,
    mime TEXT NOT NULL,sha256 TEXT NOT NULL,created_at INTEGER NOT NULL
  );`);
  function attachment(row) {
    return row
      ? {
          id: row.id,
          name: row.name,
          size: row.size,
          mime: row.mime,
          sha256: row.sha256,
        }
      : null;
  }
  function decorate(message) {
    if (!message) return message;
    const file = db
      .prepare("SELECT * FROM attachments WHERE message_id=?")
      .get(message.id);
    return file ? { ...message, attachment: attachment(file) } : message;
  }
  return {
    async decorateMany(messages) {
      return messages.map(decorate);
    },
    async decorateMessage(message) {
      return decorate(message);
    },
    async find(id) {
      return db
        .prepare(
          `SELECT a.*,m.conversation_id,m.sender_id FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.id=?`,
        )
        .get(id);
    },
    async publish({ id, userId, conversationId, clientId, file, name }) {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const existing = db
          .prepare("SELECT * FROM messages WHERE sender_id=? AND client_id=?")
          .get(userId, clientId);
        if (existing) {
          const old = db
            .prepare("SELECT * FROM attachments WHERE message_id=?")
            .get(existing.id);
          if (
            existing.conversation_id !== conversationId ||
            !old ||
            old.name !== name ||
            old.sha256 !== file.sha256 ||
            old.size !== file.size
          )
            throw Object.assign(
              Error("전송 ID가 다른 메시지에 사용되었습니다."),
              { status: 409 },
            );
          db.exec("COMMIT;");
          return {
            created: false,
            message: decorate({
              id: existing.id,
              sender_id: existing.sender_id,
              text: existing.text,
              created_at: existing.created_at,
            }),
          };
        }
        const total = db
          .prepare("SELECT COALESCE(sum(size),0) AS n FROM attachments")
          .get().n;
        const own = db
          .prepare(
            "SELECT COALESCE(sum(a.size),0) AS n FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.sender_id=?",
          )
          .get(userId).n;
        if (
          total + file.size > 2 * 1024 ** 3 ||
          own + file.size > 200 * 1024 ** 2
        )
          throw Object.assign(
            Error("파일 저장 한도를 초과했습니다. 운영자에게 문의해 주세요."),
            { status: 413 },
          );
        const now = Date.now(),
          result = db
            .prepare(
              "INSERT INTO messages(conversation_id,sender_id,client_id,text,created_at) VALUES(?,?,?,?,?)",
            )
            .run(conversationId, userId, clientId, "📎 " + name, now);
        const messageId = Number(result.lastInsertRowid);
        db.prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?)").run(
          id,
          messageId,
          file.key,
          name,
          file.size,
          file.mime,
          file.sha256,
          now,
        );
        db.prepare(
          "UPDATE conversation_preferences SET hidden=0 WHERE conversation_id=?",
        ).run(conversationId);
        db.exec("COMMIT;");
        return {
          created: true,
          message: decorate({
            id: messageId,
            sender_id: userId,
            text: "📎 " + name,
            created_at: now,
          }),
        };
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
    },
  };
}
