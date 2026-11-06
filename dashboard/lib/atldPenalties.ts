"use client";

// ============================================================
// Khấu trừ xử phạt — P.ATLĐ nhập đầu vào, P.KHĐT nhập đầu ra (migration 139).
// Thay bảng Excel "BẢNG THEO DÕI HỒ SƠ KHẤU TRỪ - XỬ PHẠT VI PHẠM AN TOÀN".
// Giá trị còn lại là cột sinh sẵn ở CSDL; trạng thái / số ngày theo dõi / cảnh báo
// tính ở đây theo ngày hôm nay (giờ VN) nên không bao giờ lệch như công thức Excel.
// Chặn từng cột theo phòng nằm ở trigger CSDL — giao diện chỉ khoá ô cho dễ hiểu.
// ============================================================

import { supabase } from "./supabase";
import { apiFetch } from "./apiClient";
import { atldErrorMessage } from "./atldStock";
import { fetchRates, type PenaltyRate } from "./atldPenaltyRates";

export const PENALTY_TYPES = ["Xử phạt vi phạm an toàn", "Khấu trừ cấp phát BHLĐ"];
export const PPE_TYPES = ["Cấp phát PPE thu hồi chi phí"];

// Tab "Khấu trừ PPE" dùng CHUNG bảng atld_penalties với "Khấu trừ xử phạt", phân biệt
// bằng cột kind (migration 160): cùng luồng ATLĐ nhập đầu vào / KHĐT nhập đầu ra, chỉ khác nhãn.
export type PenaltyKind = "penalty" | "ppe";
export const KIND_CFG: Record<PenaltyKind, {
  types: string[]; sheetTitle: string; fileStem: string; sheet: string; createLabel: string; modalTitle: string;
  docNo: string; contractor: string; contractorPh: string; person: string; personPh: string; content: string;
}> = {
  penalty: {
    types: PENALTY_TYPES,
    sheetTitle: "BẢNG THEO DÕI HỒ SƠ KHẤU TRỪ - XỬ PHẠT VI PHẠM AN TOÀN (ATLĐ & KHĐT)",
    fileStem: "Khau_tru_xu_phat", sheet: "Khau tru xu phat",
    createLabel: "Tạo hồ sơ xử phạt", modalTitle: "Tạo hồ sơ khấu trừ / xử phạt",
    docNo: "Số QĐ", contractor: "Nhà thầu phụ", contractorPh: "Tìm nhà thầu phụ hoặc gõ tên…",
    person: "Người vi phạm", personPh: "Họ tên người vi phạm (nếu có)", content: "Nội dung vi phạm (chọn từ Định mức xử phạt hoặc gõ tay)",
  },
  ppe: {
    types: PPE_TYPES,
    sheetTitle: "BẢNG THEO DÕI HỒ SƠ KHẤU TRỪ - CẤP PHÁT PPE THU HỒI CHI PHÍ (ATLĐ & KHĐT)",
    fileStem: "Khau_tru_PPE", sheet: "Khau tru PPE",
    createLabel: "Tạo hồ sơ khấu trừ PPE", modalTitle: "Tạo hồ sơ khấu trừ PPE",
    docNo: "Số phiếu cấp phát", contractor: "Đối tượng / Nhà thầu", contractorPh: "Tìm nhà thầu hoặc gõ tên…",
    person: "Người nhận", personPh: "Họ tên người nhận PPE (nếu có)", content: "Nội dung cấp phát (mã PPE, số lượng, người nhận…)",
  },
};

export type Penalty = {
  id: string;
  kind?: PenaltyKind; // 160; hồ sơ cũ / chưa chạy 160 coi là "penalty"
  ma_ho_so: string;
  loai_ho_so: string;
  so_quyet_dinh: string | null;
  qd_file_path: string | null;
  qd_file_name: string | null;
  qd_link: string | null;
  ngay_ban_hanh: string | null;
  project_code: string | null;
  project_name: string | null;
  contractor_id: string | null;
  contractor_name: string;
  nguoi_vi_pham?: string | null; // gõ tay, in vào "Người vi phạm" của Quyết định (148)
  noi_dung: string | null;
  gia_tri_phai_tru: number;
  nguoi_lap: string | null;
  ngay_gui_khdt: string | null;
  ngay_tiep_nhan: string | null;
  dot_thanh_toan: string | null;
  gia_tri_da_tru: number;
  ngay_khau_tru: string | null;
  so_chung_tu: string | null;
  nguoi_nhap: string | null;
  ghi_chu: string | null;
  // Tệp / link của Số chứng từ (P.KHĐT, migration 141)
  ct_file_path?: string | null;
  ct_file_name?: string | null;
  ct_link?: string | null;
  vi_pham?: ViolationLine[] | null; // danh sách vi phạm chọn từ Định mức (147)
  gia_tri_con_lai: number;
  created_by?: string | null; // email tài khoản tạo hồ sơ (trigger 139)
  created_at: string;
};

// Cột P.ATLĐ / P.KHĐT — form chỉ gửi nhóm cột người dùng được sửa.
export type PenaltyInput = Pick<
  Penalty,
  | "loai_ho_so" | "so_quyet_dinh" | "qd_link" | "ngay_ban_hanh" | "project_code" | "project_name"
  | "contractor_id" | "contractor_name" | "nguoi_vi_pham" | "noi_dung" | "gia_tri_phai_tru" | "nguoi_lap" | "ngay_gui_khdt"
> & { vi_pham?: ViolationLine[] | null };

// ─── Vi phạm chọn từ tab Định mức xử phạt (migration 147) ───
// Một hồ sơ gồm nhiều dòng. Dòng từ định mức CHỤP lại nội dung + 3 mức tiền tại lúc
// lập (sửa định mức sau này không đổi hồ sơ cũ, vẫn đổi Lần được). Dòng gõ tay:
// rate_id = null, tự nhập thành tiền.
export type ViolationLine = {
  rate_id: string | null;
  code: string | null;          // STT định mức, VD "2.11.6"
  noi_dung: string;
  muc: (number | null)[];       // [Lần 1, Lần 2, Lần 3] lúc chọn
  don_vi: string | null;        // "lần", "người", "thiết bị"…
  hinh_thuc: string | null;     // hình thức xử lý bổ sung
  lan: 1 | 2 | 3;
  so_luong: number;
  thanh_tien: number;
};

// Đơn vị khác "lần" mới nhân số lượng (VD 1.000.000 đồng/người × 3 người).
export const perUnit = (l: Pick<ViolationLine, "rate_id" | "don_vi">) => !!l.rate_id && !!l.don_vi && l.don_vi !== "lần";

export function lineAmount(l: ViolationLine): number {
  const gia = l.muc[l.lan - 1] ?? l.muc.find((x) => x != null) ?? 0;
  return gia * (perUnit(l) ? Math.max(1, l.so_luong || 1) : 1);
}

// "2.11.6 — Không kiểm tra huyết áp… (Lần 2, 3 người). Hình thức bổ sung: …"
export function lineText(l: ViolationLine): string {
  if (!l.rate_id) return l.noi_dung.trim();
  const meta = [`Lần ${l.lan}`, perUnit(l) ? `${l.so_luong} ${l.don_vi}` : ""].filter(Boolean).join(", ");
  return `${l.code ? `${l.code} — ` : ""}${l.noi_dung.trim()} (${meta})${l.hinh_thuc ? `. Hình thức bổ sung: ${l.hinh_thuc}` : ""}`;
}

// Ghép cột noi_dung + tổng tiền từ các dòng (bỏ dòng trống).
export function composeViolations(lines: ViolationLine[]): { noi_dung: string; total: number; lines: ViolationLine[] } {
  const used = lines.filter((l) => l.noi_dung.trim());
  return {
    noi_dung: used.map(lineText).join("\n"),
    total: used.reduce((s, l) => s + (Number(l.thanh_tien) || 0), 0),
    lines: used,
  };
}
export type PenaltyOutput = Pick<
  Penalty,
  "ngay_tiep_nhan" | "dot_thanh_toan" | "gia_tri_da_tru" | "ngay_khau_tru" | "so_chung_tu" | "nguoi_nhap" | "ghi_chu" | "ct_link"
>;

// Hai loại tài liệu đính kèm: Số QĐ (P.ATLĐ) và Số chứng từ (P.KHĐT).
export type PenaltyDoc = "qd" | "ct";
export const DOC_LABEL: Record<PenaltyDoc, string> = { qd: "Số QĐ", ct: "Số chứng từ" };
export function docOf(p: Penalty, kind: PenaltyDoc): { no: string | null; path: string | null; name: string | null; link: string | null } {
  return kind === "qd"
    ? { no: p.so_quyet_dinh, path: p.qd_file_path, name: p.qd_file_name, link: p.qd_link }
    : { no: p.so_chung_tu, path: p.ct_file_path ?? null, name: p.ct_file_name ?? null, link: p.ct_link ?? null };
}

export type PenaltyAccess = { view: boolean; input: boolean; process: boolean; stock: boolean };
export const NO_PENALTY_ACCESS: PenaltyAccess = { view: false, input: false, process: false, stock: false };

export async function fetchPenaltyAccess(): Promise<PenaltyAccess> {
  const { data, error } = await supabase.rpc("atld_penalty_my_access");
  if (error || !data) return NO_PENALTY_ACCESS;
  const d = data as Partial<PenaltyAccess>;
  return { view: !!d.view, input: !!d.input, process: !!d.process, stock: !!d.stock };
}

export async function fetchPenalties(kind: PenaltyKind = "penalty"): Promise<{ rows: Penalty[]; error: string | null }> {
  const { data, error } = await supabase.from("atld_penalties").select("*").order("nam", { ascending: false }).order("seq", { ascending: false });
  if (error) {
    const missing = /atld_penalties/i.test(error.message || "") && /find|exist/i.test(error.message || "");
    return { rows: [], error: missing ? "Chưa chạy migration 139 (khấu trừ xử phạt) trong Supabase > SQL Editor." : atldErrorMessage(error) };
  }
  return {
    // Lọc theo loại ở client: chưa chạy migration 160 (chưa có cột kind) thì tab xử phạt vẫn chạy bình thường.
    rows: ((data as Penalty[]) || []).filter((r) => (r.kind ?? "penalty") === kind).map((r) => ({
      ...r,
      gia_tri_phai_tru: Number(r.gia_tri_phai_tru) || 0,
      gia_tri_da_tru: Number(r.gia_tri_da_tru) || 0,
      gia_tri_con_lai: Number(r.gia_tri_con_lai) || 0,
    })),
    error: null,
  };
}

const clean = (s: string | null | undefined) => {
  const t = (s ?? "").trim().replace(/\s+/g, " ");
  return t === "" ? null : t;
};

function cleanInput(v: PenaltyInput, kind: PenaltyKind = "penalty") {
  return {
    loai_ho_so: clean(v.loai_ho_so) || KIND_CFG[kind].types[0],
    so_quyet_dinh: clean(v.so_quyet_dinh),
    qd_link: clean(v.qd_link),
    ngay_ban_hanh: v.ngay_ban_hanh || null,
    project_code: clean(v.project_code),
    project_name: clean(v.project_name),
    contractor_id: v.contractor_id || null,
    contractor_name: clean(v.contractor_name) || "",
    nguoi_vi_pham: clean(v.nguoi_vi_pham),
    noi_dung: (v.noi_dung ?? "").trim() || null,
    gia_tri_phai_tru: Math.max(0, Math.round(Number(v.gia_tri_phai_tru) || 0)),
    nguoi_lap: clean(v.nguoi_lap),
    ngay_gui_khdt: v.ngay_gui_khdt || null,
    vi_pham: v.vi_pham && v.vi_pham.length ? v.vi_pham : null,
  };
}

function cleanOutput(v: PenaltyOutput) {
  return {
    ngay_tiep_nhan: v.ngay_tiep_nhan || null,
    dot_thanh_toan: clean(v.dot_thanh_toan),
    gia_tri_da_tru: Math.max(0, Math.round(Number(v.gia_tri_da_tru) || 0)),
    ngay_khau_tru: v.ngay_khau_tru || null,
    so_chung_tu: clean(v.so_chung_tu),
    nguoi_nhap: clean(v.nguoi_nhap),
    ghi_chu: (v.ghi_chu ?? "").trim() || null,
    ct_link: clean(v.ct_link),
  };
}

function penaltyError(err: { message?: string; code?: string } | null): string {
  const m = err?.message || "";
  if (/atld_penalties_da_tru_le_phai_tru/i.test(m)) return "Giá trị đã khấu trừ không được lớn hơn giá trị phải khấu trừ.";
  if (/kind/i.test(m) && /column|find/i.test(m)) return "Chưa chạy migration 160 (khấu trừ PPE) trong Supabase > SQL Editor.";
  if (/nguoi_vi_pham/i.test(m) && /column|find/i.test(m)) return "Chưa chạy migration 148 (cột Người vi phạm) trong Supabase > SQL Editor.";
  if (/ct_link|ct_file/i.test(m) && /column|find/i.test(m)) return "Chưa chạy migration 141 (tệp số chứng từ) trong Supabase > SQL Editor.";
  return atldErrorMessage(err);
}

export async function createPenalty(input: PenaltyInput, output: PenaltyOutput | null, kind: PenaltyKind = "penalty"): Promise<{ id: string | null; error: string | null }> {
  const row = { ...cleanInput(input, kind), ...(output ? cleanOutput(output) : {}), ...(kind === "ppe" ? { kind } : {}) };
  const { data, error } = await supabase.from("atld_penalties").insert(row).select("id");
  if (error) return { id: null, error: penaltyError(error) };
  const id = (data as { id: string }[] | null)?.[0]?.id || null;
  return id ? { id, error: null } : { id: null, error: "Không tạo được — tài khoản chưa có quyền nhập hồ sơ xử phạt (P.ATLĐ)." };
}

export async function updatePenalty(id: string, input: PenaltyInput | null, output: PenaltyOutput | null): Promise<string | null> {
  const row = { ...(input ? cleanInput(input) : {}), ...(output ? cleanOutput(output) : {}) };
  const { data, error } = await supabase.from("atld_penalties").update(row).eq("id", id).select("id");
  if (error) return penaltyError(error);
  // RLS chặn UPDATE thì trả 0 dòng chứ không báo lỗi.
  if (!data || (data as unknown[]).length === 0) return "Không lưu được — tài khoản chưa có quyền với hồ sơ này.";
  return null;
}

export async function deletePenalty(id: string): Promise<string | null> {
  const { data, error } = await supabase.from("atld_penalties").delete().eq("id", id).select("id");
  if (error) return penaltyError(error);
  if (!data || (data as unknown[]).length === 0) return "Không xoá được — xoá thẳng cần cờ nhập hồ sơ xử phạt (P.ATLĐ) kèm cờ Duyệt xuất kho ATLĐ, hoặc Admin.";
  return null;
}

// ─── Tệp đính kèm (bucket atld-penalty): QĐ ở "<id>/…", chứng từ KHĐT ở "<id>/ct/…" ───
// Thứ tự an toàn: tải tệp mới -> ghi CSDL -> xoá tệp cũ.
export const PENALTY_BUCKET = "atld-penalty";
const MAX_BYTES = 2 * 1024 * 1024;

export async function uploadPenaltyFile(penaltyId: string, file: File, kind: PenaltyDoc = "qd"): Promise<{ path: string; name: string }> {
  if (!(file.type === "application/pdf" || file.type.startsWith("image/"))) {
    throw new Error(`"${file.name}" không phải ảnh hoặc PDF — chỉ nhận hai loại này.`);
  }
  if (file.size > MAX_BYTES) throw new Error(`"${file.name}" vượt 2MB — hãy tải lên Drive rồi dán link.`);
  const path = `${penaltyId}/${kind === "ct" ? "ct/" : ""}${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
  const { error } = await supabase.storage.from(PENALTY_BUCKET).upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });
  if (error) {
    const hint = /bucket not found/i.test(error.message)
      ? " — chưa có kho tệp. Chạy migrations/139_atld_penalties.sql trong Supabase > SQL Editor."
      : /row-level security|policy/i.test(error.message)
      ? kind === "ct"
        ? " — tài khoản chưa có quyền xử lý khấu trừ (P.KHĐT), hoặc chưa chạy migration 141."
        : " — tài khoản chưa có quyền nhập hồ sơ xử phạt (P.ATLĐ)."
      : "";
    throw new Error(`Không tải lên được "${file.name}": ${error.message}${hint}`);
  }
  return { path, name: file.name };
}

export async function setPenaltyFile(id: string, path: string | null, name: string | null, kind: PenaltyDoc = "qd"): Promise<string | null> {
  const patch = kind === "ct" ? { ct_file_path: path, ct_file_name: name } : { qd_file_path: path, qd_file_name: name };
  const { data, error } = await supabase.from("atld_penalties").update(patch).eq("id", id).select("id");
  if (error) return penaltyError(error);
  if (!data || (data as unknown[]).length === 0) return "Không lưu được tệp — tài khoản chưa có quyền với hồ sơ này.";
  return null;
}

export async function removePenaltyFile(path: string): Promise<void> {
  try {
    await supabase.storage.from(PENALTY_BUCKET).remove([path]);
  } catch {
    // tệp mồ côi không ảnh hưởng ai
  }
}

// downloadName: link tải thẳng về máy (đặt đúng tên tệp gốc) thay vì mở xem.
export async function penaltyFileUrl(path: string, downloadName?: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(PENALTY_BUCKET)
    .createSignedUrl(path, 60 * 60, downloadName ? { download: downloadName } : undefined);
  return error || !data ? null : data.signedUrl;
}

export async function setPenaltyLink(id: string, link: string | null, kind: PenaltyDoc = "qd"): Promise<string | null> {
  const patch = kind === "ct" ? { ct_link: link } : { qd_link: link };
  const { data, error } = await supabase.from("atld_penalties").update(patch).eq("id", id).select("id");
  if (error) return penaltyError(error);
  if (!data || (data as unknown[]).length === 0) return "Không lưu được — tài khoản chưa có quyền với hồ sơ này.";
  return null;
}

// ─── Tự tính: trạng thái, số ngày theo dõi, cảnh báo ───
export type PenaltyStatus = "chua" | "mot_phan" | "da";
export const PENALTY_STATUS_META: Record<PenaltyStatus, { label: string; cls: string }> = {
  chua: { label: "Chưa khấu trừ", cls: "bg-amber-50 text-amber-700 border border-amber-200" },
  mot_phan: { label: "Khấu trừ một phần", cls: "bg-blue-50 text-[#005BAC] border border-blue-200" },
  da: { label: "Đã khấu trừ", cls: "bg-emerald-50 text-emerald-700 border border-emerald-200" },
};

export function penaltyStatus(p: Pick<Penalty, "gia_tri_con_lai" | "gia_tri_da_tru">): PenaltyStatus {
  if (p.gia_tri_con_lai <= 0) return "da";
  return p.gia_tri_da_tru > 0 ? "mot_phan" : "chua";
}

export function todayVN(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
}

// Số ngày kể từ ngày gửi thông tin cho KHĐT; đã khấu trừ xong thì thôi đếm.
export function trackingDays(p: Pick<Penalty, "ngay_gui_khdt" | "gia_tri_con_lai" | "gia_tri_da_tru">, today = todayVN()): number | null {
  if (!p.ngay_gui_khdt || penaltyStatus(p) === "da") return null;
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${p.ngay_gui_khdt}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86400000));
}

// 20–30 ngày: cam (sắp quá hạn); trên 30 ngày: đỏ (quá hạn); đã khấu trừ: xanh lá.
export type PenaltyAlert = "qua_han" | "sap_qua_han" | "da" | null;
export function penaltyAlert(status: PenaltyStatus, days: number | null): PenaltyAlert {
  if (status === "da") return "da";
  if (days == null) return null;
  if (days > 30) return "qua_han";
  if (days >= 20) return "sap_qua_han";
  return null;
}

// ─── "Xuất phiếu" Quyết định xử phạt theo mẫu Word Quyet_dinh_xu_phat_ATLD_new.docx ───
// (thay mẫu Excel Quyet_dinh_xu_phat_nha_thau_2.xlsx từ 06/11/2026.)
// Route /api/export-atld-penalty chỉ điền chỗ trống; dữ liệu gom ở đây.
//   Mã lỗi           = STT định mức (code) của dòng vi phạm.
//   Căn cứ quy định  = Số QĐ của hồ sơ (user chốt 09/10/2026), mọi dòng.
//   Số lần vi phạm   = Lần 1/2/3 chọn ở định mức (dòng gõ tay để trống).
//   Số lần tính      = SL (Số lượng của dòng; đơn vị "lần" thì 1); Thành tiền = SL × Đơn giá.
//   Căn cứ hợp đồng  = Số HĐ của nhà thầu trong Danh mục đối tác (finance_partner_contracts),
//                      CHỈ HĐ cùng dự án với hồ sơ, không khớp thì để trống; nhiều HĐ nối ", ".
//   Hồ sơ cũ chưa có danh sách vi phạm (147): xem oldRecordLines. Tổng luôn lấy Giá trị
//   phải khấu trừ.
export type PenaltyDecisionLine = {
  maLoi: string; noiDung: string; canCu: string; lanViPham: number | null;
  sl: number | null; mucPhat: number | null; thanhTien: number | null;
};

// Số HĐ của nhà thầu: CHỈ HĐ cùng dự án với hồ sơ (user chốt 09/10/2026 — không khớp dự
// án thì để trống "Hợp đồng số ……" ghi tay, không lấy HĐ dự án khác).
async function contractNos(p: Penalty): Promise<string> {
  if (!p.contractor_id || !p.project_code) return "";
  const { data } = await supabase
    .from("finance_partner_contracts")
    .select("contract_no, project_code, active")
    .eq("partner_id", p.contractor_id);
  const rows = ((data as { contract_no: string | null; project_code: string | null; active: boolean }[] | null) || [])
    .filter((c) => c.active && c.contract_no?.trim() && c.project_code === p.project_code);
  return Array.from(new Set(rows.map((c) => c.contract_no!.trim()))).join(", ");
}

// Hồ sơ cũ chỉ có ô Nội dung (gõ tay, chưa chọn từ định mức): mỗi dòng Nội dung một dòng
// bảng, tra tab Định mức xử phạt theo nội dung để lấy Mã lỗi + đơn giá (user yêu cầu
// 06/11/2026). Không biết lần thứ mấy nên lấy mức Lần 1, Số lần tính 1. Không khớp
// định mức thì để trống ô tiền cho ghi tay.
const normText = (v: string) => v.normalize("NFC").toLowerCase().replace(/[.,;:!?()"'\s]+/g, " ").trim();

async function oldRecordLines(p: Penalty): Promise<PenaltyDecisionLine[]> {
  const texts = (p.noi_dung || "").split("\n").map((t) => t.trim().replace(/^\d+[.)]\s*/, "")).filter(Boolean);
  const { rows } = texts.length ? await fetchRates() : { rows: [] as PenaltyRate[] };
  const priced = rows.filter((r) => r.muc_1 != null || r.muc_2 != null || r.muc_3 != null);
  const find = (t: string): PenaltyRate | null => {
    const code = /^(\d+(?:\.\d+){1,2})\s*[—–-]/.exec(t)?.[1];
    if (code) return priced.find((r) => r.code === code) ?? null;
    const n = normText(t);
    return (
      priced.find((r) => normText(r.noi_dung) === n) ??
      // Gần đúng: một bên chứa bên kia (bỏ qua nội dung định mức quá ngắn); chọn dòng dài nhất.
      priced
        .filter((r) => { const m = normText(r.noi_dung); return m.length >= 15 && (n.includes(m) || m.includes(n)); })
        .sort((a, b) => b.noi_dung.length - a.noi_dung.length)[0] ??
      null
    );
  };
  return texts.map((noiDung) => {
    const r = find(noiDung);
    const muc = r ? r.muc_1 ?? r.muc_2 ?? r.muc_3 : null;
    return {
      maLoi: r?.code || "",
      noiDung,
      canCu: p.so_quyet_dinh || "",
      lanViPham: r ? 1 : null,
      sl: r ? 1 : null,
      mucPhat: muc,
      thanhTien: muc,
    };
  });
}

export async function downloadPenaltyDecision(p: Penalty, hanKhacPhuc: string): Promise<void> {
  const soHopDong = await contractNos(p);

  const lines: PenaltyDecisionLine[] = p.vi_pham?.length
    ? p.vi_pham.map((l) => {
        const sl = perUnit(l) ? Math.max(1, l.so_luong || 1) : 1;
        return {
          maLoi: l.code || "",
          noiDung: l.noi_dung.trim(),
          canCu: p.so_quyet_dinh || "",
          lanViPham: l.rate_id ? l.lan : null,
          sl,
          mucPhat: l.rate_id ? l.muc[l.lan - 1] ?? l.muc.find((x) => x != null) ?? null : (Number(l.thanh_tien) || 0) / sl,
          thanhTien: Number(l.thanh_tien) || 0,
        };
      })
    : await oldRecordLines(p);

  const fileName = `Quyet_dinh_xu_phat_${p.ma_ho_so.replace(/[^a-zA-Z0-9.-]+/g, "_")}.docx`;
  const res = await apiFetch("/api/export-atld-penalty", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName,
      nhaThau: p.contractor_name,
      duAn: p.project_name || p.project_code || "",
      soHopDong,
      lines,
      tongTien: p.gia_tri_phai_tru,
      hanKhacPhuc,
    }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error === "template_not_found" ? "Không tìm thấy file mẫu Quyet_dinh_xu_phat_ATLD_new.docx." : j.error || `Lỗi xuất phiếu (${res.status})`);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
