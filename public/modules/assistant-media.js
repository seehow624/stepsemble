(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.StepsembleAssistantMedia = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  // Hermes 0.22 的 MEDIA_TAG_CLEANUP_RE：只認可交付的副檔名，強調符號與全形標點都能包住或結束路徑。
  const EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "svg", "mp4", "mov", "avi", "mkv", "webm", "3gp",
    "mp3", "m2a", "wav", "ogg", "opus", "m4a", "flac", "pdf", "docx", "doc", "odt", "rtf", "txt", "md", "epub",
    "xlsx", "xls", "ods", "csv", "tsv", "json", "xml", "yaml", "yml", "kmz", "kml", "geojson", "gpx",
    "pptx", "ppt", "odp", "key", "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "apk", "ipa", "html", "htm"];
  const ALT = [...EXTS].sort((a, b) => b.length - a.length).join("|");
  const CJK = "（）〈〉《》：，。；！？、\u201c\u201d\u2018\u2019【】";
  const TAG = new RegExp("[`\"'*_]{0,3}MEDIA:\\s*(`[^`\\n]+?`|\"[^\"\\n]+?\"|'[^'\\n]+?'|(?:~/|/|[A-Za-z]:[/\\\\])\\S+?(?:[^\\S\\n]+\\S+?)*?\\.(?:" + ALT + "))"
    + "(?=[\\s`\"'*_,;:)\\]}\\[" + CJK + "]|MEDIA:|\\.(?:\\s|$)|$)[`\"'*_]{0,3}\\.?", "gi");
  const PARTIAL = /[`"'*_]{0,3}MEDIA:\S*$/;
  // desktop 模式的互動小工具（::preview{file="…html"}）：不執行，只當成可下載的檔案。
  const PREVIEW = /^[^\S\n]*::preview\{file=(?:"([^"\n]+)"|'([^'\n]+)'|([^\s}"']+))\}[^\S\n]*$/gm;
  const TYPES = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
    pdf: "application/pdf",
  };
  const TEXT = new Set(["txt", "md", "csv", "tsv", "json", "xml", "yaml", "yml", "geojson", "kml", "gpx"]);

  function describe(path) {
    const value = String(path || "");
    const name = value.split(/[\\/]/).filter(Boolean).at(-1) || value;
    const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1].toLowerCase() || "";
    const type = TYPES[ext] || "";
    const kind = type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : type.startsWith("audio/") ? "audio"
      : ext === "pdf" ? "pdf" : TEXT.has(ext) ? "text" : "file";
    return { path: value, name, ext, kind };
  }

  // 只有能安全在 Stepsemble 網域內直接打開的類型才有內容型別；其他一律下載。
  function contentType(path) {
    const { ext } = describe(path);
    return TYPES[ext] || (TEXT.has(ext) ? "text/plain; charset=utf-8" : null);
  }

  // 程式碼區塊、行內程式碼與引用裡的標記只是範例，跟 Hermes 一樣不交付。
  function protectedRanges(text) {
    const ranges = [];
    for (const match of text.matchAll(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[^\n]*|$(?![\s\S]))/gm)) ranges.push([match.index, match.index + match[0].length]);
    for (const match of text.matchAll(/^ {0,3}>[^\n]*/gm)) ranges.push([match.index, match.index + match[0].length]);
    for (const match of text.matchAll(/`[^`\n]+`/g)) {
      if (/MEDIA:\s*$/i.test(text.slice(Math.max(0, match.index - 16), match.index))) continue;
      ranges.push([match.index, match.index + match[0].length]);
    }
    return ranges;
  }

  function extract(text, { partial = false } = {}) {
    const source = typeof text === "string" ? text : "";
    const ranges = protectedRanges(source), cuts = [], files = [], seen = new Set();
    const found = [];
    for (const match of source.matchAll(TAG)) {
      const raw = match[1];
      found.push([match.index, match.index + match[0].length, /^[`"']/.test(raw) ? raw.slice(1, -1).trim() : raw]);
    }
    for (const match of source.matchAll(PREVIEW)) {
      const path = (match[1] || match[2] || match[3] || "").trim();
      if (/^(?:~\/|\/|[A-Za-z]:[\\/])/.test(path)) found.push([match.index, match.index + match[0].length, path]);
    }
    found.sort((a, b) => a[0] - b[0]);
    for (const [start, end, path] of found) {
      if (!path || ranges.some(([from, to]) => start < to && end > from) || cuts.some(([from, to]) => start < to && end > from)) continue;
      cuts.push([start, end]);
      if (!seen.has(path)) { seen.add(path); files.push(describe(path)); }
    }
    let out = "", last = 0;
    for (const [from, to] of cuts) { out += source.slice(last, from); last = to; }
    out += source.slice(last);
    if (partial) out = out.replace(PARTIAL, "");
    return { text: cuts.length || partial ? out.replace(/[^\S\n]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim() : source.trim(), files };
  }

  return Object.freeze({ extract, describe, contentType });
});
