import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { MAX_FILE_BYTES, validateFileName } from "./file-store.mjs";
export function createAttachments({
  repository,
  storage,
  userFor,
  json,
  member,
  members,
  blocked,
  notify,
}) {
  const active = new Map(),
    rates = new Map();
  let totalActive = 0;
  function authorize(req, conversationId, owner) {
    const user = userFor(req);
    if (!user || (owner && owner !== user.id))
      throw Object.assign(Error("로그인이 필요합니다."), { status: 401 });
    if (!member(conversationId, user.id))
      throw Object.assign(Error("대화를 찾을 수 없습니다."), { status: 404 });
    if (
      members(conversationId).some(
        (peer) => peer.id !== user.id && blocked(user.id, peer.id),
      )
    )
      throw Object.assign(
        Error("차단 관계인 참여자가 있어 파일을 보낼 수 없습니다."),
        { status: 403 },
      );
    return user;
  }
  async function route(req, res, path) {
    const upload = path.match(/^\/api\/conversations\/([a-f0-9]{32})\/files$/),
      download = path.match(/^\/api\/files\/([a-f0-9]{32})$/);
    if (!upload && !download) return false;
    const user = userFor(req);
    if (!user) {
      json(res, 401, { error: "로그인이 필요합니다." });
      return true;
    }
    if (upload && req.method === "POST") {
      const room = upload[1];
      authorize(req, room);
      let name;
      try {
        name = decodeURIComponent(req.headers["x-file-name"] || "");
      } catch {
        throw Object.assign(Error("파일 이름이 올바르지 않습니다."), {
          status: 400,
        });
      }
      validateFileName(name);
      const clientId = req.headers["x-client-id"];
      if (
        typeof clientId !== "string" ||
        !/^[a-zA-Z0-9-]{16,80}$/.test(clientId)
      )
        throw Object.assign(Error("올바른 전송 ID가 필요합니다."), {
          status: 400,
        });
      if (Number(req.headers["content-length"]) > MAX_FILE_BYTES)
        throw Object.assign(Error("파일은 20MB 이하로 전송해 주세요."), {
          status: 413,
        });
      if ((active.get(user.id) || 0) >= 2 || totalActive >= 8)
        throw Object.assign(
          Error("전송 중인 파일이 많습니다. 잠시 후 다시 시도해 주세요."),
          { status: 429 },
        );
      for (const [key, value] of rates)
        if (value.until < Date.now()) rates.delete(key);
      let rate = rates.get(user.id);
      if (!rate || rate.until < Date.now()) {
        rate = { n: 0, until: Date.now() + 60000 };
        rates.set(user.id, rate);
      }
      if (++rate.n > 20)
        throw Object.assign(Error("파일은 분당 20개까지 전송할 수 있습니다."), {
          status: 429,
        });
      active.set(user.id, (active.get(user.id) || 0) + 1);
      totalActive++;
      let file,
        retained = false;
      try {
        file = await storage.put(req, { name, maxBytes: MAX_FILE_BYTES });
        authorize(req, room, user.id); // Revalidate logout, expired sessions and blocks after the stream.
        const result = await repository.publish({
          id: randomBytes(16).toString("hex"),
          userId: user.id,
          conversationId: room,
          clientId,
          file,
          name,
        });
        retained = result.created;
        if (result.created) notify(members(room).map((peer) => peer.id));
        json(res, result.created ? 201 : 200, { message: result.message });
      } finally {
        try {
          if (file && !retained) await storage.remove(file.key);
        } finally {
          active.set(user.id, Math.max(0, (active.get(user.id) || 1) - 1));
          totalActive--;
        }
      }
      return true;
    }
    if (download && ["GET", "HEAD"].includes(req.method)) {
      const file = await repository.find(download[1]);
      if (!file || !member(file.conversation_id, user.id)) {
        json(res, 404, { error: "파일을 찾을 수 없습니다." });
        return true;
      }
      let opened;
      try {
        opened = await storage.open(file.storage_key);
      } catch {
        json(res, 503, {
          error:
            "파일 저장소에서 파일을 읽을 수 없습니다. 운영자에게 문의해 주세요.",
        });
        return true;
      }
      if (opened.size !== file.size) {
        opened.stream.destroy();
        json(res, 503, { error: "저장된 파일 크기가 일치하지 않습니다." });
        return true;
      }
      const encoded = encodeURIComponent(file.name).replace(
        /['()*]/g,
        (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
      );
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": file.size,
        "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encoded}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      });
      if (req.method === "HEAD") {
        opened.stream.destroy();
        res.end();
      } else
        try {
          await pipeline(opened.stream, res);
        } catch (error) {
          res.destroy(error);
        }
      return true;
    }
    json(res, 405, { error: "지원하지 않는 요청입니다." });
    return true;
  }
  return { route };
}
