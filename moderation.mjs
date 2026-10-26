import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
const path =
  process.env.PINGO_DB_PATH ||
  new URL("./.data/pingo.sqlite", import.meta.url).pathname;
const [command, id, ...notes] = process.argv.slice(2);
if (
  !["list", "show", "resolve", "dismiss"].includes(command) ||
  (command !== "list" && !/^[a-f0-9]{32}$/.test(id || ""))
) {
  console.error(
    "Usage: node moderation.mjs list | show <id> | resolve <id> <review note> | dismiss <id> <review note>",
  );
  process.exit(1);
}
if (!existsSync(path)) {
  console.error("Database not found. Start Pingo once or set PINGO_DB_PATH.");
  process.exit(1);
}
const db = new DatabaseSync(path);
try {
  if (command === "list")
    console.log(
      JSON.stringify(
        db
          .prepare(
            "SELECT id,reported_id,reason,status,created_at FROM reports ORDER BY created_at DESC LIMIT 100",
          )
          .all(),
        null,
        2,
      ),
    );
  else if (command === "show") {
    const report = db.prepare("SELECT * FROM reports WHERE id=?").get(id);
    if (!report) throw Error("Report not found");
    console.log(JSON.stringify(report, null, 2));
  } else {
    const note = notes.join(" ").trim();
    if (!note || note.length > 2000)
      throw Error("A review note of 1–2000 characters is required");
    const result = db
      .prepare(
        "UPDATE reports SET status=?,reviewed_at=?,review_note=? WHERE id=? AND status='open'",
      )
      .run(
        command === "resolve" ? "resolved" : "dismissed",
        Date.now(),
        note,
        id,
      );
    if (!result.changes) throw Error("Report not found or already reviewed");
    console.log(
      "Report reviewed. No automatic user sanction has been applied.",
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
