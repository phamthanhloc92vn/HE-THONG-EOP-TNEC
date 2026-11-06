import { requireApiAuth } from "@/lib/apiAuth";
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import PizZip from "pizzip";
import { docSoVietNam } from "@/lib/wordExporter";

// ============================================================
// POST /api/export-atld-penalty — "Xuất phiếu" QUYẾT ĐỊNH XỬ LÝ VI PHẠM nhà thầu từ mẫu
// Word public/templates/Quyet_dinh_xu_phat_ATLD_new.docx (ATLD/BM/029, thay mẫu Excel
// Quyet_dinh_xu_phat_nha_thau_2.xlsx từ 06/11/2026).
// Dữ liệu do client gom sẵn (lib/atldPenalties.ts > downloadPenaltyDecision).
//
// PizZip sửa thẳng word/document.xml. KHÔNG ghi cứng vị trí — dò đoạn theo chữ đầu đoạn:
//   "Về việc:"                       ……  = dự án
//   "Căn cứ Hợp đồng số"             3 chỗ …… = số HĐ / (ngày ký: để trống) / nhà thầu
//   "Căn cứ Biên bản đề nghị"        chỗ …… thứ 3 (sau "dự án") = dự án
//   "Xác định đơn vị: CÔNG TY"       + tên nhà thầu (bỏ chữ "Công ty" đầu tên cho khỏi lặp)
//   "Dự án:"                         + dự án
//   Bảng có "Số lần vi phạm"         STT | Mã lỗi | Nội dung | Căn cứ quy định | Lần vi phạm
//   Bảng có "Thành tiền"             STT | Mã lỗi | Nội dung | Số lần tính | Đơn giá | Thành tiền
//                                    + dòng TỔNG CỘNG
//   "Tổng số lỗi được xác định"      số dòng vi phạm
//   "Tổng giá trị xử lý"             tổng tiền; "Bằng chữ:" đọc số
//   "4.Báo cáo kết quả khắc phục"    "ngày_____" = hạn khắc phục (chọn lúc xuất)
//   "1.Ban Điều hành/Ban Chỉ huy dự án", "- Ban Điều hành dự án"  …… = dự án
// Chỗ hệ thống không có dữ liệu (Gói thầu, Địa điểm, Thời gian ghi nhận, số/ngày biên
// bản, ngày ký HĐ) giữ nguyên chấm/trống của mẫu để ghi tay.
// Bảng: các dòng có STT là số = dòng chi tiết; nhiều vi phạm hơn số dòng mẫu thì nhân dòng.
// ============================================================

const TEMPLATE_FILE = "Quyet_dinh_xu_phat_ATLD_new.docx";
const DOC_XML = "word/document.xml";

const s = (v: unknown) => String(v ?? "").trim();
const numOrNull = (v: unknown) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const escXml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

const unescXml = (v: string) =>
  v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const money = (n: number | null) => (n == null ? "" : Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "."));

const textOf = (xml: string) => unescXml([...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(""));

const runXml = (v: string) => `<w:r><w:t xml:space="preserve">${escXml(v)}</w:t></w:r>`;

const PARA_RE = /<w:p[ >][\s\S]*?<\/w:p>/g;

/** Sửa đoạn ĐẦU TIÊN có chữ bắt đầu bằng `prefix`. */
function editPara(xml: string, prefix: string, fn: (p: string) => string): string {
  let done = false;
  return xml.replace(PARA_RE, (p) => {
    if (done || !textOf(p).trim().startsWith(prefix)) return p;
    done = true;
    return fn(p);
  });
}

/** Thay lần lượt các chỗ "……" trong đoạn; giá trị rỗng/null thì giữ chấm của mẫu. */
function fillDots(p: string, values: (string | null)[]): string {
  let i = 0;
  return p.replace(/(<w:t(?: [^>]*)?>)([^<]*)(<\/w:t>)/g, (all, _open, t: string, close) => {
    const next = t.replace(/…+/g, (dots: string) => {
      const v = values[i++];
      return v ? escXml(v) : dots;
    });
    // Giữ khoảng trắng đầu/cuối của giá trị (Word bỏ nếu thiếu xml:space).
    return next === t ? all : `<w:t xml:space="preserve">${next}${close}`;
  });
}

/** Đoạn "Nhãn: <tab chấm>" — thay tab chấm cuối đoạn bằng giá trị. */
function fillTail(p: string, v: string): string {
  if (!v) return p;
  const idx = p.lastIndexOf("<w:r><w:tab/></w:r>");
  return idx < 0
    ? p.replace(/<\/w:p>$/, runXml(v) + "</w:p>")
    : p.slice(0, idx) + runXml(v) + p.slice(idx + "<w:r><w:tab/></w:r>".length);
}

/** Ghi chữ vào từng ô của một dòng bảng (giữ định dạng đoạn của ô). */
function setCells(row: string, values: string[]): string {
  let i = 0;
  return row.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, (tc) => {
    const v = values[i++] ?? "";
    return tc.replace(/<w:p( [^>]*)?>([\s\S]*?)<\/w:p>/, (_a, attrs = "", inner: string) => {
      const pPr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(inner)?.[0] ?? "";
      return `<w:p${attrs}>${pPr}${v ? runXml(v) : ""}</w:p>`;
    });
  });
}

/** Thay các dòng chi tiết (ô đầu là số) của bảng bằng `data`, nhân dòng nếu thiếu. */
function fillTable(tbl: string, data: string[][]): string {
  const rows = [...tbl.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)];
  const items = rows.filter((m) => /^\d+$/.test(textOf(/<w:tc>[\s\S]*?<\/w:tc>/.exec(m[0])?.[0] ?? "").trim()));
  if (!items.length) return tbl;
  const n = Math.max(data.length, items.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    // Dòng cuối lấy theo dòng cuối của mẫu: mẫu bỏ keepNext ở đó để bảng được ngắt
    // sang đoạn sau; lấy dòng 1 (có keepNext) cho mọi dòng thì cả cụm Điều 1 → bảng 2.1
    // dính liền và bị đẩy sang trang sau, bỏ trống nửa trang 1.
    const tpl = i === n - 1 ? items[items.length - 1][0] : items[0][0];
    out.push(setCells(tpl, data[i] ?? []).replace(/ w14:(paraId|textId)="[^"]*"/g, ""));
  }
  const first = items[0].index!;
  const lastM = items[items.length - 1];
  const last = lastM.index! + lastM[0].length;
  return tbl.slice(0, first) + out.join("") + tbl.slice(last);
}

const dmy = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}/${m}/${y}` : null;
};

type Line = {
  maLoi: string; noiDung: string; canCu: string; lanViPham: number | null;
  sl: number | null; mucPhat: number | null; thanhTien: number | null;
};

export async function POST(request: NextRequest) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json();
    const templatePath = path.join(process.cwd(), "public", "templates", TEMPLATE_FILE);
    if (!fs.existsSync(templatePath)) {
      return NextResponse.json({ error: "template_not_found", fileName: TEMPLATE_FILE }, { status: 404 });
    }

    const zip = new PizZip(fs.readFileSync(templatePath));
    let xml = zip.file(DOC_XML)?.asText();
    if (!xml) return NextResponse.json({ error: "document_xml_not_found" }, { status: 500 });

    const lines: Line[] = (Array.isArray(body.lines) ? body.lines : []).map((l: Record<string, unknown>) => ({
      maLoi: s(l.maLoi),
      noiDung: s(l.noiDung),
      canCu: s(l.canCu),
      lanViPham: numOrNull(l.lanViPham),
      sl: numOrNull(l.sl),
      mucPhat: numOrNull(l.mucPhat),
      thanhTien: numOrNull(l.thanhTien),
    }));
    // Mẫu in sẵn "dự án ……" -> bỏ chữ "Dự án" đầu tên cho khỏi lặp ("dự án Dự án Vàm Lẽo").
    const duAn = s(body.duAn).replace(/^dự\s+án\s+/i, "");
    const nhaThau = s(body.nhaThau);
    // Tổng = Giá trị phải khấu trừ của hồ sơ (số chính thức); hồ sơ cũ tra định mức theo
    // nội dung có thể không khớp đủ dòng nên không cộng từ bảng.
    const total = numOrNull(body.tongTien) ?? lines.reduce((a, l) => a + (l.thanhTien ?? 0), 0);

    // ─── Phần căn cứ ───
    xml = editPara(xml, "Về việc:", (p) => fillDots(p, [duAn]));
    xml = editPara(xml, "Căn cứ Hợp đồng số", (p) => fillDots(p, [s(body.soHopDong), null, nhaThau]));
    xml = editPara(xml, "Căn cứ Biên bản đề nghị", (p) => fillDots(p, [null, null, duAn ? ` ${duAn}` : null]));

    // ─── Điều 1 ───
    // Mẫu in sẵn "CÔNG TY" (đậm) -> bỏ chữ "Công ty" đầu tên nhà thầu cho khỏi lặp.
    const donVi = nhaThau.replace(/^công\s+ty\s*/i, "").toLocaleUpperCase("vi");
    xml = editPara(xml, "Xác định đơn vị:", (p) => fillTail(p, donVi));
    xml = editPara(xml, "Dự án:", (p) => fillTail(p, duAn));

    xml = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (tbl) => {
      const t = textOf(tbl);
      if (t.includes("Số lần vi phạm")) {
        return fillTable(tbl, lines.map((l, i) => [
          String(i + 1), l.maLoi, l.noiDung, l.canCu, l.lanViPham == null ? "" : String(l.lanViPham),
        ]));
      }
      if (t.includes("Thành tiền")) {
        const filled = fillTable(tbl, lines.map((l, i) => [
          String(i + 1), l.maLoi, l.noiDung, l.sl == null ? "" : String(l.sl), money(l.mucPhat), money(l.thanhTien),
        ]));
        // Dòng TỔNG CỘNG: ô "……" cuối = tổng tiền.
        return filled.replace(/<w:tr[ >][\s\S]*?<\/w:tr>/g, (tr) => (textOf(tr).includes("TỔNG CỘNG") ? fillDots(tr, [money(total)]) : tr));
      }
      return tbl;
    });

    // ─── Điều 2.2 ───
    if (lines.length) xml = editPara(xml, "Tổng số lỗi được xác định", (p) => fillDots(p, [String(lines.length)]));
    xml = editPara(xml, "Tổng giá trị xử lý:", (p) => fillDots(p, [money(total)]));
    xml = editPara(xml, "Bằng chữ:", (p) => fillTail(p, docSoVietNam(total)));

    // ─── Điều 3: hạn khắc phục ───
    const han = dmy(s(body.hanKhacPhuc));
    if (han) {
      xml = editPara(xml, "4.Báo cáo kết quả khắc phục", (p) =>
        p.replace(/(<w:t(?: [^>]*)?>)([^<]*?)_{3,}([^<]*<\/w:t>)/, (_a, _open, pre, rest) => `<w:t xml:space="preserve">${pre} ${han}${rest}`)
      );
    }

    // ─── Điều 5 + Nơi nhận ───
    xml = editPara(xml, "1.Ban Điều hành/Ban Chỉ huy dự án", (p) => fillDots(p, [duAn]));
    xml = editPara(xml, "- Ban Điều hành dự án", (p) => fillDots(p, [duAn]));

    zip.file(DOC_XML, xml);
    const buf = zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(String(body.fileName || TEMPLATE_FILE))}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error: unknown) {
    console.error("Export ATLD penalty error:", error);
    const msg = error instanceof Error ? error.message : "Error exporting template";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
