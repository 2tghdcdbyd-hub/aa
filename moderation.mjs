import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { safeText, clip, table, section, date } from "./moderation-format.mjs";
const statuses = {
  open: "검토 대기",
  resolved: "처리 완료",
  dismissed: "종결",
};
const reasons = {
  spam: "스팸·광고",
  harassment: "괴롭힘",
  abuse: "욕설·혐오",
  illegal: "불법 콘텐츠",
  other: "기타",
};
const help = `Pingo 신고 관리

  npm run moderate -- list [옵션]
  npm run moderate -- show <신고 ID 또는 고유한 앞 8자리 이상>
  npm run moderate -- resolve <ID> "검토 결과와 조치 기록"
  npm run moderate -- dismiss <ID> "종결 사유"

목록 옵션
  --status open|resolved|dismissed|all   상태 필터 (기본: all)
  --reason spam|harassment|abuse|illegal|other
  --search "검색어"                    이름·신고 설명 검색
  --page N --limit N                    페이지 (기본: 1, 20건; 최대 100건)
  --width N                            출력 폭 60~200 (기본: 터미널 폭)
  --json                               JSON 출력 (list/show)

표의 이름·설명은 생략될 수 있습니다. show에서 원문과 전체 ID를 확인하세요.
시간은 Asia/Seoul (KST) 기준이며, 처리 완료 기록은 자동 계정 제재가 아닙니다.`;
const jsonOutput = (value) =>
  JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (char) => "\\u" + char.codePointAt(0).toString(16).padStart(4, "0"),
  );
const args = process.argv.slice(2);
if (
  !args.length ||
  args.some((arg) => ["--help", "-h", "help"].includes(arg))
) {
  console.log(help);
  process.exit(0);
}
const command = args.shift();
let db;
try {
  if (!["list", "show", "resolve", "dismiss"].includes(command))
    throw Error("알 수 없는 명령입니다. --help를 확인하세요.");
  const options = {
    status: "all",
    page: 1,
    limit: 20,
    width: Math.min(200, Math.max(60, process.stdout.columns || 100)),
    json: false,
  };
  const positionals = [];
  const allowed =
    command === "list"
      ? ["status", "reason", "search", "page", "limit", "width", "json"]
      : command === "show"
        ? ["width", "json"]
        : [];
  let literal = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--") {
      literal = true;
      continue;
    }
    if (!literal && arg.startsWith("--")) {
      const key = arg.slice(2);
      if (!allowed.includes(key))
        throw Error("지원하지 않는 옵션입니다: " + arg);
      if (key === "json") {
        options.json = true;
        continue;
      }
      const value = args.shift();
      if (value === undefined || value.startsWith("--"))
        throw Error(arg + " 값을 입력하세요.");
      options[key] = value;
    } else positionals.push(arg);
  }
  for (const [key, min, max] of [
    ["width", 60, 200],
    ["page", 1, 1000000],
    ["limit", 1, 100],
  ]) {
    if (
      !/^\d+$/.test(String(options[key])) ||
      Number(options[key]) < min ||
      Number(options[key]) > max
    )
      throw Error(`--${key}는 ${min}~${max} 정수여야 합니다.`);
    options[key] = Number(options[key]);
  }
  if (!["all", ...Object.keys(statuses)].includes(options.status))
    throw Error("올바른 --status 값을 선택하세요.");
  if (options.reason && !Object.hasOwn(reasons, options.reason))
    throw Error("올바른 --reason 값을 선택하세요.");
  if (options.search?.length > 200)
    throw Error("검색어는 200자 이내로 입력하세요.");
  if (command === "list" && positionals.length)
    throw Error("목록 검색은 --search 옵션을 사용하세요.");
  if (command === "show" && positionals.length !== 1)
    throw Error("상세 조회할 신고 ID를 하나 입력하세요.");
  const path =
    process.env.PINGO_DB_PATH ||
    new URL("./.data/pingo.sqlite", import.meta.url).pathname;
  if (!existsSync(path))
    throw Error(
      "DB 파일이 없습니다. Pingo를 먼저 실행하거나 PINGO_DB_PATH를 확인하세요.",
    );
  // Listing and inspection never acquire write access to the application database.
  db = new DatabaseSync(path, { readOnly: ["list", "show"].includes(command) });
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='reports'",
      )
      .get()
  )
    throw Error("신고 테이블이 없습니다. 최신 Pingo 서버를 먼저 실행하세요.");
  const base = `SELECT r.*,reporter.name AS reporter_name,target.name AS reported_name FROM reports r
    JOIN users reporter ON reporter.id=r.reporter_id JOIN users target ON target.id=r.reported_id`;
  if (command === "list") {
    const conditions = [],
      values = [];
    if (options.status !== "all") {
      conditions.push("r.status=?");
      values.push(options.status);
    }
    if (options.reason) {
      conditions.push("r.reason=?");
      values.push(options.reason);
    }
    if (options.search) {
      conditions.push(
        "(instr(lower(reporter.name),lower(?))>0 OR instr(lower(target.name),lower(?))>0 OR instr(lower(r.details),lower(?))>0)",
      );
      values.push(options.search, options.search, options.search);
    }
    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const total = db
      .prepare(
        "SELECT count(*) AS n FROM reports r JOIN users reporter ON reporter.id=r.reporter_id JOIN users target ON target.id=r.reported_id" +
          where,
      )
      .get(...values).n;
    const rows = db
      .prepare(
        base +
          where +
          " ORDER BY (r.status='open') DESC,r.created_at DESC,r.id LIMIT ? OFFSET ?",
      )
      .all(...values, options.limit, (options.page - 1) * options.limit);
    if (options.json) {
      console.log(jsonOutput(rows));
    } else {
      const summary = db
        .prepare("SELECT status,count(*) AS n FROM reports GROUP BY status")
        .all();
      console.log("PINGO · 신고 관리");
      console.log(
        clip(
          "전체 현황  " +
            Object.entries(statuses)
              .map(
                ([key, label]) =>
                  label +
                  " " +
                  (summary.find((r) => r.status === key)?.n || 0) +
                  "건",
              )
              .join("  |  "),
          options.width,
        ),
      );
      console.log(
        clip(
          `조회: ${statuses[options.status] || "전체 상태"}${options.reason ? " · " + reasons[options.reason] : ""}${options.search ? " · 검색 " + safeText(options.search) : ""}`,
          options.width,
        ),
      );
      console.log(
        `검색 결과 ${total}건 · ${options.page}/${Math.max(1, Math.ceil(total / options.limit))} 페이지 · ${rows.length}건 표시 · KST\n`,
      );
      if (!rows.length)
        console.log(
          total
            ? "이 페이지에 신고가 없습니다. --page 값을 확인하세요."
            : "조건에 맞는 신고가 없습니다.",
        );
      else if (options.width >= 96) {
        const targetIdWidth = Math.min(32, Math.max(12, options.width - 100));
        const preview = options.width - 80 - targetIdWidth;
        console.log(
          table(
            [
              "신고 ID",
              "상태",
              "사유",
              "신고자",
              "대상",
              "대상 ID",
              "접수 시각 (KST)",
              "설명",
            ],
            rows.map((r) => [
              r.id.slice(0, 8),
              statuses[r.status],
              reasons[r.reason] || r.reason,
              r.reporter_name,
              r.reported_name,
              r.reported_id,
              date(r.created_at),
              r.details || "(설명 없음)",
            ]),
            [8, 9, 10, 8, 8, targetIdWidth, 16, preview],
            { wrapColumns: [5] },
          ),
        );
      } else {
        for (const row of rows) {
          console.log(
            clip(
              `${row.id.slice(0, 8)} · ${statuses[row.status]} · ${reasons[row.reason] || row.reason}`,
              options.width,
            ),
          );
          console.log(
            clip(
              "  " +
                safeText(row.reporter_name) +
                " → " +
                safeText(row.reported_name) +
                " · " +
                date(row.created_at),
              options.width,
            ),
          );
          console.log(section("대상 ID", row.reported_id, options.width));
          console.log(
            clip(
              "  설명: " + safeText(row.details || "(없음)"),
              options.width,
            ) + "\n",
          );
        }
      }
      console.log("\n상세: npm run moderate -- show <신고 ID>");
      if (options.page * options.limit < total)
        console.log(
          `다음 페이지: 현재 필터를 유지하고 --page ${options.page + 1} 사용`,
        );
    }
  } else {
    const [prefix, ...notes] = positionals;
    if (!/^[a-f0-9]{8,32}$/.test(prefix || ""))
      throw Error("신고 ID는 8~32자리 소문자 16진수로 입력하세요.");
    const matches = db
      .prepare(base + " WHERE substr(r.id,1,?)=? LIMIT 2")
      .all(prefix.length, prefix);
    if (!matches.length) throw Error("해당 신고를 찾을 수 없습니다.");
    if (matches.length > 1)
      throw Error(
        "같은 접두사의 신고가 여러 건입니다. 더 긴 ID 또는 --json 목록의 전체 ID를 사용하세요.",
      );
    const report = matches[0];
    if (command === "show") {
      if (options.json) console.log(jsonOutput(report));
      else {
        console.log("PINGO · 신고 상세");
        console.log(section("신고 ID", report.id, options.width));
        console.log(
          section(
            "상태 / 사유",
            statuses[report.status] +
              " / " +
              (reasons[report.reason] || report.reason),
            options.width,
          ),
        );
        console.log(
          section("접수 시각 (KST)", date(report.created_at), options.width),
        );
        console.log(
          section(
            "신고자",
            report.reporter_name + "\nID: " + report.reporter_id,
            options.width,
          ),
        );
        console.log(
          section(
            "신고 대상",
            report.reported_name + "\nID: " + report.reported_id,
            options.width,
          ),
        );
        console.log(
          section(
            "대화 / 메시지",
            report.conversation_id
              ? `대화: ${report.conversation_id}\n메시지: ${report.message_id}`
              : "사용자 신고 (특정 메시지 없음)",
            options.width,
          ),
        );
        console.log(section("신고 설명", report.details, options.width));
        console.log(
          section(
            "메시지 증거 (서버 보관 원문)",
            report.evidence,
            options.width,
          ),
        );
        console.log(
          section(
            "검토 이력",
            report.reviewed_at
              ? date(report.reviewed_at) + " KST\n" + report.review_note
              : "검토 전",
            options.width,
          ),
        );
        if (report.status === "open")
          console.log(
            `\n처리: npm run moderate -- resolve ${report.id.slice(0, 8)} "검토 결과"\n종결: npm run moderate -- dismiss ${report.id.slice(0, 8)} "종결 사유"`,
          );
      }
    } else {
      const note = notes.join(" ").trim();
      if (!note || note.length > 2000)
        throw Error("검토 메모를 1~2000자로 입력하세요.");
      const status = command === "resolve" ? "resolved" : "dismissed";
      const result = db
        .prepare(
          "UPDATE reports SET status=?,reviewed_at=?,review_note=? WHERE id=? AND status='open'",
        )
        .run(status, Date.now(), note, report.id);
      if (!result.changes)
        throw Error("이미 검토된 신고입니다. 중복 처리하지 않았습니다.");
      console.log(
        `${report.id} · ${statuses[status]}로 기록했습니다.\n계정 자동 제재는 적용하지 않습니다.`,
      );
    }
  }
} catch (error) {
  console.error("오류: " + safeText(error.message));
  process.exitCode = 1;
} finally {
  db?.close();
}
