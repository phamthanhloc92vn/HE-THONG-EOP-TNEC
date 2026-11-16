// Kiểm htmlToText: node scripts/mailText.test.mjs
import assert from "node:assert/strict";
import { htmlToText } from "../lib/mailText.ts";

// Bảng nhãn – giá trị như thư giao việc
assert.equal(
  htmlToText(`<table><tr><td style="x">Tên công việc</td><td>Lập hồ sơ</td></tr><tr><td>Hạn</td><td>25/11/2026</td></tr></table>`),
  "Tên công việc : Lập hồ sơ\nHạn : 25/11/2026"
);
// Link giữ chữ + địa chỉ; link trần giữ địa chỉ
assert.equal(htmlToText(`<a href="https://x.vn/tasks">Mở bảng công việc</a>`), "Mở bảng công việc (https://x.vn/tasks)");
assert.equal(htmlToText(`<a href="https://x.vn">https://x.vn</a>`), "https://x.vn");
// Bỏ head/style, giải mã ký tự, <br>, gom dòng trống
assert.equal(
  htmlToText(`<html><head><style>p{}</style></head><body><p>Kính gửi&nbsp;Anh&#47;Chị,</p><br><br><br><p>A &amp; B &lt;3&gt;</p></body></html>`),
  "Kính gửi Anh/Chị,\n\nA & B <3>"
);
assert.equal(htmlToText(""), "");
assert.equal(htmlToText(undefined), "");
console.log("mailText: tất cả ca kiểm đều đạt");
