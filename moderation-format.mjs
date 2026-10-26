const segmenter = new Intl.Segmenter("ko", { granularity: "grapheme" });
// Escape controls and bidi overrides before showing untrusted names, reports or evidence.
export function safeText(value, multiline = false) {
  return String(value ?? "").replace(
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (char) => {
      if (char === "\n") return multiline ? "\n" : " ↵ ";
      if (char === "\t") return "  ";
      return "\\u" + char.codePointAt(0).toString(16).padStart(4, "0");
    },
  );
}
function graphemeWidth(text) {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text)) return 2;
  const points = [...text].filter(
    (char) => !/[\p{M}\u200d\ufe0e\ufe0f]/u.test(char),
  );
  return points.reduce(
    (sum, char) =>
      sum +
      (/[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u.test(
        char,
      )
        ? 2
        : 1),
    0,
  );
}
export function width(text) {
  return [...segmenter.segment(text)].reduce(
    (sum, part) => sum + graphemeWidth(part.segment),
    0,
  );
}
export function clip(text, size) {
  if (width(text) <= size) return text;
  let output = "",
    used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const next = graphemeWidth(segment);
    if (used + next > size - 1) break;
    output += segment;
    used += next;
  }
  return output + "…";
}
export function wrap(text, size) {
  return text.split("\n").flatMap((line) => {
    const lines = [];
    let current = "",
      used = 0;
    for (const { segment } of segmenter.segment(line)) {
      const next = graphemeWidth(segment);
      if (used + next > size) {
        lines.push(current);
        current = "";
        used = 0;
      }
      current += segment;
      used += next;
    }
    lines.push(current);
    return lines;
  });
}
export function table(headers, rows, sizes, { wrapColumns = [] } = {}) {
  const line = (cells) =>
    cells
      .map((cell, i) => {
        const value = clip(safeText(cell), sizes[i]);
        return value + " ".repeat(Math.max(0, sizes[i] - width(value)));
      })
      .join(" │ ");
  return [
    line(headers),
    sizes.map((size) => "─".repeat(size)).join("─┼─"),
    ...rows.flatMap((cells) => {
      const columns = cells.map((cell, i) =>
        wrapColumns.includes(i)
          ? wrap(safeText(cell), sizes[i])
          : [safeText(cell)],
      );
      return Array.from(
        { length: Math.max(...columns.map((column) => column.length)) },
        (_, row) => line(columns.map((column) => column[row] || "")),
      );
    }),
  ].join("\n");
}
export function section(title, value, columns) {
  const text = safeText(value || "(없음)", true);
  return (
    "\n" +
    title +
    "\n" +
    "─".repeat(Math.min(columns, 36)) +
    "\n" +
    wrap(text, columns - 2)
      .map((line) => "  " + line)
      .join("\n")
  );
}
export function date(value) {
  if (!value) return "—";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(value))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
