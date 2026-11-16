// ============================================================
// htmlToText — dựng BẢN CHỮ THƯỜNG (text/plain) từ HTML của email.
//
// Thư chỉ có HTML mà không kèm bản chữ thường bị bộ lọc thư rác chấm điểm xấu
// hơn. Mọi API gửi mail (app/api/send-*, share-news-email) truyền thêm
// `text: htmlToText(html)` vào sendMail — trình đọc thư vẫn hiện bản HTML như cũ,
// bản chữ thường chỉ là phần đi kèm.
// Logic thuần, không thư viện: kiểm bằng scripts/mailText.test.mjs.
// ============================================================

const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'",
};

export function htmlToText(html: string): string {
  return (html || "")
    // Bỏ hẳn phần không phải nội dung.
    .replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // Link: giữ chữ và địa chỉ để người đọc bản chữ thường vẫn bấm/chép được.
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      return label && label !== href ? `${label} (${href})` : href;
    })
    // Xuống dòng theo cấu trúc khối; ô bảng cách nhau bằng " : " cho dạng "Nhãn : Giá trị".
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li|table|blockquote|section)>/gi, "\n")
    .replace(/<\/t[dh]>\s*<t[dh]\b/gi, " : <td")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (k in ENTITIES) return ENTITIES[k];
      if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10));
      return m;
    })
    // Gọn khoảng trắng: mỗi dòng trim, tối đa 1 dòng trống liên tiếp.
    .split("\n")
    .map(l => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
