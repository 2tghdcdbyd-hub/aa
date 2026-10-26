import { mkdir, open, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const types = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  log: "text/plain",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};
export function validateFileName(name) {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 180 ||
    /[\u0000-\u001f\u007f-\u009f/\\\u202a-\u202e\u2066-\u2069]/u.test(name)
  )
    throw Object.assign(
      Error("파일 이름은 경로·제어문자 없이 180자 이내여야 합니다."),
      { status: 400 },
    );
  const ext = name.split(".").at(-1).toLowerCase();
  if (!Object.hasOwn(types, ext) || !name.includes("."))
    throw Object.assign(
      Error(
        "지원하지 않는 파일 형식입니다. 문서·이미지·ZIP·MP3·MP4 파일을 선택하세요.",
      ),
      { status: 415 },
    );
  return { name, ext, mime: types[ext] };
}
function checkSignature(sample, ext) {
  const hex = sample.toString("hex");
  if (
    sample.subarray(0, 2).toString() === "MZ" ||
    hex.startsWith("7f454c46") ||
    sample.subarray(0, 2).toString() === "#!"
  )
    throw Object.assign(Error("실행 파일은 전송할 수 없습니다."), {
      status: 415,
    });
  const valid =
    ext === "pdf"
      ? sample.subarray(0, 5).toString() === "%PDF-"
      : ext === "png"
        ? hex.startsWith("89504e470d0a1a0a")
        : ["jpg", "jpeg"].includes(ext)
          ? hex.startsWith("ffd8ff")
          : ext === "gif"
            ? /^GIF8[79]a/.test(sample.toString())
            : ext === "webp"
              ? sample.subarray(0, 4).toString() === "RIFF" &&
                sample.subarray(8, 12).toString() === "WEBP"
              : ["zip", "docx", "xlsx", "pptx"].includes(ext)
                ? /^504b(0304|0506|0708)/.test(hex)
                : ext === "mp4"
                  ? sample.subarray(4, 8).toString() === "ftyp"
                  : ext === "mp3"
                    ? sample.subarray(0, 3).toString() === "ID3" ||
                      (sample[0] === 255 && (sample[1] & 224) === 224)
                    : true;
  if (!valid)
    throw Object.assign(Error("파일 내용이 확장자와 일치하지 않습니다."), {
      status: 415,
    });
}
// Storage interface: put(readable,{name,maxBytes}), open(key), remove(key).
// Keys are opaque and relative. An object-storage adapter can implement the same contract.
export function createLocalFileStore(directory) {
  const root = resolve(directory);
  const pathFor = (key) => {
    if (!/^[a-f0-9]{32}$/.test(key)) throw Error("Invalid storage key");
    return join(root, key);
  };
  return {
    async put(readable, { name, maxBytes = MAX_FILE_BYTES }) {
      const policy = validateFileName(name),
        key = randomBytes(16).toString("hex"),
        temp = join(root, ".upload-" + key);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const handle = await open(temp, "wx", 0o600);
      let size = 0,
        sample = Buffer.alloc(0),
        complete = false;
      const digest = createHash("sha256"),
        decoder = ["txt", "md", "csv", "json", "log"].includes(policy.ext)
          ? new TextDecoder("utf-8", { fatal: true })
          : null;
      try {
        for await (const chunk of readable.iterator({
          destroyOnReturn: false,
        })) {
          size += chunk.length;
          if (size > maxBytes)
            throw Object.assign(Error("파일은 20MB 이하로 전송해 주세요."), {
              status: 413,
            });
          if (sample.length < 512)
            sample = Buffer.concat([
              sample,
              chunk.subarray(0, 512 - sample.length),
            ]);
          if (decoder) {
            try {
              const text = decoder.decode(chunk, { stream: true });
              if (text.includes("\0")) throw Error();
            } catch {
              throw Object.assign(
                Error("텍스트 파일은 UTF-8 형식이어야 합니다."),
                { status: 415 },
              );
            }
          }
          digest.update(chunk);
          await handle.writeFile(chunk);
        }
        if (!size)
          throw Object.assign(Error("빈 파일은 전송할 수 없습니다."), {
            status: 400,
          });
        if (decoder) {
          try {
            decoder.decode();
          } catch {
            throw Object.assign(
              Error("텍스트 파일은 UTF-8 형식이어야 합니다."),
              { status: 415 },
            );
          }
        }
        checkSignature(sample, policy.ext);
        await handle.sync();
        await handle.close();
        await rename(temp, pathFor(key));
        complete = true;
        return { key, size, sha256: digest.digest("hex"), mime: policy.mime };
      } finally {
        if (!complete) {
          await handle.close().catch(() => {});
          await unlink(temp).catch(() => {});
          readable.resume();
        }
      }
    },
    async open(key) {
      const handle = await open(
        pathFor(key),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw Error("Not a file");
        return { stream: handle.createReadStream(), size: stat.size };
      } catch (error) {
        await handle.close();
        throw error;
      }
    },
    async remove(key) {
      await unlink(pathFor(key)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}
