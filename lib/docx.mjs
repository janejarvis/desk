// The text of a Word (.docx) file, in plain Node so it works on every computer (it was macOS's
// textutil). A .docx is a zip; the words are in word/document.xml, one <w:p> per paragraph.
import { inflateRawSync } from "node:zlib";

function entry(zip, name) {
  // The zip's directory is at the end: find its record, then walk the entries for the one file.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("not a zip");
  let at = zip.readUInt32LE(end + 16);
  for (let n = zip.readUInt16LE(end + 10); n > 0; n--) {
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32), local = zip.readUInt32LE(at + 42);
    if (zip.toString("utf8", at + 46, at + 46 + nameLen) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return method === 0 ? data : inflateRawSync(data);
    }
    at += 46 + nameLen + extra + comment;
  }
  throw new Error(`no ${name}`);
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function docxText(buf) {
  const xml = entry(buf, "word/document.xml").toString("utf8");
  const text = (x) => x.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m);
  // Only what Word shows: the text runs (<w:t>), tabs and line breaks of each paragraph. Other
  // numbers in the file (drawing positions, ids) are layout, not words.
  const paras = xml.match(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g) || [];
  return paras.map((p) => (p.match(/<w:t(?: [^>]*)?>[^<]*<\/w:t>|<w:tab\/>|<w:br[^>]*\/>/g) || [])
    .map((r) => r.startsWith("<w:tab") ? "\t" : r.startsWith("<w:br") ? "\n" : text(r.replace(/<[^>]+>/g, ""))).join(""))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
