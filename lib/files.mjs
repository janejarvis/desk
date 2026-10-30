// What Claude makes for Diogo — documents, PDFs, images, artifacts, print files — kept per project
// in project.files and shown in the Files tab. Sessions register what they hand over with
// `desk file add`; artifacts they publish are picked up from their transcripts automatically.
import { readFileSync, existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { extname, basename } from "node:path";

const KIND = {
  pdf: ["pdf"], image: ["png", "jpg", "jpeg", "gif", "webp", "heic", "svg"], video: ["mp4", "mov", "m4v", "webm"],
  html: ["html", "htm"], doc: ["docx", "doc", "pages", "rtf", "odt"], sheet: ["xlsx", "xls", "csv", "numbers"],
  slides: ["pptx", "ppt", "key"], text: ["md", "txt", "json"], print: ["stl", "3mf", "step", "stp", "obj", "ctb", "gcode", "f3d"],
  archive: ["zip"],
};
export function kindOf(pathOrUrl) {
  if (/^https:\/\/claude\.ai\/(code\/)?artifact\//.test(pathOrUrl || "")) return "artifact";
  const e = extname(pathOrUrl || "").slice(1).toLowerCase();
  return Object.keys(KIND).find((k) => KIND[k].includes(e)) || "other";
}

// A file's own title when it has one (an HTML <title>), else its name, tidied.
export function titleFor(path) {
  try {
    if (/\.html?$/i.test(path)) {
      const t = readFileSync(path, "utf8").slice(0, 8000).match(/<title>([^<]{1,120})<\/title>/i)?.[1]?.trim();
      if (t) return t;
    }
  } catch {}
  return basename(path).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

// Artifacts published in a stretch of transcript: [{ url, title, at }]. A publish leaves the page it
// published (file_path) on the tool call and "Published <path> at <url>" on the result.
export function artifactsIn(lines) {
  const uses = new Map(), out = new Map();
  for (const l of lines) {
    if (!l.includes("Artifact") && !l.includes("Published ")) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    const c = o.message?.content;
    if (!Array.isArray(c)) continue;
    for (const x of c) {
      if (x?.type === "tool_use" && x.name === "Artifact") uses.set(x.id, x.input || {});
      if (x?.type === "tool_result" && uses.has(x.tool_use_id)) {
        const i = uses.get(x.tool_use_id);
        if ((i.action || "publish") !== "publish" || i.asset) continue;
        const t = typeof x.content === "string" ? x.content : (x.content || []).map((y) => y?.text || "").join(" ");
        const m = t.match(/Published (\S+) at (https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+)/);
        if (!m) continue;
        const page = m[1];
        const title = (existsSync(page) && titleFor(page)) || i.title || i.description || "Artifact";
        out.set(m[2], { url: m[2], title, at: o.timestamp || new Date().toISOString(), page });
      }
    }
  }
  return [...out.values()];
}

// Read a transcript from a byte offset (new lines only); returns { lines, end }.
export function readFrom(path, from) {
  try {
    const size = statSync(path).size;
    if (size <= from) return { lines: [], end: size };
    const fd = openSync(path, "r");
    try {
      const b = Buffer.alloc(size - from); readSync(fd, b, 0, b.length, from);
      const text = b.toString("utf8"), cut = text.lastIndexOf("\n");
      return { lines: cut < 0 ? [] : text.slice(0, cut).split("\n"), end: from + (cut < 0 ? 0 : Buffer.byteLength(text.slice(0, cut + 1))) };
    } finally { closeSync(fd); }
  } catch { return { lines: [], end: from }; }
}
