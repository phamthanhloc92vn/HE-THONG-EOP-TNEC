"use client";

// ============================================================
// Định mức xử phạt (migration 143) — Phụ lục 01 "Mức xử phạt" QĐ ATLD/QD/005.
// 3 tầng theo STT: "1" danh mục lớn → "1.1" nhóm → "1.1.1" hạng mục có tiền.
// Ra phiên bản QĐ mới thì upload Excel SỬA ĐÈ theo STT.
// ============================================================

import * as XLSX from "xlsx";
import PizZip from "pizzip";
import { supabase } from "./supabase";
import { atldErrorMessage } from "./atldStock";

// Đơn vị là chữ tự do sau "đồng/" (migration 144): lần, người, thiết bị, xe, vụ…
export type RateUnit = string;
export const UNIT_OPTIONS = ["lần", "người", "thiết bị", "xe", "vụ"];
export const unitLabel = (u: string) => `đồng/${u}`;

export type PenaltyRate = {
  id: string;
  code: string;
  noi_dung: string;
  don_vi: RateUnit | null;
  muc_1: number | null;
  muc_2: number | null;
  muc_3: number | null;
  hinh_thuc_bo_sung: string | null; // VD "Buộc thôi việc và chuyển Công an xử lý" (144)
  ghi_chu: string | null;
};

// Gợi ý cho dropdown "Hình thức xử lý bổ sung" — lấy từ Phụ lục 01; giá trị đã có
// trong bảng cũng được thêm vào danh sách, và vẫn tự ghi được ("Khác").
export const EXTRA_MEASURE_OPTIONS = [
  "Tạm dừng thi công cho đến khi có nhân sự phụ trách tại công trường",
  "Buộc thôi việc và chuyển Công an xử lý",
  "Buộc thôi việc và chuyển Công an xử lý. Đồng thời, nhà thầu sẽ bị đình chỉ thi công toàn hệ thống Lodeza EOP.",
  "Bồi thường 100% tài sản",
  "Bồi thường 100% tài sản và bàn giao Công an xử lý",
  "Trục xuất khỏi công trường và khắc phục thiệt hại môi trường + Chuyển giao Công an",
];
export type PenaltyRateInput = Omit<PenaltyRate, "id">;

// Tầng 1/2/3 = số đoạn của STT.
export const rateLevel = (code: string) => code.split(".").length;

// "1.1.1." / " 1.1 " -> "1.1.1" / "1.1"; sai dạng (chữ, quá 3 tầng) -> null.
export function normalizeCode(v: unknown): string | null {
  const s = String(v ?? "").trim().replace(/\s+/g, "").replace(/\.+$/, "");
  return /^\d+(\.\d+){0,2}$/.test(s) ? s.split(".").map((p) => String(Number(p))).join(".") : null;
}

// Sắp theo từng đoạn số: 1.1.2 < 1.1.10 < 1.2 < 2.
export function compareCode(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

function rateError(err: { message?: string } | null): string {
  const m = err?.message || "";
  if (/atld_penalty_rates/i.test(m) && /does not exist|Could not find/i.test(m)) {
    return "Chưa chạy migration 143 (Định mức xử phạt) trong Supabase > SQL Editor.";
  }
  if (/duplicate key|unique/i.test(m)) return "STT này đã có trong bảng định mức.";
  if (/code_check|violates check constraint.*code/i.test(m)) return "STT sai dạng — chỉ 1, 1.1 hoặc 1.1.1 (tối đa 3 tầng).";
  if (/row-level security/i.test(m)) return "Tài khoản chưa có cờ Khấu trừ xử phạt — P.ATLĐ nhập.";
  return atldErrorMessage(err);
}

export async function fetchRates(): Promise<{ rows: PenaltyRate[]; error: string | null }> {
  const { data, error } = await supabase.from("atld_penalty_rates").select("id, code, noi_dung, don_vi, muc_1, muc_2, muc_3, hinh_thuc_bo_sung, ghi_chu");
  if (error) return { rows: [], error: rateError(error) };
  const rows = (data || []).map((r) => ({
    ...(r as PenaltyRate),
    muc_1: r.muc_1 == null ? null : Number(r.muc_1),
    muc_2: r.muc_2 == null ? null : Number(r.muc_2),
    muc_3: r.muc_3 == null ? null : Number(r.muc_3),
  }));
  return { rows: rows.sort((a, b) => compareCode(a.code, b.code)), error: null };
}

export async function saveRate(id: string | null, input: PenaltyRateInput): Promise<string | null> {
  const q = id
    ? supabase.from("atld_penalty_rates").update(input).eq("id", id).select("id")
    : supabase.from("atld_penalty_rates").insert(input).select("id");
  const { data, error } = await q;
  if (error) return rateError(error);
  // RLS chặn thì trả 0 dòng chứ không báo lỗi.
  if (!data || data.length === 0) return "Không lưu được — tài khoản chưa có cờ Khấu trừ xử phạt — P.ATLĐ nhập.";
  return null;
}

export async function deleteRate(id: string): Promise<string | null> {
  const { data, error } = await supabase.from("atld_penalty_rates").delete().eq("id", id).select("id");
  if (error) return rateError(error);
  if (!data || data.length === 0) return "Không xoá được — xoá thẳng cần cờ P.ATLĐ nhập kèm cờ Duyệt xuất kho ATLĐ, hoặc Admin.";
  return null;
}

// Form "Thêm danh mục" lưu mục chính + các mục con một lần (1 câu lệnh: hỏng thì
// không dòng nào vào). Trùng STT đã có thì báo lỗi, không sửa đè.
export async function insertRates(rows: PenaltyRateInput[]): Promise<string | null> {
  const { data, error } = await supabase.from("atld_penalty_rates").insert(rows).select("id");
  if (error) return rateError(error);
  if (!data || data.length === 0) return "Không lưu được — tài khoản chưa có cờ Khấu trừ xử phạt — P.ATLĐ nhập.";
  return null;
}

// Upload Excel: sửa đè theo STT (có thì cập nhật, chưa có thì thêm).
export async function upsertRates(rows: PenaltyRateInput[]): Promise<string | null> {
  const { error } = await supabase.from("atld_penalty_rates").upsert(rows, { onConflict: "code" });
  return error ? rateError(error) : null;
}

// ─── Excel ───
const fold = (s: unknown) =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/\s+/g, " ").trim();

// Một ô mức phạt của Phụ lục: "2.000.000 đồng/lần + Bồi thường 100% tài sản".
//   amount: CHỈ số tiền ở đầu ô (không gom chữ số của phần sau); trống -> null;
//           ô có chữ mà không mở đầu bằng số -> NaN.
//   unit  : chữ sau "đồng/" tới dấu , + ; hoặc xuống dòng ("lần", "thiết bị", "xe"…).
//           "người, thiết bị" giữ cả cụm vì phần sau dấu phẩy chỉ 1–2 từ.
//   extra : hình thức xử lý kèm theo ("buộc thôi việc…", "Bồi thường 100% tài sản").
function parseMoneyCell(v: unknown): { amount: number | null; unit: string | null; extra: string } {
  if (v == null || String(v).trim() === "") return { amount: null, unit: null, extra: "" };
  if (typeof v === "number") return { amount: Math.round(v), unit: null, extra: "" };
  const s = String(v).replace(/\s+/g, " ").trim();
  const m = s.match(/^(\d[\d.,\s]*\d|\d)/);
  if (!m) return { amount: NaN, unit: null, extra: s };
  let rest = s.slice(m[0].length).trim().replace(/^(đồng|vnđ|vnd|đ)\s*/i, "");
  let unit: string | null = null;
  if (rest.startsWith("/")) {
    rest = rest.slice(1).trim();
    const cut = rest.search(/[,+;]/);
    unit = (cut < 0 ? rest : rest.slice(0, cut)).trim();
    rest = cut < 0 ? "" : rest.slice(cut);
    const tail = rest.replace(/^[,+;]\s*/, "");
    if (rest.startsWith(",") && tail && tail.split(" ").length <= 2 && !/[,+;.]/.test(tail)) {
      unit = `${unit}, ${tail}`;
      rest = "";
    }
  }
  const extra = rest.replace(/^[,+;.\s]+/, "").trim();
  return {
    amount: Number(m[0].replace(/[^\d]/g, "")),
    unit: unit ? unit.replace(/[.\s]+$/, "") || null : null,
    extra: extra.charAt(0).toUpperCase() + extra.slice(1), // "buộc thôi việc…" -> "Buộc thôi việc…" cho khớp dropdown
  };
}

export type ImportRate = PenaltyRateInput & { line: number; error: string; warn: string };

// Dò hàng tiêu đề trong 20 dòng đầu: cần cột STT + Nội dung + Lần 1. Đọc được cả
// bảng chép từ Phụ lục (tiêu đề 2 dòng, "3.000.000 đồng/lần" trong ô) lẫn file
// "Tải về" của tab này (có cột Đơn vị, tiền là số). Không thấy tiêu đề -> null.
export function parseRateWorkbook(wb: XLSX.WorkBook): { sheet: string; rows: ImportRate[] } | null {
  for (const name of wb.SheetNames) {
    const rows = parseRateGrid(XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: null, raw: true }));
    if (rows) return { sheet: name, rows };
  }
  return null;
}

// File Word (.docx): ghép mọi bảng theo thứ tự trong văn bản thành một lưới rồi đọc
// như Excel — bảng Phụ lục sang trang thường bị tách thành nhiều bảng. Ô gộp ngang
// (gridSpan) chép chữ sang MỌI cột lưới nó phủ: file thật có dòng ô STT phủ 3 cột,
// dòng phủ 1–2 cột, nên Nội dung chỉ thẳng cột khi đọc theo vị trí lưới.
// STT đánh số TỰ ĐỘNG (danh sách nhiều cấp "1." → "1.1." → "1.1.1.") không nằm trong
// chữ của ô -> tự tính lại như Word (wordListLabels) rồi ghép vào đầu đoạn văn.
export function parseRateDocx(buf: ArrayBuffer): ImportRate[] | null {
  const zip = new PizZip(buf);
  const xml = zip.file("word/document.xml")?.asText();
  if (!xml) return null;
  const parse = (s: string | undefined) => (s ? new DOMParser().parseFromString(s, "application/xml") : null);
  const doc = parse(xml)!;
  const labels = wordListLabels(doc, parse(zip.file("word/numbering.xml")?.asText()), parse(zip.file("word/styles.xml")?.asText()));
  const kids = (el: Element, name: string) =>
    Array.from(el.childNodes).filter((c): c is Element => c.nodeType === 1 && (c as Element).localName === name);
  const insideCell = (el: Element) => {
    for (let p = el.parentNode as Element | null; p; p = p.parentNode as Element | null) if (p.localName === "tc") return true;
    return false;
  };
  const cellText = (tc: Element) =>
    Array.from(tc.getElementsByTagName("w:p"))
      .map((p) => {
        const text = Array.from(p.getElementsByTagName("w:r"))
          .flatMap((r) => Array.from(r.getElementsByTagName("*")))
          .map((n) => (n.localName === "t" ? n.textContent || "" : n.localName === "tab" ? " " : n.localName === "br" ? "\n" : ""))
          .join("");
        const label = labels.get(p);
        return label ? `${label} ${text}` : text;
      })
      .join("\n")
      .trim();
  const grid: unknown[][] = [];
  for (const tbl of Array.from(doc.getElementsByTagName("w:tbl"))) {
    if (insideCell(tbl)) continue; // bảng lồng trong ô
    for (const tr of kids(tbl, "tr")) {
      const row: unknown[] = [];
      for (const tc of kids(tr, "tc")) {
        const span = Number(tc.getElementsByTagName("w:gridSpan")[0]?.getAttribute("w:val") || 1);
        const text = cellText(tc) || null;
        for (let i = 0; i < span; i++) row.push(text);
      }
      grid.push(row);
    }
  }
  return parseRateGrid(grid);
}

// Tính chữ số của danh sách tự động Word cho từng đoạn văn (theo thứ tự trong văn bản):
// đoạn có numPr (trực tiếp hoặc qua kiểu đoạn) tăng bộ đếm cấp của nó, các cấp sâu
// hơn đếm lại; nhãn = lvlText ("%1.%2.%3.") thay %k bằng bộ đếm cấp k. Đếm theo
// abstractNum như Word (các numId cùng abstractNum đánh số nối tiếp).
function wordListLabels(doc: Document, numbering: Document | null, styles: Document | null): Map<Element, string> {
  const out = new Map<Element, string>();
  if (!numbering) return out;
  const attr = (el: Element | undefined, name: string) => el?.getAttribute(`w:${name}`) ?? undefined;
  const first = (el: Element, tag: string) => el.getElementsByTagName(`w:${tag}`)[0] as Element | undefined;

  type Lvl = { start: number; fmt: string; text: string };
  const abstracts = new Map<string, Lvl[]>();
  for (const a of Array.from(numbering.getElementsByTagName("w:abstractNum"))) {
    const lvls: Lvl[] = [];
    for (const l of Array.from(a.getElementsByTagName("w:lvl"))) {
      lvls[Number(attr(l, "ilvl") || 0)] = {
        start: Number(attr(first(l, "start"), "val") || 1),
        fmt: attr(first(l, "numFmt"), "val") || "decimal",
        text: attr(first(l, "lvlText"), "val") || "",
      };
    }
    abstracts.set(attr(a, "abstractNumId") || "", lvls);
  }
  const numToAbs = new Map<string, string>();
  for (const n of Array.from(numbering.getElementsByTagName("w:num"))) {
    numToAbs.set(attr(n, "numId") || "", attr(first(n, "abstractNumId"), "val") || "");
  }
  // Kiểu đoạn (VD Heading1) có thể mang sẵn numPr.
  const styleNum = new Map<string, { numId: string; ilvl: number }>();
  for (const s of Array.from(styles?.getElementsByTagName("w:style") || [])) {
    const np = first(s, "numPr");
    if (np) styleNum.set(attr(s, "styleId") || "", { numId: attr(first(np, "numId"), "val") || "", ilvl: Number(attr(first(np, "ilvl"), "val") || 0) });
  }

  const roman = (n: number) =>
    [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]]
      .reduce((acc, [v, s]) => {
        while (n >= (v as number)) {
          acc += s;
          n -= v as number;
        }
        return acc;
      }, "");
  const letter = (n: number) => String.fromCharCode(96 + (((n - 1) % 26) + 1));
  const fmtNum = (n: number, fmt: string) =>
    fmt === "upperRoman" ? roman(n).toUpperCase() : fmt === "lowerRoman" ? roman(n)
    : fmt === "upperLetter" ? letter(n).toUpperCase() : fmt === "lowerLetter" ? letter(n) : String(n);

  const counters = new Map<string, number[]>();
  for (const p of Array.from(doc.getElementsByTagName("w:p"))) {
    const pPr = Array.from(p.childNodes).find((c) => c.nodeType === 1 && (c as Element).localName === "pPr") as Element | undefined;
    if (!pPr) continue;
    const np = first(pPr, "numPr");
    const fromStyle = styleNum.get(attr(first(pPr, "pStyle"), "val") || "");
    const numId = np ? attr(first(np, "numId"), "val") : fromStyle?.numId;
    if (!numId || numId === "0") continue;
    const ilvl = Number((np && attr(first(np, "ilvl"), "val")) ?? fromStyle?.ilvl ?? 0);
    const absId = numToAbs.get(numId);
    const lvls = absId !== undefined ? abstracts.get(absId) : undefined;
    if (!lvls?.[ilvl]) continue;
    const c = counters.get(absId!) || [];
    for (let i = 0; i < ilvl; i++) if (c[i] === undefined) c[i] = lvls[i]?.start ?? 1;
    c[ilvl] = c[ilvl] === undefined ? lvls[ilvl].start : c[ilvl] + 1;
    c.length = ilvl + 1; // cấp sâu hơn đếm lại từ đầu
    counters.set(absId!, c);
    const label = lvls[ilvl].text.replace(/%(\d)/g, (_, k) => fmtNum(c[Number(k) - 1] ?? 1, lvls[Number(k) - 1]?.fmt || "decimal"));
    if (label.trim()) out.set(p, label.trim());
  }
  return out;
}

function parseRateGrid(grid: unknown[][]): ImportRate[] | null {
  const col: Record<string, number> = {};
  let headerEnd = -1;
  for (let r = 0; r < Math.min(20, grid.length); r++) {
    (grid[r] || []).forEach((c, i) => {
      const t = fold(c);
      if (col.stt === undefined && /^stt$|^so tt$|^tt$/.test(t)) col.stt = i;
      else if (col.nd === undefined && /noi dung/.test(t)) col.nd = i;
      else if (col.l1 === undefined && /lan 1$/.test(t)) col.l1 = i;
      else if (col.l2 === undefined && /lan 2$/.test(t)) col.l2 = i;
      else if (col.l3 === undefined && /lan 3$/.test(t)) col.l3 = i;
      else if (col.dv === undefined && /^don vi/.test(t)) col.dv = i;
      else if (col.gc === undefined && /^ghi chu/.test(t)) col.gc = i;
      else if (col.ht === undefined && /^hinh thuc/.test(t)) col.ht = i;
      else return;
      headerEnd = Math.max(headerEnd, r);
    });
  }
  if (col.stt === undefined || col.nd === undefined || col.l1 === undefined) return null;

  const rows: ImportRate[] = [];
  const seen = new Set<string>();
  for (let r = headerEnd + 1; r < grid.length; r++) {
    const g = grid[r] || [];
    // Ô Word gộp ngang chép chữ sang mọi cột nó phủ (xem parseRateDocx) -> cột khác
    // mà trùng chữ ô STT là cùng một ô gộp (dòng tiêu đề nhóm), coi như trống.
    const sttText = String(g[col.stt] ?? "").trim();
    const cell = (k: string) => {
      const v = col[k] === undefined ? null : g[col[k]];
      return k !== "stt" && sttText && String(v ?? "").trim() === sttText ? null : v;
    };
    let rawStt = cell("stt");
    let noiDung = String(cell("nd") ?? "").trim();
    // Dòng tiêu đề của Phụ lục gộp ô: "1.1. Vi phạm hồ sơ…" nằm hết trong cột STT.
    const merged = !noiDung && typeof rawStt === "string" ? rawStt.trim().match(/^(\d+(?:\.\d+)*)\.?\s+(.+)$/) : null;
    if (merged) {
      rawStt = merged[1];
      noiDung = merged[2].trim();
    }
    if ((rawStt == null || String(rawStt).trim() === "") && !noiDung) continue;
    const code = normalizeCode(rawStt);
    const money = (["l1", "l2", "l3"] as const).map((k) => parseMoneyCell(cell(k)));
    const [m1, m2, m3] = money.map((x) => x.amount);
    // Hình thức xử lý bổ sung ghi sau số tiền (buộc thôi việc, bồi thường…) -> cột
    // riêng hinh_thuc_bo_sung (144); 3 lần giống nhau (thường 1 ô gộp 3 cột) ghi 1 lần.
    const extras = money.map((x) => x.extra);
    const extraNote = extras.every((e) => e === extras[0])
      ? extras[0]
      : extras.map((e, i) => (e ? `Lần ${i + 1}: ${e}` : "")).filter(Boolean).join("\n");
    const hasMoney = m1 != null || m2 != null || m3 != null;
    let error = "";
    let warn = "";
    if (!code) error = rawStt == null || String(rawStt).trim() === "" ? "Thiếu STT" : `STT "${rawStt}" sai dạng (chỉ 1 / 1.1 / 1.1.1)`;
    else if (!noiDung) error = "Thiếu nội dung";
    else if (seen.has(code)) error = `Trùng STT ${code} trong file`;
    else if ([m1, m2, m3].some((x) => Number.isNaN(x))) error = "Ô mức phạt có chữ không đọc được số";
    if (!error && code) {
      seen.add(code);
      // Excel tự đổi "1.10" thành số 1.1 — nhắc định dạng cột STT là Text.
      if (typeof rawStt === "number" && code.includes(".")) warn = "STT là ô số — nếu là 1.10 thì Excel đã đổi thành 1.1, hãy định dạng cột STT là Text";
      else if (rateLevel(code) === 3 && !hasMoney) warn = "Hạng mục chưa có mức phạt";
    }
    rows.push({
      line: r + 1,
      code: code || String(rawStt ?? ""),
      noi_dung: noiDung,
      don_vi: hasMoney ? String(cell("dv") ?? "").trim() || money.find((x) => x.unit)?.unit || "lần" : null,
      muc_1: Number.isNaN(m1) ? null : m1,
      muc_2: Number.isNaN(m2) ? null : m2,
      muc_3: Number.isNaN(m3) ? null : m3,
      hinh_thuc_bo_sung: String(cell("ht") ?? "").trim() || extraNote || null,
      ghi_chu: String(cell("gc") ?? "").trim() || null,
      error,
      warn,
    });
  }
  return rows;
}

// Tải về = đúng mẫu upload (bảng rỗng thì thành file mẫu). STT ghi dạng chữ để
// Excel không đổi 1.10 thành 1.1.
export function exportRates(rows: PenaltyRate[]) {
  const header = ["STT", "Nội dung xử phạt", "Đơn vị", "Lần 1", "Lần 2", "Lần 3", "Hình thức xử lý bổ sung", "Ghi chú"];
  const body = rows.length
    ? rows.map((r) => [r.code, r.noi_dung, r.don_vi || "", r.muc_1 ?? "", r.muc_2 ?? "", r.muc_3 ?? "", r.hinh_thuc_bo_sung || "", r.ghi_chu || ""])
    : [
        ["1", "Vi phạm hồ sơ pháp lý", "", "", "", "", "", ""],
        ["1.1", "Vi phạm hồ sơ an toàn, vệ sinh lao động", "", "", "", "", "", ""],
        ["1.1.1", "Không lập kế hoạch tổng hợp an toàn", "lần", 3000000, 6000000, 12000000, "", ""],
        ["1.1.5", "Không lập danh sách nhân sự làm việc tại công trường", "người", 500000, 1000000, 2000000, "", ""],
      ];
  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
  for (let r = 1; r <= body.length; r++) {
    const c = ws[XLSX.utils.encode_cell({ r, c: 0 })];
    if (c) {
      c.t = "s";
      c.v = String(c.v);
      c.z = "@";
    }
    for (let k = 3; k <= 5; k++) {
      const m = ws[XLSX.utils.encode_cell({ r, c: k })];
      if (m && m.t === "n") m.z = "#,##0";
    }
  }
  ws["!cols"] = [8, 60, 12, 14, 14, 14, 40, 24].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Dinh muc xu phat");
  XLSX.writeFile(wb, rows.length ? "Dinh_muc_xu_phat_ATLD.xlsx" : "Mau_dinh_muc_xu_phat_ATLD.xlsx");
}
