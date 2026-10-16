"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "../public/modules/assistant-media.js");
function media() {
  assert.ok(fs.existsSync(file), "需要附件標記模組");
  return require(file);
}
const paths = result => result.files.map(item => item.path);

test("依 Hermes 的 MEDIA 規則取出附件，並從文字中移除標記", () => {
  const M = media();
  let found = M.extract("報告好了\nMEDIA:/Users/me/report.pdf");
  assert.deepEqual(paths(found), ["/Users/me/report.pdf"]);
  assert.equal(found.text, "報告好了");
  assert.equal(found.files[0].kind, "pdf");
  assert.equal(found.files[0].name, "report.pdf");
  found = M.extract("看看這張 **MEDIA:/tmp/a.png** 和 `MEDIA:/tmp/code.png`");
  assert.deepEqual(paths(found), ["/tmp/a.png"], "強調可以包住標記，行內程式碼只是範例");
  assert.match(found.text, /`MEDIA:\/tmp\/code.png`/);
  assert.deepEqual(paths(M.extract("早報：MEDIA:/Users/me/早報.pdf（782.6 KB）")), ["/Users/me/早報.pdf"]);
  assert.deepEqual(paths(M.extract("MEDIA:/a.pngMEDIA:/b.png")), ["/a.png", "/b.png"]);
  assert.deepEqual(paths(M.extract("資料 MEDIA:/data/out.csv. 下一句")), ["/data/out.csv"]);
  assert.deepEqual(paths(M.extract("MEDIA:/data/archive.tar.gz")), ["/data/archive.tar.gz"]);
  assert.deepEqual(paths(M.extract("MEDIA:/data/my report.pdf 已完成")), ["/data/my report.pdf"]);
  assert.deepEqual(paths(M.extract("MEDIA:`/data/with space/x.mov`")), ["/data/with space/x.mov"]);
  assert.deepEqual(paths(M.extract("MEDIA:~/Desktop/plan.docx")), ["~/Desktop/plan.docx"]);
});

test("程式碼區塊、引用、相對路徑與未知副檔名不當成附件", () => {
  const M = media();
  for (const text of ["```\nMEDIA:/tmp/a.png\n```", "> MEDIA:/tmp/a.png", "MEDIA:report.pdf", "MEDIA:/tmp/file.unknownext", "沒有附件"]) {
    const found = M.extract(text);
    assert.deepEqual(found.files, [], text);
    assert.equal(found.text, text.trim(), text);
  }
});

test("串流中的半截標記先隱藏，完成後同一路徑只出現一次", () => {
  const M = media();
  assert.deepEqual(M.extract("正在準備 MEDIA:/tmp/rep", { partial: true }), { text: "正在準備", files: [] });
  assert.deepEqual(paths(M.extract("MEDIA:/tmp/a.png\n再一次 MEDIA:/tmp/a.png")), ["/tmp/a.png"]);
});

test("依副檔名分類，HTML 與未知內容只提供下載", () => {
  const M = media();
  const kind = name => M.describe(`/tmp/${name}`).kind;
  assert.deepEqual(["a.JPG", "b.svg", "c.mp4", "d.m4a", "e.pdf", "f.md", "g.zip", "h.html"].map(kind), ["image", "image", "video", "audio", "pdf", "text", "file", "file"]);
  assert.equal(M.contentType("/tmp/a.png"), "image/png");
  assert.equal(M.contentType("/tmp/notes.md"), "text/plain; charset=utf-8");
  assert.equal(M.contentType("/tmp/page.html"), null, "網頁檔不能在 Stepsemble 網域內直接打開");
  assert.equal(M.contentType("/tmp/data.zip"), null);
  assert.deepEqual(M.extract({}).files, []);
});

test("互動小工具顯示成只能下載的檔案卡片，不在頁面裡執行", () => {
  const M = media();
  const found = M.extract("圖表在下面\n::preview{file=\"/Users/me/chart.html\"}\n看完告訴我");
  assert.deepEqual(paths(found), ["/Users/me/chart.html"]);
  assert.equal(found.files[0].kind, "file");
  assert.equal(found.text, "圖表在下面\n\n看完告訴我");
  assert.equal(M.contentType("/Users/me/chart.html"), null);
  const relative = M.extract("::preview{file=\"chart.html\"}");
  assert.deepEqual(relative.files, [], "相對路徑無法對應檔案，保留原文");
});
