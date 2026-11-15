"use client";

// ============================================================
// PHIẾU TRÌNH KÝ HỒ SƠ/VĂN BẢN (migration 050 + 051)
//
// Một chỗ duy nhất định nghĩa: máy trạng thái, ai được làm gì ở bước nào, và
// cách tính A-B-C-D. Trang và modal chỉ gọi lại — luật nằm rải rác ở nhiều
// component là cách chắc chắn nhất để giao diện nói một đằng CSDL chặn một nẻo.
//
// LƯU Ý: mọi luật ở đây CHỈ để dựng giao diện cho đúng. Chốt chặn thật nằm ở
// trigger `guard_signing_transition` và RLS của migration 050 — người dùng gọi
// thẳng REST API vẫn bị chặn.
// ============================================================

import { supabase } from "./supabase";
import { apiFetch } from "./apiClient";
import { emailFieldMatches } from "./emailMatch";
import type { ApprovalPermissions } from "./approvers";
import {
  fetchApprovalGroups, getApprovalGroupOfMember, isDepartmentManagerRole, normalizeName,
} from "./approvers";

export const SIGNING_BUCKET = "signing-dossiers";
const SIGNED_TTL = 60 * 60; // 1 giờ

// Một chặng Phó Giám đốc duy nhất: QLDA HOẶC KHĐT, ai xem trước cũng được
// (migration 053). Hai giá trị cũ giữ trong kiểu để phiếu lịch sử không vỡ.
export type SigningStatus =
  | "nhap"
  | "cho_cap1"           // migration 074 — bước Cấp 1 (Tổ trưởng / TP-PP / Admin)
  | "cho_pho_giam_doc"
  | "cho_giam_doc"
  | "cho_ke_toan"
  | "hoan_tat"
  | "tra_lai"
  | "cho_pgd_qlda"       // migration 074 — PGĐ Dự án (được chọn)
  | "cho_pgd_khdt"       // migration 074 — PGĐ KHĐT (được chọn)
  | "cho_phong_qlda"     // migration 093 — CHỈ có trong luồng Đơn đặt hàng
  | "cho_phong_vat_tu";  // migration 092 — CHỈ có trong luồng Đơn đặt hàng

export type SigningFile = { path: string; name: string; size?: number };

// ─── Bốn loại phiếu (migration 060 + 079 + 088) ───
// ho_so       : TL/BM/011    — trình MỘT ĐỢT THANH TOÁN của hợp đồng đã ký.
// hop_dong    : KHKT/BM/001  — trình NỘI DUNG HỢP ĐỒNG trước khi ký.
// chuyen_tien : HC-BM021/ĐNCT — đề nghị CHUYỂN TIỀN cho một dòng kế hoạch thu
//               chi. Không gắn hợp đồng/đợt, không có bảng A−B−C−D; thứ nó cần
//               mà hai loại kia không có là số tài khoản + ngân hàng người nhận.
// to_trinh    : TTr/Lodeza EOP    — xin CHỦ TRƯƠNG của Ban Giám đốc (mua sắm, nâng
//               cấp, đề xuất…). Không hợp đồng, không đợt, không tài khoản nhận;
//               chỉ có Căn cứ → Nội dung đề nghị → Chi phí dự kiến → Kiến nghị.
//               Luồng ĐÚNG 2 CẤP theo 3 ô ký trên tờ giấy (xem buildSigningRoute).
// phieu_yeu_cau : HC-BM 023/PYC — yêu cầu cấp vật tư/hàng hoá/thiết bị. Bảng 6
//                 cột, in ra Word.
// don_dat_hang  : KD/BM/001     — đơn đặt hàng cho dự án. Bảng 13 cột + ~15 ô
//                 đầu phiếu riêng, in ra EXCEL (route riêng, xem exportDocx).
export type SigningLoai =
  | "ho_so" | "hop_dong" | "chuyen_tien" | "to_trinh"
  | "phieu_yeu_cau" | "don_dat_hang" | "tam_ung";

// tam_ung : TCKT/BM/001 — Giấy đề nghị TẠM ỨNG. Gần như y hệt chuyen_tien (đơn vị
//           thụ hưởng + số tài khoản + số tiền + lý do, cùng luồng 4 cấp có Kế
//           toán), khác ở mẫu in và thêm ô "Thời gian thanh toán" — ô này dùng
//           lại cột `hang_muc`, không dựng cột mới. Số tiền ở `de_nghi_thanh_toan`.

// Hai loại dưới đây dùng CHUNG một luồng 2 cấp — gom lại một chỗ để thêm loại
// thứ ba không phải đi sửa 5 hàm rải rác. Đơn đặt hàng KHÔNG nằm trong nhóm này:
// luồng của nó dài hơn và bật/tắt được từng cấp (xem buildSigningRoute).
export const LOAI_HAI_CAP: SigningLoai[] = ["to_trinh", "phieu_yeu_cau"];

// ─── LUỒNG ĐƠN ĐẶT HÀNG (migration 092 + 093) — ROUTE_DON_DAT_HANG ───
// Khớp đúng 5 ô ký đánh số trên tờ KD/BM/001:
//   ➊ Người yêu cầu (người lập)
//   ➋ BĐH dự án — Chỉ huy trưởng / Chỉ huy phó   -> 'cho_cap1'        (LUÔN CÓ)
//   ➌ Phòng QLDA — TP/PP Quản lý dự án           -> 'cho_phong_qlda'  (ô tích)
//   ➍ Phó Giám đốc QLDA — ô "DUYỆT" trên giấy    -> 'cho_pgd_qlda'    (ô tích)
//   ➎ Phòng Vật tư xác nhận cuối                  -> 'cho_phong_vat_tu' (tự có
//      khi công ty đã cấp cờ cho ai đó)
//
// ⚠ KHÔNG có chặng Giám đốc: user chốt ô "DUYỆT" của tờ này là PHÓ Giám đốc phụ
// trách Dự án. Đừng thấy chữ "DUYỆT" mà nối vào 'cho_giam_doc'.
//
// ➋ không cần cờ mới: `resolveCap1` + `signing_is_dept_manager` vốn đã nhận
// "chỉ huy trưởng" / "chỉ huy phó", nên nhân viên thuộc một BĐH thì cấp 1 tự ra
// đúng người.

/**
 * Công ty có ai được cấp cờ xác nhận Phòng Vật tư không.
 *
 * Hỏi ĐÚNG MỘT LẦN lúc trình đơn rồi chốt vào `route` của chính đơn đó. Không
 * hỏi lại ở mỗi bước duyệt: cấp/gỡ cờ giữa chừng mà luồng đổi theo thì đơn đang
 * chạy sẽ nhảy bước, và người duyệt sẽ thấy tiến trình khác với lúc họ ký.
 *
 * Lỗi mạng -> trả false: thà đơn dừng ở Giám đốc (vẫn hoàn tất được) còn hơn
 * chèn một chặng mà có thể không ai giữ, khiến đơn treo vĩnh viễn.
 */
export async function hasSigningVatTuApprover(): Promise<boolean> {
  const { data, error } = await supabase
    .from("approval_permissions")
    .select("email")
    .eq("can_approve_signing_vat_tu", true)
    .limit(1);
  if (error) return false;
  return !!data?.length;
}

export const LOAI_META: Record<SigningLoai, { label: string; short: string; bieuMau: string; chip: string }> = {
  ho_so: {
    label: "Trình ký hồ sơ / văn bản",
    short: "Hồ sơ",
    bieuMau: "TL/BM/011",
    chip: "bg-blue-50 text-blue-700",
  },
  hop_dong: {
    label: "Trình ký hợp đồng",
    short: "Hợp đồng",
    bieuMau: "KHKT/BM/001",
    chip: "bg-violet-50 text-violet-700",
  },
  chuyen_tien: {
    label: "Đề nghị chuyển tiền",
    short: "Chuyển tiền",
    bieuMau: "HC-BM021/ĐNCT",
    chip: "bg-emerald-50 text-emerald-700",
  },
  to_trinh: {
    label: "Tờ trình",
    short: "Tờ trình",
    bieuMau: "TTr/Lodeza EOP",
    chip: "bg-indigo-50 text-indigo-700",
  },
  phieu_yeu_cau: {
    label: "Phiếu yêu cầu",
    short: "Yêu cầu",
    bieuMau: "HC-BM 023/PYC",
    chip: "bg-amber-50 text-amber-700",
  },
  don_dat_hang: {
    label: "Đơn đặt hàng",
    short: "Đặt hàng",
    bieuMau: "KD/BM/001",
    chip: "bg-teal-50 text-teal-700",
  },
  tam_ung: {
    label: "Giấy đề nghị tạm ứng",
    short: "Tạm ứng",
    bieuMau: "TCKT/BM/001",
    chip: "bg-rose-50 text-rose-700",
  },
};

/** Một dòng trong bảng vật tư. Phiếu yêu cầu dùng 6 khoá đầu, đơn đặt hàng dùng
 *  cả 13 — cùng một cột `vat_tu` (migration 091), khác bộ khoá theo loại phiếu. */
export type VatTuRow = {
  stt?: string; ten?: string; quyCach?: string; dvt?: string;
  // phiếu yêu cầu
  soLuong?: string; ngayCap?: string;
  // đơn đặt hàng
  dinhMuc?: string; luyKeTrong?: string; luyKeNgoai?: string; chenhLech?: string;
  dexuatTrong?: string; dexuatNgoai?: string; lyDo?: string; chiPhi?: string; ghiChu?: string;
};

/** Các ô đầu phiếu riêng của Đơn đặt hàng — lưu trong cột jsonb `chi_tiet`. */
// `chi_tiet` là cột jsonb tự do nên thêm khoá mới không cần migration — chỉ nối
// tên vào đây.
export const DDH_FIELDS = [
  "soDdh", "congTrinh", "donViYeuCau", "donViNhanNo", "diaChiNhan", "ngayDuKien",
  "nguoiNhanHang", "sdtNhanHang", "canBoKyThuat", "sdtKyThuat",
  "taiLieuKemTheo", "cdtThanhToan", "lyDoKhongThanhToan", "nguyenNhanPhatSinh",
] as const;
export type DdhField = (typeof DDH_FIELDS)[number];

/** Một dòng trong bảng so sánh A-B ↔ B-B′. Số dòng THÊM/BỚT được, không cố định 6. */
export type SoSanhRow = { stt: string; muc: string; ab: string; bb: string };

/** 6 dòng a–f theo đúng tờ mẫu — chỉ dùng làm GỢI Ý khi lập phiếu mới. */
export const SO_SANH_MAU: SoSanhRow[] = [
  { stt: "a)", muc: "Tạm ứng", ab: "", bb: "" },
  { stt: "b)", muc: "Nghiệm thu thanh toán", ab: "", bb: "" },
  { stt: "c)", muc: "Bảo đảm THHĐ", ab: "", bb: "" },
  { stt: "d)", muc: "Giữ bảo hành", ab: "", bb: "" },
  { stt: "e)", muc: "Giữ quyết toán", ab: "", bb: "" },
  { stt: "f)", muc: "Thuế vãng lai", ab: "", bb: "" },
];

export type SigningSubmission = {
  id: string;
  ma_phieu: string | null;

  don_vi: string | null;
  ve_viec: string | null;
  noi_dung_trinh: string | null;

  dot_so: number | null;
  chu_dau_tu: string | null;
  du_an: string | null;
  hop_dong_so: string | null;
  ngay_ky_hop_dong: string | null;
  goi_thau: string | null;
  gia_tri_hd: number | null;
  gia_tri_nghiem_thu: number | null;
  giu_bao_hanh: number | null;
  giu_lai_tung_lan: number | null;
  ty_le_giu_lai: number | null;
  khau_tru_tam_ung: number | null;
  ty_le_thu_hoi: number | null;
  de_nghi_thanh_toan: number | null;
  luy_ke_da_thanh_toan: number | null;
  tam_ung_con_lai: number | null;

  project_code: string | null;
  project_name: string | null;

  ai_ghi_chu: string | null;
  ai_thieu: string[];
  files: SigningFile[];

  // ─── migration 060 ───
  loai: SigningLoai;
  hang_muc: string | null;
  ben_a: string | null;
  ben_b: string | null;
  vat_percent: number | null;
  so_sanh: SoSanhRow[];

  // ─── migration 079: riêng phiếu 'chuyen_tien' ───
  so_tai_khoan: string | null;
  ngan_hang: string | null;

  // ─── migration 088: riêng phiếu 'to_trinh' ───
  so_to_trinh: string | null;
  can_cu: string | null;
  kien_nghi: string | null;

  // ─── migration 091: riêng 'phieu_yeu_cau' / 'don_dat_hang' ───
  vat_tu: VatTuRow[];
  chi_tiet: Partial<Record<DdhField, string>>;

  // ─── migration 092 + 093: vết ký hai cấp riêng của đơn đặt hàng ───
  // `pvt_`  = Phòng VẬT TƯ. KHÔNG phải `vat_tu_`: cột `vat_tu` ngay trên đã là
  //           bảng dòng vật tư, trùng tiền tố là đọc nhầm ngay.
  // `pqlda_`= PHÒNG QLDA. Khác hẳn `qlda_by`/`ykien_qlda` (có từ 050) — bộ đó
  //           là vết ký của PHÓ GIÁM ĐỐC QLDA, một cấp khác.
  ykien_pvt: string | null;
  pvt_by: string | null;
  pvt_at: string | null;
  ykien_pqlda: string | null;
  pqlda_by: string | null;
  pqlda_at: string | null;

  status: SigningStatus;

  // ─── migration 074: luồng động + cấp 1 ───
  route: SigningStatus[];        // danh sách bước của riêng phiếu
  cap1_email: string | null;     // email người duyệt cấp 1 (null = Admin duyệt thay)
  cap1_by: string | null;
  cap1_at: string | null;
  ykien_cap1: string | null;
  pgd_chon: "" | "qlda" | "khdt" | null;  // PGĐ người trình chọn

  ykien_qlda: string | null;
  qlda_by: string | null;
  qlda_at: string | null;
  ykien_khdt: string | null;
  khdt_by: string | null;
  khdt_at: string | null;
  ykien_giam_doc: string | null;
  giam_doc_by: string | null;
  giam_doc_at: string | null;
  ke_toan_by: string | null;
  ke_toan_at: string | null;
  ngay_chi: string | null;

  // ─── migration 094 ───
  // Ngày thanh toán / cấp phát của CHÍNH đợt này, người lập chọn trên form.
  // KHÁC `ngay_chi` ngay trên: đó là ngày Kế toán bấm xác nhận đã chi, chỉ phiếu
  // hồ sơ mới đi qua chặng Kế toán nên đơn đặt hàng không bao giờ có.
  ngay_dot: string | null;

  tra_lai_tu: string | null;
  tra_lai_boi: string | null;
  tra_lai_luc: string | null;
  tra_lai_ly_do: string | null;

  created_by: string;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
};

// ─── Nhãn + màu theo trạng thái ───
export const STATUS_META: Record<
  SigningStatus,
  { label: string; short: string; chip: string }
> = {
  nhap:             { label: "Nháp",              short: "Nháp",      chip: "bg-slate-100 text-slate-600" },
  cho_cap1:         { label: "Chờ Trưởng bộ phận", short: "Trưởng BP", chip: "bg-amber-50 text-amber-700" },
  cho_pho_giam_doc: { label: "Chờ Phó Giám đốc",  short: "Phó GĐ",    chip: "bg-amber-50 text-amber-700" },
  cho_giam_doc:     { label: "Chờ Giám đốc",      short: "Giám đốc",  chip: "bg-orange-50 text-orange-700" },
  cho_ke_toan:      { label: "Chờ Kế toán chi",   short: "Kế toán",   chip: "bg-blue-50 text-blue-700" },
  hoan_tat:         { label: "Hoàn tất",          short: "Hoàn tất",  chip: "bg-emerald-50 text-emerald-700" },
  tra_lai:          { label: "Bị trả lại",        short: "Trả lại",   chip: "bg-rose-50 text-rose-700" },
  // Phiếu cũ từ trước migration 053 — vẫn phải hiển thị được.
  cho_pgd_qlda:     { label: "Chờ Phó Giám đốc",  short: "Phó GĐ",    chip: "bg-amber-50 text-amber-700" },
  cho_pgd_khdt:     { label: "Chờ Phó Giám đốc",  short: "Phó GĐ",    chip: "bg-amber-50 text-amber-700" },
  cho_phong_qlda:   { label: "Chờ Phòng QLDA",     short: "P.QLDA",   chip: "bg-sky-50 text-sky-700" },
  cho_phong_vat_tu: { label: "Chờ Phòng Vật tư xác nhận", short: "P.Vật tư", chip: "bg-teal-50 text-teal-700" },
};

// Nhãn nút hành động của TỪNG CẤP. Hai Phó Giám đốc "xem xét" chứ không "phê
// duyệt" — phê duyệt là thẩm quyền của Giám đốc, còn Kế toán thì xác nhận đã
// chi. Gọi đúng tên theo quy trình giấy để người ký không hiểu nhầm thẩm quyền.
export const ACTION_LABEL: Partial<Record<SigningStatus, string>> = {
  cho_phong_qlda: "Đã duyệt",
  cho_phong_vat_tu: "Đã xác nhận",
  cho_pho_giam_doc: "Đã xem xét",
  cho_giam_doc: "Phê duyệt",
  cho_ke_toan: "Đã xác nhận",
  cho_pgd_qlda: "Đã xem xét",
  cho_pgd_khdt: "Đã xem xét",
};

// Câu mô tả việc vừa xảy ra, dùng cho email báo người lập.
export const EVENT_LABEL: Partial<Record<SigningStatus, string>> = {
  cho_phong_qlda: "Phòng QLDA đã duyệt",
  cho_phong_vat_tu: "Phòng Vật tư đã xác nhận",
  cho_pho_giam_doc: "Phó Giám đốc đã xem xét",
  cho_giam_doc: "Giám đốc đã phê duyệt",
  cho_ke_toan: "Kế toán đã xác nhận chi",
  cho_pgd_qlda: "Phó Giám đốc đã xem xét",
  cho_pgd_khdt: "Phó Giám đốc đã xem xét",
};

// Thứ tự đi của phiếu. Dùng cho thanh tiến trình và để suy ra bước kế tiếp —
// không viết tay "bước sau của X là Y" ở nhiều nơi.
//
// CHỈ MỘT chặng Phó Giám đốc: một trong hai vị (QLDA hoặc KHĐT) xem xét là
// chuyển thẳng Giám đốc, không phải qua đủ cả hai (migration 053).
export const FLOW: SigningStatus[] = [
  "cho_pho_giam_doc",
  "cho_giam_doc",
  "cho_ke_toan",
  "hoan_tat",
];

// Phiếu HỢP ĐỒNG hết luồng ngay sau Giám đốc: tờ KHKT/BM/001 chỉ có 3 ô ký
// (Người trình · Phụ trách · BLĐ Phê duyệt), không có chỗ cho Kế toán vì hợp
// đồng chưa phát sinh chi tiền.
//
// ⚠ Luật này PHẢI khớp với trigger `guard_signing_transition` ở migration 060.
// Lệch nhau thì giao diện đẩy phiếu sang một bước mà CSDL từ chối, hoặc tệ hơn:
// phiếu treo ở chặng không cấp nào giữ.
export const FLOW_HOP_DONG: SigningStatus[] = [
  "cho_pho_giam_doc",
  "cho_giam_doc",
  "hoan_tat",
];

// Chỉ dùng cho PHIẾU CŨ (route rỗng, lập trước 074). Phiếu 'chuyen_tien' và
// 'to_trinh' sinh sau 074 nên luôn có route — nhánh này không bao giờ chạm tới
// chúng, nhưng vẫn phải trả đúng luồng để không có góc nào trả undefined.
// Tờ trình / phiếu yêu cầu / đơn đặt hàng xếp cùng nhóm hợp đồng: dừng ở Giám
// đốc, không có chặng Kế toán.
export function flowOf(loai: SigningLoai): SigningStatus[] {
  return loai === "hop_dong" || loai === "don_dat_hang" || LOAI_HAI_CAP.includes(loai)
    ? FLOW_HOP_DONG : FLOW;
}

// Phiếu cũ nằm ở trạng thái trước 053 thì quy về chặng Phó Giám đốc, để
// nextStatus / thanh tiến trình không bị lệch.
export function normalizeStatus(s: SigningStatus): SigningStatus {
  return s === "cho_pgd_qlda" || s === "cho_pgd_khdt" ? "cho_pho_giam_doc" : s;
}

// `loai` BẮT BUỘC truyền vào, không để mặc định 'ho_so': quên truyền thì phiếu
// hợp đồng sẽ bị đẩy sang chặng Kế toán và trigger 060 chặn lại — lỗi chỉ lộ ra
// lúc người dùng bấm duyệt, rất khó lần.
export function nextStatus(cur: SigningStatus, loai: SigningLoai): SigningStatus | null {
  const flow = flowOf(loai);
  const i = flow.indexOf(normalizeStatus(cur));
  return i >= 0 && i < flow.length - 1 ? flow[i + 1] : null;
}

// ─── LUỒNG ĐỘNG THEO ROUTE (migration 074) ───
// Dựng danh sách bước cho phiếu MỚI: Cấp 1 → [PGĐ nếu chọn] → Giám đốc →
// [Kế toán nếu là phiếu chi tiền = loại 'ho_so']. Đây là chỗ DUY NHẤT quyết
// định luồng — trigger CSDL chỉ đi theo mảng này, không tự suy.
// PGĐ chọn TỰ DO (0, 1 hoặc 2 ô tích): đi qua lần lượt QLDA rồi KHĐT nếu tích cả
// hai. Thứ tự QLDA trước KHĐT khớp thứ tự ô ý kiến trên tờ phiếu (mục 3 rồi mục 4).
export function buildSigningRoute(
  loai: SigningLoai,
  pgdQlda: boolean,
  pgdKhdt: boolean,
  /** Chỉ dùng cho `don_dat_hang`: công ty có ai giữ cờ Phòng Vật tư không. */
  coPhongVatTu = false,
  /** Chỉ dùng cho `don_dat_hang`: người lập có tích ô "Phòng QLDA" không. */
  phongQlda = false
): SigningStatus[] {
  // TỜ TRÌNH · PHIẾU YÊU CẦU — luồng CỐ ĐỊNH 2 cấp, đúng các ô ký trên tờ giấy:
  // NGƯỜI LẬP → TRƯỞNG/PHỤ TRÁCH BỘ PHẬN (cấp 1) → THỦ TRƯỞNG ĐƠN VỊ / BAN LÃNH
  // ĐẠO (Giám đốc). Không nhận 2 ô tích PGĐ và không có chặng Kế toán — hai tờ
  // này không phát sinh chi tiền ngay.
  if (LOAI_HAI_CAP.includes(loai)) return ["cho_cap1", "cho_giam_doc"];

  // ĐƠN ĐẶT HÀNG — xem khối chú thích của ROUTE_DON_DAT_HANG ở trên:
  //   BĐH dự án (luôn có) → [Phòng QLDA] → [PGĐ QLDA] → [Phòng Vật tư xác nhận]
  // Hai cấp giữa bật/tắt bằng ô tích trên form; cấp cuối tự có khi công ty đã
  // cấp cờ cho ai đó (tra bằng hasSigningVatTuApprover ở nơi gọi).
  // KHÔNG có 'cho_giam_doc': ô "DUYỆT" trên tờ này là PHÓ Giám đốc QLDA.
  if (loai === "don_dat_hang") {
    const r: SigningStatus[] = ["cho_cap1"];
    if (phongQlda) r.push("cho_phong_qlda");
    if (pgdQlda) r.push("cho_pgd_qlda");
    if (coPhongVatTu) r.push("cho_phong_vat_tu");
    return r;
  }

  const r: SigningStatus[] = ["cho_cap1"];
  if (pgdQlda) r.push("cho_pgd_qlda");
  if (pgdKhdt) r.push("cho_pgd_khdt");
  r.push("cho_giam_doc");
  if (loai !== "hop_dong") r.push("cho_ke_toan"); // chỉ phiếu chi tiền
  return r;
}

// Các bước để hiển thị thanh tiến trình: route riêng của phiếu nếu có, không thì
// suy từ luồng cũ (phiếu trước 074).
export function stepsOfSubmission(s: SigningSubmission): SigningStatus[] {
  if (Array.isArray(s.route) && s.route.length) return s.route;
  return flowOf(s.loai).filter((x) => x !== "hoan_tat");
}

// Bước kế tiếp khi duyệt: theo route nếu có (bước cuối -> 'hoan_tat'); phiếu cũ
// dùng lại nextStatus. null = không xác định được (không nên xảy ra khi đang duyệt).
export function advanceStatus(s: SigningSubmission): SigningStatus | null {
  if (Array.isArray(s.route) && s.route.length) {
    const i = s.route.indexOf(s.status);
    if (i < 0) return null;
    return i < s.route.length - 1 ? s.route[i + 1] : "hoan_tat";
  }
  return nextStatus(s.status, s.loai);
}

// ─── Tính NGƯỜI DUYỆT CẤP 1 lúc lập/trình phiếu (migration 074) ───
// Thứ tự: Tổ trưởng (nếu người trình thuộc tổ) → Trưởng/Phó phòng cùng phòng
// (ưu tiên Trưởng phòng, loại chính người trình) → thiếu cả 3 thì Admin (email null).
// Trả EMAIL để trigger CSDL khớp danh tính người duyệt; kèm tên để hiển thị.
export type Cap1Result = { email: string | null; name: string | null };

export async function resolveCap1(params: {
  submitterName: string;
  submitterEmail: string;
  dept: string;
}): Promise<Cap1Result> {
  const { submitterName, submitterEmail, dept } = params;
  await fetchApprovalGroups();

  const { data: people } = await supabase
    .from("employees_directory")
    .select("name, email, role, department");
  const list = (people || []) as {
    name: string; email: string | null; role: string | null; department: string | null;
  }[];
  const emailOf = (name: string): string | null =>
    list.find((p) => normalizeName(p.name) === normalizeName(name))?.email || null;

  // 1) Tổ trưởng của tổ người trình.
  const group = getApprovalGroupOfMember(submitterName);
  if (group?.leader_name && normalizeName(group.leader_name) !== normalizeName(submitterName)) {
    return { email: emailOf(group.leader_name), name: group.leader_name };
  }

  // 2) Trưởng/Phó phòng cùng phòng (loại chính người trình).
  const d = normalizeName(dept);
  const mgrs = d
    ? list.filter((p) =>
        normalizeName(p.department) === d &&
        normalizeName(p.name) !== normalizeName(submitterName) &&
        (!submitterEmail || normalizeName(p.email || "") !== normalizeName(submitterEmail)) &&
        isDepartmentManagerRole(p.role))
    : [];
  const isTP = (r?: string | null) => {
    const x = normalizeName(r);
    return x.includes("truong phong") && !x.includes("pho truong phong");
  };
  const chosen = mgrs.find((p) => isTP(p.role)) || mgrs[0];
  if (chosen) return { email: chosen.email || null, name: chosen.name };

  // 3) Không có ai -> Admin duyệt thay.
  return { email: null, name: null };
}

// Cờ quyền giữ từng chặng.
//  - cho_pho_giam_doc: chặng GỘP của phiếu CŨ (một trong hai cờ) — giữ cho phiếu lịch sử.
//  - cho_pgd_qlda / cho_pgd_khdt: chặng PGĐ được CHỌN của phiếu mới (074) — mỗi bên một cờ.
//  - cho_cap1: KHÔNG theo cờ mà theo email lưu trên phiếu (xử lý riêng trong canActOn).
const STAGE_FLAGS: Partial<Record<SigningStatus, (keyof ApprovalPermissions)[]>> = {
  cho_pho_giam_doc: ["canApproveSigningQlda", "canApproveSigningKhdt"],
  cho_phong_qlda: ["canApproveSigningPhongQlda"],
  cho_phong_vat_tu: ["canApproveSigningVatTu"],
  cho_pgd_qlda: ["canApproveSigningQlda"],
  cho_pgd_khdt: ["canApproveSigningKhdt"],
  cho_giam_doc: ["canApproveSigningDirector"],
  cho_ke_toan:  ["canApproveSigningAccounting"],
};

// Tên cột trong approval_permissions, để tra email người giữ chặng kế tiếp.
const STAGE_COLUMNS: Partial<Record<SigningStatus, string[]>> = {
  cho_pho_giam_doc: ["can_approve_signing_qlda", "can_approve_signing_khdt"],
  cho_phong_qlda: ["can_approve_signing_phong_qlda"],
  cho_phong_vat_tu: ["can_approve_signing_vat_tu"],
  cho_pgd_qlda: ["can_approve_signing_qlda"],
  cho_pgd_khdt: ["can_approve_signing_khdt"],
  cho_giam_doc: ["can_approve_signing_director"],
  cho_ke_toan:  ["can_approve_signing_accounting"],
};

/**
 * Email của những người giữ cờ duyệt ở một bước — để báo "có phiếu chờ bạn".
 * Cột `email` có thể chứa NHIỀU địa chỉ ngăn bằng dấu phẩy (email công ty +
 * gmail), nên phải tách ra hết chứ không lấy mỗi cái đầu.
 */
export async function fetchStageApproverEmails(stage: SigningStatus): Promise<string[]> {
  // KHÔNG normalize: chặng PGĐ được chọn (cho_pgd_qlda/khdt) phải tra ĐÚNG một cột,
  // normalize sẽ quy về cho_pho_giam_doc rồi lấy cả hai — sai người nhận.
  const cols = STAGE_COLUMNS[stage];
  if (!cols?.length) return [];
  // Chặng Phó Giám đốc có 2 cột -> lấy dòng nào bật MỘT trong hai (or của
  // PostgREST), vì chỉ cần một vị xem xét là phiếu đi tiếp.
  const { data, error } = await supabase
    .from("approval_permissions")
    .select("email")
    .or(cols.map((c) => `${c}.eq.true`).join(","));
  if (error || !data) return [];
  return Array.from(
    new Set(
      data
        .flatMap((r: { email: string | null }) => (r.email || "").split(","))
        .map((e) => e.trim())
        .filter((e) => e.includes("@"))
    )
  );
}

/** Người này có phải cấp đang giữ phiếu không (được Duyệt / Trả lại). */
export function canActOn(
  s: SigningSubmission,
  perms: ApprovalPermissions,
  isAdmin: boolean,
  email?: string
): boolean {
  if (isAdmin) return true;
  // Cấp 1: khớp email đã lưu trên phiếu (không theo cờ). Admin duyệt thay khi
  // phiếu không tính được cấp 1 (cap1_email rỗng) — đã xử lý ở nhánh isAdmin trên.
  if (s.status === "cho_cap1") {
    return !!email && !!s.cap1_email &&
      s.cap1_email.toLowerCase().includes(email.toLowerCase());
  }
  // Các chặng theo cờ. KHÔNG normalize: cho_pgd_qlda/khdt phải khớp đúng một cờ.
  const flags = STAGE_FLAGS[s.status];
  return !!flags?.some((f) => !!perms[f]);
}

/**
 * Ý kiến của người này ghi vào ô nào trên tờ phiếu.
 * Tờ TL/BM/011 có hai ô riêng cho P.QLDA (mục 3) và P.KHĐT (mục 4). Gộp chặng
 * duyệt KHÔNG gộp hai ô đó — vị nào ký thì ghi vào ô của vị ấy, ô còn lại để
 * trắng đúng như tờ giấy. Người giữ cả hai cờ thì mặc định ghi ô QLDA.
 */
export function pgdOpinionField(perms: ApprovalPermissions): "qlda" | "khdt" {
  if (perms.canApproveSigningQlda) return "qlda";
  if (perms.canApproveSigningKhdt) return "khdt";
  return "qlda"; // Admin duyệt thay — ghi vào ô đầu
}

/** Người này có được sửa nội dung phiếu không. */
export function canEdit(
  s: SigningSubmission,
  email: string,
  isAdmin: boolean
): boolean {
  if (isAdmin) return true;
  const own = !!email && s.created_by.toLowerCase() === email.toLowerCase();
  return own && (s.status === "nhap" || s.status === "tra_lai");
}

/**
 * Người này có được XOÁ phiếu không.
 *
 * Chép ĐÚNG policy `signing_delete` (migration 050): Admin xoá được mọi phiếu;
 * người lập chỉ xoá được phiếu CÒN Ở TAY MÌNH — nháp hoặc bị trả lại. Phiếu đã
 * trình đi thì không, kể cả của chính mình: lúc đó nó đã nằm trong hộp việc của
 * cấp duyệt và có thể đã có vết ký.
 *
 * Trùng điều kiện với `canEdit` ở thời điểm này nhưng CỐ Ý tách hàm: sửa và xoá
 * là hai quyền khác nhau, gộp lại thì lần sau nới một bên là nới nhầm cả hai.
 * Đây chỉ là luật dựng giao diện — chốt chặn thật vẫn là policy RLS.
 */
export function canDelete(
  s: SigningSubmission,
  email: string,
  isAdmin: boolean
): boolean {
  if (isAdmin) return true;
  const own = !!email && s.created_by.toLowerCase() === email.toLowerCase();
  return own && (s.status === "nhap" || s.status === "tra_lai");
}

/** Các bước mà người này giữ quyền duyệt — dùng để đếm hộp việc cần xử lý. */
export function stagesOf(perms: ApprovalPermissions): SigningStatus[] {
  return (Object.keys(STAGE_FLAGS) as SigningStatus[]).filter((st) =>
    STAGE_FLAGS[st]!.some((f) => !!perms[f])
  );
}

// ─── Tính A-B-C-D ───
// Giữ đúng một bản duy nhất: form nhập, thẻ danh sách và route xuất Word đều
// phải ra cùng một con số, lệch nhau một chỗ là phiếu in ra khác phiếu đã duyệt.
export function tinhDeNghi(s: {
  gia_tri_nghiem_thu?: number | null;
  giu_bao_hanh?: number | null;
  giu_lai_tung_lan?: number | null;
  khau_tru_tam_ung?: number | null;
}): number {
  const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return n(s.gia_tri_nghiem_thu) - n(s.giu_bao_hanh) - n(s.giu_lai_tung_lan) - n(s.khau_tru_tam_ung);
}

/**
 * Đọc lỗi ra chuỗi cho người dùng.
 *
 * BẮT BUỘC có hàm này: supabase-js KHÔNG ném Error mà trả về object thuần
 * { message, details, hint, code }. Viết `e instanceof Error ? e.message :
 * String(e)` thì rơi vào nhánh String() và hiện đúng chữ "[object Object]" —
 * người dùng không biết lỗi gì, mình cũng không lần ra được.
 *
 * Kèm `details`/`hint` vì lỗi RLS và lỗi trigger của Postgres hay nằm ở đó chứ
 * không nằm trong `message`.
 */
export function errText(e: unknown): string {
  if (!e) return "Lỗi không rõ.";
  if (typeof e === "string") return e;
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "object") {
    const o = e as Record<string, unknown>;
    const parts = [o.message, o.details, o.hint]
      .filter((x): x is string => typeof x === "string" && x.trim() !== "");
    if (parts.length) {
      const code = typeof o.code === "string" && o.code ? ` (mã ${o.code})` : "";
      return parts.join(" — ") + code;
    }
    try {
      return JSON.stringify(e);
    } catch {
      return "Lỗi không đọc được.";
    }
  }
  return String(e);
}

export const fmtMoney = (v: number | null | undefined): string =>
  typeof v === "number" && Number.isFinite(v)
    ? new Intl.NumberFormat("vi-VN").format(Math.round(v))
    : "—";

export const fmtDateTime = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleString("vi-VN", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
        timeZone: "Asia/Ho_Chi_Minh",
      })
    : "—";

/** Ngày-tháng gọn cho danh sách (03/09). Luôn ép về giờ VN — `created_at` là
 *  timestamptz, để máy tự chọn múi giờ thì phiếu lập tối muộn nhảy sang hôm sau. */
export const fmtNgayNgan = (iso: string | null): string =>
  iso
    ? new Intl.DateTimeFormat("vi-VN", {
        day: "2-digit", month: "2-digit", timeZone: "Asia/Ho_Chi_Minh",
      }).format(new Date(iso))
    : "—";

// ─── BA CỘT SỐ LIỆU CỦA DANH SÁCH ───
//
//     Tổng giá trị HĐ / Dự toán  −  đã TT / cấp phát  =  Còn lại
//
// Chỉ HAI loại phiếu đi hết công thức này, vì chỉ hai loại đó có khái niệm ĐỢT:
//
//   hồ sơ        -> Giá trị HĐ  − tổng các đợt thanh toán của cùng số HĐ
//   đơn đặt hàng -> Tổng dự toán − tổng các lần cấp phát của cùng dự án+hạng mục
//
// Bốn loại còn lại KHÔNG có hợp đồng nhiều đợt, nên cột đầu vẫn hiện con số
// đáng nhớ của riêng chúng và hai cột sau để trống:
//
//   hợp đồng     -> Giá trị HĐ       · `gia_tri_hd`
//   chuyển tiền  -> Số tiền chuyển   · `de_nghi_thanh_toan`
//   tờ trình     -> Chi phí dự kiến  · `de_nghi_thanh_toan`
//   phiếu yêu cầu-> số dòng vật tư   · không có ô tiền nào trong form
//
// (Trước 23/09/2026 cột đầu luôn gọi `tinhDeNghi()` — hàm cộng trừ 4 ô tiền của
// RIÊNG phiếu hồ sơ. Năm loại kia không có 4 ô đó nên cả bốn đều null và hàm
// trả về đúng số 0, in ra bảng thành "0", đọc như phiếu 0 đồng.)

/** Định dạng KHỐI LƯỢNG — khác `fmtMoney` ở chỗ GIỮ phần lẻ. fmtMoney gọi
 *  Math.round vì tiền Việt không có hào, dùng lại cho khối lượng thì 12,5 m3
 *  in ra thành 13. */
const fmtKhoiLuong = (v: number): string =>
  new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(v);

/** Đọc một ô số lưu dạng CHỮ (bảng vật tư, ô Tổng dự toán). Theo đúng quy ước
 *  gõ số của form: dấu chấm là phân cách nghìn, dấu phẩy là thập phân.
 *
 *  ⚠ Phải KHỚP với phép đọc số trong `signing_dot_list()` (migration 094) —
 *  lệch nhau thì cột "còn lại" tính ở đây khác con số hàm SQL trả về. */
export function docSoVN(s: string | undefined | null): number | null {
  const t = (s || "").replace(/[^\d.,-]/g, "").replace(/\./g, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
const soVatTu = docSoVN;

/**
 * Cộng các cột số của BẢNG VẬT TƯ, gom theo ĐƠN VỊ TÍNH.
 *
 * ⚠ KHÔNG dồn tất cả vào một số: đây là KHỐI LƯỢNG, mỗi dòng mang đơn vị riêng
 * (kg thép, m3 bê tông, mét cọc cừ…). Cộng chung thì ra một con số vô nghĩa.
 * Nên gom theo ĐVT, lấy nhóm nhiều dòng nhất làm số hiện ra, phần còn lại đẩy
 * vào tooltip — người xem vẫn biết có bao nhiêu nhóm mà không bị đọc nhầm.
 *
 * `cong` / `tru` nhận danh sách khoá cột để ba cột của danh sách dùng CHUNG một
 * phép gom: dự toán = (4), cấp phát = (5a)+(5b), còn lại = (4)−(5a)−(5b). Cùng
 * một hàm nên ba cột chắc chắn gom cùng kiểu, đọc ngang ra đúng phép trừ.
 */
export function gomTheoDvt(
  rows: VatTuRow[],
  cong: (keyof VatTuRow)[],
  tru: (keyof VatTuRow)[] = []
): { tong: number | null; dvt: string; soNhom: number; chiTiet: string } {
  const nhom = new Map<string, { tong: number; dong: number }>();
  for (const r of rows || []) {
    let v = 0;
    let co = false;
    for (const k of cong) { const x = soVatTu(r[k]); if (x !== null) { v += x; co = true; } }
    for (const k of tru)  { const x = soVatTu(r[k]); if (x !== null) { v -= x; co = true; } }
    if (!co) continue;
    const dvt = (r.dvt || "").trim();
    const cu = nhom.get(dvt) || { tong: 0, dong: 0 };
    nhom.set(dvt, { tong: cu.tong + v, dong: cu.dong + 1 });
  }
  if (nhom.size === 0) return { tong: null, dvt: "", soNhom: 0, chiTiet: "" };
  const xep = [...nhom.entries()].sort((a, b) => b[1].dong - a[1].dong);
  const chiTiet = xep
    .map(([dvt, v]) => `${fmtKhoiLuong(v.tong)}${dvt ? ` ${dvt}` : ""} (${v.dong} dòng)`)
    .join("\n");
  return { tong: xep[0][1].tong, dvt: xep[0][0], soNhom: nhom.size, chiTiet };
}

/** Ba cột của đơn đặt hàng, theo đúng số hiệu cột trên tờ biểu mẫu KD/BM/001. */
const DDH_DU_TOAN: (keyof VatTuRow)[] = ["dinhMuc"];                   // (4)
const DDH_CAP_PHAT: (keyof VatTuRow)[] = ["luyKeTrong", "luyKeNgoai"]; // (5a) + (5b)

/** Ô số + nhãn cho một phép gom theo ĐVT. Nhãn mang luôn ĐVT vì con số này là
 *  khối lượng — thiếu đơn vị thì "50" không nói được gì. */
function oKhoiLuong(
  g: ReturnType<typeof gomTheoDvt>,
  nhanGoc: string,
  tenCot: string
): SoLieuChinh {
  if (g.tong === null) return O_TRONG;
  const dvt = g.dvt ? ` · ${g.dvt}` : "";
  return {
    so: fmtKhoiLuong(g.tong),
    nhan: g.soNhom > 1 ? `${nhanGoc}${dvt} · +${g.soNhom - 1} ĐVT` : `${nhanGoc}${dvt}`,
    tip: g.soNhom > 1
      ? `${tenCot} theo từng đơn vị tính:\n${g.chiTiet}`
      : `${tenCot}: ${g.chiTiet}`,
  };
}

/** Một ô "số liệu chính": con số + nhãn nhỏ nói đó là số gì + tooltip (nếu có). */
export type SoLieuChinh = { so: string; nhan: string; tip?: string };

const O_TRONG: SoLieuChinh = { so: "—", nhan: "" };

/** Hai loại phiếu chạy đủ công thức "tổng − các đợt = còn lại". */
export const LOAI_CO_DOT: SigningLoai[] = ["ho_so", "don_dat_hang"];

/**
 * Tổng giá trị của hợp đồng / hạng mục mà phiếu này thuộc về — MẪU SỐ của cả
 * phép tính. Không phải số tiền của riêng đợt này.
 *
 * ⚠ HAI LOẠI PHIẾU DÙNG HAI ĐƠN VỊ KHÁC NHAU, cố ý:
 *   · hồ sơ        -> TIỀN     (`gia_tri_hd`)
 *   · đơn đặt hàng -> KHỐI LƯỢNG, cộng cột "(4) Định mức KL theo dự toán" của
 *                     bảng vật tư. Tờ KD/BM/001 quản theo khối lượng chứ không
 *                     theo tiền — không có ô tiền nào ở đầu phiếu.
 * Mỗi DÒNG của danh sách tự nhất quán (tổng, cấp phát, còn lại cùng đơn vị),
 * nên không bao giờ có chuyện trừ tiền cho khối lượng.
 */
export function tongGiaTri(s: SigningSubmission): number | null {
  if (s.loai === "don_dat_hang") return gomTheoDvt(s.vat_tu || [], DDH_DU_TOAN).tong;
  return typeof s.gia_tri_hd === "number" && Number.isFinite(s.gia_tri_hd)
    ? s.gia_tri_hd : null;
}

/** Cột 1 — "Tổng giá trị HĐ / Dự toán". */
export function soLieuChinh(s: SigningSubmission): SoLieuChinh {
  // Không có số thì KHÔNG kèm nhãn: một dấu gạch kèm chữ "GIÁ TRỊ HĐ" bên dưới
  // đọc như giá trị hợp đồng bằng 0.
  const tien = (v: number | null | undefined, nhan: string): SoLieuChinh =>
    typeof v === "number" && Number.isFinite(v)
      ? { so: fmtMoney(v), nhan }
      : O_TRONG;

  switch (s.loai) {
    case "don_dat_hang":
      return oKhoiLuong(gomTheoDvt(s.vat_tu || [], DDH_DU_TOAN),
        "Dự toán", "Định mức KL theo dự toán (4)");
    case "chuyen_tien":
      return tien(s.de_nghi_thanh_toan, "Số chuyển");
    case "tam_ung":
      return tien(s.de_nghi_thanh_toan, "Tạm ứng");
    case "to_trinh":
      return tien(s.de_nghi_thanh_toan, "Chi phí DK");
    case "phieu_yeu_cau": {
      const n = (s.vat_tu || []).length;
      return n ? { so: String(n), nhan: "dòng vật tư" } : O_TRONG;
    }
    default:
      // 'ho_so' và 'hop_dong' — cùng một ô Giá trị hợp đồng.
      return tien(s.gia_tri_hd, "Giá trị HĐ");
  }
}

// ─── CÁC ĐỢT THANH TOÁN / CẤP PHÁT (migration 094) ───

/** Một đợt = một phiếu anh em, do hàm SQL `signing_dot_list` trả về. */
export type DotRow = {
  khoa: string;
  id: string;
  ma_phieu: string | null;
  loai: SigningLoai;
  dot_so: number | null;
  so_tien: number | null;
  ngay: string | null;
  status: SigningStatus;
};

/** Gom các đợt về cùng một hợp đồng / hạng mục.
 *
 *  ⚠ Phải sinh ra ĐÚNG chuỗi mà `signing_dot_list()` sinh ở phía SQL — lệch một
 *  dấu cách là không khớp nhóm nào và cột đợt rỗng trắng. */
export function khoaNhomDot(s: SigningSubmission): string | null {
  // CHỈ phiếu hồ sơ. Đơn đặt hàng KHÔNG gom theo phiếu anh em: cột (5a)/(5b)
  // trên chính phiếu đã là luỹ kế đã thực hiện của cả hạng mục, cộng thêm các
  // lần đặt hàng trước là đếm hai lần.
  //
  // Hàm SQL `signing_dot_list` (094) vẫn có nhánh tính cho đơn đặt hàng, nhưng
  // vì `p_keys` không bao giờ chứa khoá 'DDH|…' nữa nên nhánh đó nằm im. Cố ý
  // KHÔNG sửa lại migration đã chạy chỉ để dọn một nhánh vô hại.
  if (s.loai !== "ho_so") return null;
  const hd = (s.hop_dong_so || "").trim().toLowerCase();
  return hd ? `HS|${hd}` : null;
}

/**
 * Nạp các đợt cho cả bảng trong MỘT lần gọi.
 *
 * Gọi hàm SQL chứ không gom từ `rows` đã tải về: policy `signing_select` (074)
 * cho nhân viên thường chỉ thấy phiếu của chính mình, gom ở client thì đợt do
 * người khác lập bị bỏ sót và "còn lại" báo cao hơn thực tế. Cùng lý do khiến
 * `luy_ke_da_thanh_toan` phải là SECURITY DEFINER.
 */
export async function fetchDotList(keys: string[]): Promise<Map<string, DotRow[]>> {
  const m = new Map<string, DotRow[]>();
  if (!keys.length) return m;
  const { data, error } = await supabase.rpc("signing_dot_list", { p_keys: keys });
  if (error) throw error;
  for (const r of (data || []) as DotRow[]) {
    const arr = m.get(r.khoa);
    if (arr) arr.push(r); else m.set(r.khoa, [r]);
  }
  return m;
}

const tongDot = (ds: DotRow[]): number =>
  ds.reduce((t, d) => t + (typeof d.so_tien === "number" && Number.isFinite(d.so_tien) ? d.so_tien : 0), 0);

/**
 * Số tiền của CHÍNH phiếu này — đề nghị thanh toán đợt này, hoặc giá trị đặt
 * hàng lần này.
 *
 * Tính TẠI CHỖ từ dòng đang hiển thị, KHÔNG lấy từ `signing_dot_list`. Hàm SQL
 * đó cố ý bỏ phiếu `nhap` và `tra_lai` (chưa trình thì chưa tiêu tiền hợp đồng),
 * nên nếu lấy từ đó thì phiếu đang soạn dở sẽ hiện ô trống — mà đó lại đúng lúc
 * người lập cần thấy nhất: nhập xong số tiền là muốn biết ngay hợp đồng còn lại
 * bao nhiêu.
 */
export function deNghiDot(s: SigningSubmission): number | null {
  // Đơn đặt hàng: cộng "(5a) Đã TH trong định mức" + "(5b) Đã TH ngoài định
  // mức". Hai cột này đã là LUỸ KẾ ĐÃ THỰC HIỆN của cả hạng mục — người lập
  // chép sang mỗi lần đặt hàng — nên KHÔNG cộng thêm các lần đặt hàng trước
  // nữa, cộng là đếm hai lần.
  if (s.loai === "don_dat_hang") return gomTheoDvt(s.vat_tu || [], DDH_CAP_PHAT).tong;
  if (s.loai !== "ho_so") return null;
  const v = s.de_nghi_thanh_toan ?? tinhDeNghi(s);
  return Number.isFinite(v) && v !== 0 ? v : null;
}

/** Danh sách đợt ANH EM — các đợt khác của cùng hợp đồng, đã bỏ chính dòng này
 *  ra để không cộng đôi khi phiếu đã trình đi.
 *
 *  Chỉ phiếu HỒ SƠ mới có: mỗi phiếu hồ sơ là một đợt riêng nên phải gom các
 *  phiếu anh em lại. Đơn đặt hàng thì luỹ kế đã nằm sẵn trong cột (5a)/(5b) của
 *  chính phiếu, gom thêm là cộng đôi — nên `khoaNhomDot` trả null cho nó. */
function dotKhac(s: SigningSubmission, dot: Map<string, DotRow[]>): DotRow[] {
  const khoa = khoaNhomDot(s);
  return ((khoa && dot.get(khoa)) || []).filter((d) => d.id !== s.id);
}

// Chỉ phiếu HỒ SƠ đi tới các hàm dưới đây — đơn đặt hàng đã thoát ra ở nhánh
// riêng, đọc thẳng bảng vật tư của chính nó. Nên luôn gọi là "đợt".
function keDot(ds: DotRow[]): string {
  return ds
    .map((d) => {
      const ten = d.dot_so != null ? `Đợt ${d.dot_so}` : (d.ma_phieu || "—");
      return `${ten} · ${d.ngay ? ddmmyyyyISO(d.ngay) : "chưa có ngày"} · ${fmtMoney(d.so_tien)}` +
        ` · ${STATUS_META[d.status]?.short || d.status}`;
    })
    .join("\n");
}

/**
 * Cột 2 — "Đề nghị TT / Cấp phát": số tiền của RIÊNG dòng này.
 *
 * Nhãn nhỏ nói đây là đợt thứ mấy; nếu hợp đồng đã có đợt khác thì nói luôn để
 * người đọc biết con số trên KHÔNG phải tất cả những gì đã chi — chi tiết các
 * đợt kia nằm trong tooltip.
 */
export function deNghiCapPhat(s: SigningSubmission, dot: Map<string, DotRow[]>): SoLieuChinh {
  if (!LOAI_CO_DOT.includes(s.loai)) return O_TRONG;
  if (s.loai === "don_dat_hang") {
    return oKhoiLuong(gomTheoDvt(s.vat_tu || [], DDH_CAP_PHAT),
      "Cấp phát", "Đã TH trong + ngoài định mức (5a+5b)");
  }
  const v = deNghiDot(s);
  if (v === null) {
    return { so: "—", nhan: "", tip: "Chưa có số tiền đề nghị thanh toán cho đợt này." };
  }
  const khac = dotKhac(s, dot);
  const nhan = s.dot_so != null ? `đợt ${s.dot_so}` : "đợt";
  return {
    so: fmtMoney(v),
    nhan: khac.length ? `${nhan} · +${khac.length} đợt khác` : nhan,
    tip: khac.length
      ? `Đợt này: ${fmtMoney(v)}\n\nCác đợt khác của cùng hợp đồng ` +
        `(${fmtMoney(tongDot(khac))}):\n${keDot(khac)}`
      : undefined,
  };
}

/**
 * Cột 3 — "Còn lại" = tổng giá trị − các đợt khác − đợt này.
 *
 * Trừ CẢ đợt này nên khi hợp đồng mới có một đợt, ba cột đọc ngang đúng thành
 * một phép trừ: tổng − đề nghị = còn lại. Có nhiều đợt thì nhãn nhỏ ghi rõ đã
 * trừ mấy đợt, để không ai đọc nhầm thành phép trừ hai số trên cùng dòng.
 * Âm là ĐÃ VƯỢT hợp đồng — phải thấy được ngay.
 */
export function conLai(s: SigningSubmission, dot: Map<string, DotRow[]>): SoLieuChinh & { am?: boolean } {
  if (!LOAI_CO_DOT.includes(s.loai)) return O_TRONG;

  // Đơn đặt hàng: trừ NGAY TRÊN TỪNG DÒNG vật tư rồi mới gom theo ĐVT —
  // (4) − (5a) − (5b), đúng nghĩa cột "(6) Chênh lệch còn lại" của tờ mẫu.
  // Không lấy thẳng cột (6) người lập gõ tay: gõ lệch một dòng là ba cột của
  // danh sách không còn cộng trừ ra nhau, mà bảng này bán được là nhờ đọc ngang
  // ra một phép trừ.
  if (s.loai === "don_dat_hang") {
    const g = gomTheoDvt(s.vat_tu || [], DDH_DU_TOAN, DDH_CAP_PHAT);
    if (g.tong === null) {
      return { so: "—", nhan: "", tip: "Bảng vật tư chưa có số ở cột (4) hay (5a)/(5b)." };
    }
    const o = oKhoiLuong(g, "còn lại", "Chênh lệch còn lại (4)−(5a)−(5b)");
    // Nhãn của cột này KHÔNG lặp lại chữ "còn lại" (tiêu đề cột đã nói rồi), chỉ
    // giữ đơn vị tính. Nhưng phần "+N ĐVT" thì PHẢI giữ: thiếu nó thì phiếu có
    // nhiều đơn vị đọc thành như thể con số trên là toàn bộ phần còn lại.
    const them = g.soNhom > 1 ? ` · +${g.soNhom - 1} ĐVT` : "";
    return g.tong < 0
      ? { ...o, nhan: `đã vượt${them}`, am: true }
      : { ...o, nhan: `${g.dvt}${them}`.replace(/^ · /, ""), am: false };
  }

  const tong = tongGiaTri(s);
  if (tong === null) {
    return { so: "—", nhan: "", tip: "Chưa nhập ô \"Giá trị HĐ\" nên không tính được còn lại." };
  }
  const khac = dotKhac(s, dot);
  const nay = deNghiDot(s) ?? 0;
  const daChi = tongDot(khac) + nay;
  const con = tong - daChi;
  const soDot = khac.length + (nay ? 1 : 0);
  return {
    so: fmtMoney(con),
    nhan: con < 0 ? "đã vượt" : khac.length ? `sau ${soDot} đợt` : "",
    am: con < 0,
    tip: `${fmtMoney(tong)} − ${fmtMoney(daChi)} (${soDot} đợt) = ${fmtMoney(con)}` +
      (khac.length ? `\n\nCác đợt khác:\n${keDot(khac)}` : ""),
  };
}

/** `2026-09-23` -> `23/09/2026`. Hàm SQL trả DATE nên không có múi giờ để lệch. */
const ddmmyyyyISO = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
};

/**
 * "Đang ở bước mấy trên tổng mấy bước" — vd `2/4`.
 *
 * Cần thiết vì số cấp duyệt KHÔNG cố định: tuỳ loại phiếu và tuỳ ô tích PGĐ mà
 * cùng một chip "Phó GĐ" có thể là bước 2/3 hay 2/4. Đọc thẳng từ `route` của
 * từng phiếu (migration 074) nên không phải suy đoán.
 *
 * Trả "" khi phiếu không nằm trong luồng (nháp, trả lại, hoàn tất) — mấy trạng
 * thái đó chip đã nói đủ, gắn thêm số bước chỉ gây rối.
 */
export function tienDoBuoc(s: SigningSubmission): string {
  const steps = stepsOfSubmission(s);
  if (!steps.length) return "";
  // Phiếu cũ (route rỗng) mang trạng thái trước 053 -> phải quy đổi mới khớp
  // được với danh sách bước suy ra từ FLOW.
  let i = steps.indexOf(s.status);
  if (i < 0) i = steps.indexOf(normalizeStatus(s.status));
  return i < 0 ? "" : `${i + 1}/${steps.length}`;
}

// ─── Đọc ───
const COLS = "*";

export async function fetchSubmissions(): Promise<SigningSubmission[]> {
  const { data, error } = await supabase
    .from("signing_submissions")
    .select(COLS)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(normalizeRow);
}

/**
 * Xoá hẳn một phiếu trình ký.
 *
 * Chốt chặn thật là policy `signing_delete` (migration 050): chỉ Admin, hoặc
 * người lập xoá phiếu còn ở 'nhap'/'tra_lai'. Nút trên UI chỉ hiện với Admin —
 * ẩn nút là cho gọn mắt, không phải cơ chế bảo vệ.
 *
 * RLS chặn thì Postgres KHÔNG báo lỗi, chỉ xoá 0 dòng. Vì vậy phải yêu cầu trả
 * dòng vừa xoá về (`select()`) rồi tự kiểm tra — nếu rỗng thì báo không đủ
 * quyền, đừng để người dùng tưởng đã xoá xong.
 *
 * Tệp hồ sơ trong bucket signing-dossiers KHÔNG xoá theo — cố ý giữ, dọn kho
 * là việc riêng.
 */
export async function deleteSubmission(id: string): Promise<void> {
  const { data, error } = await supabase
    .from("signing_submissions")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error("Không xoá được phiếu — tài khoản của bạn không đủ quyền xoá.");
  }
}

/**
 * Nhân đôi một phiếu để sửa nhanh thành phiếu mới.
 *
 * CHỈ chép phần NGHIỆP VỤ (hợp đồng, giá trị, số tiền, tệp hồ sơ). KHÔNG chép:
 *   - `ma_phieu`  : trigger tự sinh mã mới, chép sang là đụng ràng buộc unique.
 *   - toàn bộ vết duyệt (ý kiến, người duyệt, mốc thời gian, lý do trả lại) —
 *     phiếu mới chưa ai duyệt, mang vết cũ sang là ghi khống lịch sử.
 *   - `ai_ghi_chu` / `ai_thieu` : nhận xét của AI về BỘ HỒ SƠ ĐÃ QUÉT của phiếu
 *     cũ, dán sang phiếu mới thì không còn đúng nữa.
 *
 * `dot_so` chép NGUYÊN: chỉ số về `nhap` nên không vướng unique index
 * (uq_signing_hopdong_dot bỏ qua trạng thái nhap/tra_lai). Người lập tự sửa
 * sang đợt cần làm.
 *
 * `files` chép tham chiếu, KHÔNG nhân bản tệp trong kho: hai phiếu cùng trỏ vào
 * một đường dẫn. An toàn vì xoá phiếu không đụng tới tệp trong kho — xem
 * `deleteSubmission`, nó chỉ xoá dòng.
 */
export async function duplicateSubmission(
  src: SigningSubmission,
  email: string,
  name: string
): Promise<SigningSubmission> {
  const payload = {
    don_vi: src.don_vi,
    ve_viec: src.ve_viec,
    noi_dung_trinh: src.noi_dung_trinh,
    dot_so: src.dot_so,
    chu_dau_tu: src.chu_dau_tu,
    du_an: src.du_an,
    hop_dong_so: src.hop_dong_so,
    ngay_ky_hop_dong: src.ngay_ky_hop_dong,
    goi_thau: src.goi_thau,
    gia_tri_hd: src.gia_tri_hd,
    gia_tri_nghiem_thu: src.gia_tri_nghiem_thu,
    giu_bao_hanh: src.giu_bao_hanh,
    giu_lai_tung_lan: src.giu_lai_tung_lan,
    ty_le_giu_lai: src.ty_le_giu_lai,
    khau_tru_tam_ung: src.khau_tru_tam_ung,
    ty_le_thu_hoi: src.ty_le_thu_hoi,
    de_nghi_thanh_toan: src.de_nghi_thanh_toan,
    luy_ke_da_thanh_toan: src.luy_ke_da_thanh_toan,
    tam_ung_con_lai: src.tam_ung_con_lai,
    project_code: src.project_code,
    project_name: src.project_name,
    files: src.files,

    // ─── PHẢI CHÉP LOẠI PHIẾU VÀ NỘI DUNG RIÊNG CỦA NÓ ───
    // Thiếu `loai` thì Postgres lấy mặc định của cột là 'ho_so' (migration 060),
    // nên nhân đôi một đơn đặt hàng / tờ trình / hợp đồng lại đẻ ra phiếu HỒ SƠ
    // trắng trơn — mất bảng vật tư, mất bảng so sánh A-B, mất số tài khoản thụ
    // hưởng. Lỗi im lặng: không báo gì, người lập chỉ thấy form mở ra sai loại.
    loai: src.loai,
    hang_muc: src.hang_muc,
    // 060 — phiếu hợp đồng
    ben_a: src.ben_a,
    ben_b: src.ben_b,
    vat_percent: src.vat_percent,
    so_sanh: src.so_sanh,
    // 079 — đề nghị chuyển tiền
    so_tai_khoan: src.so_tai_khoan,
    ngan_hang: src.ngan_hang,
    // 088 — tờ trình
    so_to_trinh: src.so_to_trinh,
    can_cu: src.can_cu,
    kien_nghi: src.kien_nghi,
    // 091 — phiếu yêu cầu / đơn đặt hàng
    vat_tu: src.vat_tu,
    chi_tiet: src.chi_tiet,
    // 074 — chép ROUTE để form mở ra còn giữ nguyên các ô tích cấp duyệt (form
    // suy ô tích từ route chứ không từ cột `pgd_chon`). KHÔNG chép `cap1_email`:
    // người duyệt cấp 1 tính lại theo người lập bản sao, chép sang là gửi phiếu
    // cho cấp trưởng của người khác.
    route: src.route,
    pgd_chon: src.pgd_chon,

    // KHÔNG chép `ngay_dot` (094) và `ngay_chi`: bản sao là một đợt MỚI, chưa
    // thanh toán / cấp phát ngày nào.
    status: "nhap",
    created_by: email,
    created_by_name: name || null,
  };

  const { data, error } = await supabase
    .from("signing_submissions")
    .insert([payload])
    .select(COLS)
    .single();
  if (error) throw error;
  return normalizeRow(data as unknown as Record<string, unknown>);
}

// ─── Đính kèm thêm tệp cho một phiếu đã có ───
// Dùng cho cột "File gốc" ngoài danh sách: tải lên rồi NỐI vào mảng `files`,
// không ghi đè — phiếu thường có nhiều tệp, ghi đè là mất bộ hồ sơ đã tải.
export async function appendDossierFiles(
  row: SigningSubmission,
  picked: File[]
): Promise<SigningFile[]> {
  const added: SigningFile[] = [];
  for (const f of picked) {
    added.push(await uploadDossierFile(f));
  }
  const files = [...row.files, ...added];
  const { error } = await supabase
    .from("signing_submissions")
    .update({ files })
    .eq("id", row.id);
  if (error) throw error;
  return files;
}

/**
 * Gỡ một tệp khỏi phiếu.
 *
 * CHỈ xoá THAM CHIẾU trong cột `files`, KHÔNG xoá tệp trong kho. Lý do: phiếu
 * nhân đôi dùng chung đường dẫn với phiếu gốc (xem `duplicateSubmission`), nên
 * xoá vật lý sẽ làm hỏng luôn tệp của phiếu kia — mà từ đây không cách nào biết
 * còn phiếu nào đang trỏ vào nó. Đổi lại kho có thể còn tệp không ai dùng; dọn
 * kho là việc định kỳ, không đáng đánh đổi bằng rủi ro mất hồ sơ của phiếu khác.
 *
 * Trigger `guard_signing_transition` chỉ cho sửa `files` khi phiếu còn ở
 * nháp/trả lại và người sửa là người lập (hoặc Admin) — trùng đúng với `canEdit`
 * mà giao diện đang dùng để ẩn/hiện nút.
 */
export async function removeDossierFile(
  rowId: string,
  files: SigningFile[],
  path: string
): Promise<SigningFile[]> {
  const next = files.filter(f => f.path !== path);
  const { error } = await supabase
    .from("signing_submissions")
    .update({ files: next })
    .eq("id", rowId);
  if (error) throw error;
  return next;
}

function normalizeRow(r: Record<string, unknown>): SigningSubmission {
  return {
    ...(r as unknown as SigningSubmission),
    // Hai cột jsonb: Postgres trả về mảng, nhưng dòng cũ/lỗi có thể là null.
    ai_thieu: Array.isArray(r.ai_thieu) ? (r.ai_thieu as string[]) : [],
    files: Array.isArray(r.files) ? (r.files as SigningFile[]) : [],
    // Phiếu lập trước 060 không có 2 cột này — về mặc định thay vì undefined,
    // để mọi chỗ đọc `s.loai` / `s.so_sanh` không phải kiểm null.
    loai: (r.loai as SigningLoai) || "ho_so",
    so_sanh: Array.isArray(r.so_sanh) ? (r.so_sanh as SoSanhRow[]) : [],
    // migration 091 — phiếu cũ không có 2 cột này.
    vat_tu: Array.isArray(r.vat_tu) ? (r.vat_tu as VatTuRow[]) : [],
    chi_tiet: (r.chi_tiet && typeof r.chi_tiet === "object" && !Array.isArray(r.chi_tiet))
      ? (r.chi_tiet as Partial<Record<DdhField, string>>) : {},
    // migration 074 — phiếu cũ không có route/cap1: về mặc định để mọi chỗ đọc
    // s.route/s.pgd_chon không phải kiểm null.
    route: Array.isArray(r.route) ? (r.route as SigningStatus[]) : [],
    pgd_chon: (r.pgd_chon as SigningSubmission["pgd_chon"]) ?? "",
  };
}

/**
 * Luỹ kế đã thanh toán tính từ các đợt TRƯỚC của cùng hợp đồng, cộng đợt đang lập.
 * Gọi hàm SQL (migration 050) thay vì cộng ở client: client chỉ thấy những phiếu
 * RLS cho phép, cộng thiếu một đợt là sai con số trình Giám đốc.
 */
export async function tinhLuyKe(
  hopDongSo: string,
  dotSo: number,
  dotNay: number
): Promise<number | null> {
  const { data, error } = await supabase.rpc("luy_ke_da_thanh_toan", {
    p_hop_dong_so: hopDongSo,
    p_dot_so: dotSo,
    p_dot_nay: dotNay,
  });
  if (error) return null;
  return typeof data === "number" ? data : Number(data) || null;
}

// ─── Tệp hồ sơ gốc ───
function safeName(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9.-]/g, "_");
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${clean}`;
}

export async function uploadDossierFile(file: File): Promise<SigningFile> {
  const path = safeName(file.name);
  const { error } = await supabase.storage
    .from(SIGNING_BUCKET)
    .upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });

  if (error) {
    // Người dùng cuối đọc "Bucket not found" thì không biết phải làm gì.
    const hint = /bucket not found/i.test(error.message)
      ? ` — chưa có kho "${SIGNING_BUCKET}". Chạy migrations/051_signing_dossier_bucket.sql.`
      : /row-level security|policy/i.test(error.message)
      ? " — tài khoản chưa được cấp cờ “Lập phiếu trình ký”."
      : /exceeded the maximum allowed size|payload too large/i.test(error.message)
      ? " — tệp vượt mức 25MB."
      : "";
    throw new Error(`Không tải lên được "${file.name}": ${error.message}${hint}`);
  }
  return { path, name: file.name, size: file.size };
}

// ─── Xuất phiếu Word ───
// Đặt ở lib để màn hình SOẠN THẢO và màn hình CHI TIẾT dùng chung một đường:
// hai nơi tự gọi API rồi tự dựng thẻ <a> tải file thì rất dễ trôi lệch nhau,
// mà phiếu in ra từ hai chỗ bắt buộc phải giống hệt.
export async function downloadSigningForm(
  payload: Record<string, unknown>,
  filename: string
): Promise<void> {
  const res = await apiFetch("/api/export-signing-form", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `Lỗi xuất phiếu (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Xuất ĐƠN ĐẶT HÀNG ra Excel. Đường riêng vì tờ này là .xlsx — route
 * /api/export-signing-form chỉ biết mở .docx bằng docxtemplater.
 *
 * Trả về số dòng vật tư bị cắt (file mẫu chỉ có 15 dòng). Nơi gọi PHẢI hiển thị
 * cảnh báo khi > 0: đơn tải về thiếu dòng mà không ai biết là lỗi tệ nhất.
 */
export async function downloadPurchaseOrder(
  payload: Record<string, unknown>,
  filename: string
): Promise<number> {
  const res = await apiFetch("/api/export-purchase-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `Lỗi xuất đơn đặt hàng (${res.status})`);
  }
  const boQua = Number(res.headers.get("X-Rows-Dropped") || "0") || 0;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return boQua;
}

/**
 * Dựng payload xuất Word từ một phiếu ĐÃ LƯU.
 * Khác màn hình soạn thảo ở chỗ CÓ kèm ý kiến 3 cấp — xuất từ màn hình chi tiết
 * là để lấy bản phiếu đã có chữ ký/ý kiến, đó mới là bản đem đi lưu hồ sơ.
 */
/** Ngày trên đầu phiếu: luôn theo NGÀY LẬP, luôn kèm múi giờ VN. Route chạy giờ
 *  UTC nên phiếu lập sau 17h giờ VN mà quên `timeZone` là in ra ngày hôm trước. */
export function ngayVietNam(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  const ok = Number.isNaN(d.getTime()) ? new Date() : d;
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric",
  }).formatToParts(ok);
  const g = (t: string) => p.find((x) => x.type === t)?.value || "";
  return `ngày ${g("day")} tháng ${g("month")} năm ${g("year")}`;
}

/** Payload cho ĐƠN ĐẶT HÀNG — đi route Excel riêng, không qua docxtemplater. */
export function ddhPayloadFromRow(s: SigningSubmission): Record<string, unknown> {
  const c = s.chi_tiet || {};
  return {
    duAn: s.du_an,
    congTrinh: c.congTrinh || s.goi_thau,
    hangMuc: s.hang_muc,
    soDdh: c.soDdh,
    lanThu: s.dot_so,
    ngayDatHang: s.created_at,
    ngayDuKien: c.ngayDuKien,
    nguoiYeuCau: s.created_by_name || "",
    donViYeuCau: c.donViYeuCau || s.ben_a,
    donViNhanNo: c.donViNhanNo || s.ben_b,
    diaChiNhan: c.diaChiNhan,
    nguoiNhanHang: c.nguoiNhanHang,
    sdtNhanHang: c.sdtNhanHang,
    canBoKyThuat: c.canBoKyThuat,
    sdtKyThuat: c.sdtKyThuat,
    taiLieuKemTheo: c.taiLieuKemTheo,
    cdtThanhToan: c.cdtThanhToan,
    lyDoKhongThanhToan: c.lyDoKhongThanhToan,
    nguyenNhanPhatSinh: c.nguyenNhanPhatSinh,
    vatTu: s.vat_tu,
    fileName: docxFileName(s),
  };
}

export function docxPayloadFromRow(s: SigningSubmission): Record<string, unknown> {
  // PHIẾU YÊU CẦU: một bảng vật tư 6 cột + 3 ô chữ. Không có số tiền nào.
  if (s.loai === "phieu_yeu_cau") {
    return {
      loai: "phieu_yeu_cau",
      nguoiYeuCau: s.created_by_name || "",
      boPhan: s.don_vi,
      noiDungYeuCau: s.noi_dung_trinh || s.ve_viec,
      ngayLap: s.created_at,
      vatTu: s.vat_tu,
      fileName: docxFileName(s),
    };
  }

  // TỜ TRÌNH: tờ TTr/Lodeza EOP là một lá thư, không có bảng số liệu nào. Chỉ mấy ô
  // chữ + một dòng chi phí; `ngayLap` để route ghi đúng "ngày … tháng … năm"
  // theo NGÀY LẬP PHIẾU chứ không phải ngày bấm nút xuất.
  if (s.loai === "to_trinh") {
    return {
      loai: "to_trinh",
      soToTrinh: s.so_to_trinh,
      ngayLap: s.created_at,
      donVi: s.don_vi,
      veViec: s.ve_viec,
      canCu: s.can_cu,
      noiDung: s.noi_dung_trinh,
      donViBaoGia: s.chu_dau_tu,
      chiPhiDuKien: s.de_nghi_thanh_toan,
      vatPercent: s.vat_percent,
      dienGiaiChiPhi: s.hang_muc,
      kienNghi: s.kien_nghi,
      nguoiTrinh: s.created_by_name || "",
      fileName: docxFileName(s),
    };
  }

  // Phiếu HỢP ĐỒNG: bộ trường khác hẳn, route cũng render bằng nhánh riêng.
  if (s.loai === "hop_dong") {
    return {
      loai: "hop_dong",
      donVi: s.don_vi,
      duAn: s.du_an,
      goiThau: s.goi_thau,
      hangMuc: s.hang_muc,
      hopDongSo: s.hop_dong_so,
      benA: s.ben_a,
      benB: s.ben_b,
      giaTriHD: s.gia_tri_hd,
      vatPercent: s.vat_percent,
      soSanh: s.so_sanh,
      ykienQLDA: s.ykien_qlda || "",
      ykienKHDT: s.ykien_khdt || "",
      ykienGiamDoc: s.ykien_giam_doc || "",
      nguoiTrinh: s.created_by_name || "",
      fileName: docxFileName(s),
    };
  }

  return {
    loai: "ho_so",
    donVi: s.don_vi,
    veViec: s.ve_viec,
    noiDungTrinh: s.noi_dung_trinh,
    dotSo: s.dot_so,
    chuDauTu: s.chu_dau_tu,
    duAn: s.du_an,
    hopDongSo: [s.hop_dong_so, s.ngay_ky_hop_dong ? `ký ngày ${s.ngay_ky_hop_dong}` : ""]
      .filter(Boolean).join(" "),
    goiThau: s.goi_thau,
    giaTriHD: s.gia_tri_hd,
    giaTriNghiemThu: s.gia_tri_nghiem_thu,
    giuBaoHanh: s.giu_bao_hanh,
    giuLaiTungLan: s.giu_lai_tung_lan,
    tyLeGiuLai: s.ty_le_giu_lai,
    khauTruTamUng: s.khau_tru_tam_ung,
    tyLeThuHoi: s.ty_le_thu_hoi,
    deNghiThanhToan: s.de_nghi_thanh_toan ?? tinhDeNghi(s),
    luyKeDaThanhToan: s.luy_ke_da_thanh_toan,
    tamUngConLai: s.tam_ung_con_lai,
    ykienQLDA: s.ykien_qlda || "",
    ykienKHDT: s.ykien_khdt || "",
    ykienGiamDoc: s.ykien_giam_doc || "",
    nguoiTrinh: s.created_by_name || "",
  };
}

export function docxFileName(s: {
  ma_phieu?: string | null; hop_dong_so?: string | null; dot_so?: number | null;
  loai?: SigningLoai; so_to_trinh?: string | null;
  chi_tiet?: Partial<Record<DdhField, string>>;
}): string {
  const ma = String(s.ma_phieu || "phieu").replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60);
  if (s.loai === "phieu_yeu_cau") return `Phieu_Yeu_Cau_${ma}.docx`;
  if (s.loai === "tam_ung") return `Giay_De_Nghi_Tam_Ung_${ma}.docx`;
  // Đơn đặt hàng in ra EXCEL — đuôi .xlsx, đặt tên theo Số ĐĐH nếu đã có.
  if (s.loai === "don_dat_hang") {
    const so = String(s.chi_tiet?.soDdh || s.ma_phieu || "ddh")
      .replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60);
    return `Don_Dat_Hang_${so}.xlsx`;
  }
  // Tờ trình không gắn hợp đồng — đặt tên theo số tờ trình, không có thì mã phiếu.
  if (s.loai === "to_trinh") {
    const tt = String(s.so_to_trinh || s.ma_phieu || "to_trinh")
      .replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60);
    return `To_Trinh_${tt}.docx`;
  }
  const safe = String(s.hop_dong_so || s.ma_phieu || "phieu").replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60);
  // Phiếu hợp đồng không có "đợt" — gắn đuôi _Dot_x vào là sai nghiệp vụ.
  if (s.loai === "hop_dong") return `Phieu_Trinh_Ky_Hop_Dong_${safe}.docx`;
  return `Phieu_Trinh_Ky_${safe}_Dot_${s.dot_so ?? "x"}.docx`;
}

// ─── Đẩy sang Bảng kê hồ sơ thanh toán (module Kế toán, migration 068 + 073) ───
// Gọi NGAY SAU khi Giám đốc duyệt phiếu HỒ SƠ/VĂN BẢN (phiếu vào bước Kế toán).
// Tạo sẵn một dòng trong `payment_dossiers` để kế toán khỏi nhập lại:
//   - Người nhận tiền / nội dung / số tiền / dự án / tệp: lấy thẳng từ phiếu.
//   - Số tài khoản + ngân hàng: tra Danh mục đối tác (finance_partners →
//     finance_partner_accounts, tài khoản MẶC ĐỊNH) theo tên đơn vị. Đối tác gõ
//     tay ngoài danh mục thì để trống, kế toán tự điền.
//   - Người đề nghị TT + phòng ban: theo NGƯỜI LẬP phiếu (email → danh bạ).
//
// IDEMPOTENT: cột signing_submission_id là UNIQUE (072). Phiếu bị trả lại rồi
// duyệt lại KHÔNG tạo dòng thứ hai — bắt lỗi trùng khoá 23505 và bỏ qua.
//
// KHÔNG ném lỗi làm hỏng thao tác duyệt ở nơi gọi: phiếu đã chuyển bước rồi, đây
// chỉ là tiện ích điền hộ. Nơi gọi fire-and-forget và chỉ hiện cảnh báo mềm.
export async function pushToPaymentDossier(
  row: SigningSubmission,
  actorEmail: string
): Promise<void> {
  // Chỉ phiếu chi tiền mới có bước Kế toán; phiếu hợp đồng và tờ trình dừng ở
  // Giám đốc nên không bao giờ gọi tới đây — chặn sẵn cho chắc.
  if (row.loai === "hop_dong" || row.loai === "don_dat_hang"
      || LOAI_HAI_CAP.includes(row.loai)) return;

  const ddmmyyyy = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Ho_Chi_Minh",
      day: "2-digit", month: "2-digit", year: "numeric",
    }).format(d);

  // Tài khoản nhận tiền — tra theo tên đơn vị (finance_partners.name là unique).
  let soTaiKhoan = "";
  let taiNganHang = "";
  const ten = (row.chu_dau_tu || "").trim();
  // Phiếu đề nghị chuyển tiền (079) đã ghi thẳng tài khoản nhận lên phiếu và
  // Giám đốc đã duyệt ĐÚNG con số tài khoản đó. Ưu tiên nó hơn danh mục đối
  // tác: đơn vị có thể đổi tài khoản mặc định sau khi phiếu được ký.
  if ((row.loai === "chuyen_tien" || row.loai === "tam_ung")
      && (row.so_tai_khoan || row.ngan_hang)) {
    soTaiKhoan = row.so_tai_khoan || "";
    taiNganHang = row.ngan_hang || "";
  } else if (ten) {
    const { data: p } = await supabase
      .from("finance_partners")
      .select("id")
      .ilike("name", ten)
      .limit(1);
    const partnerId = p?.[0]?.id as string | undefined;
    if (partnerId) {
      const { data: acc } = await supabase
        .from("finance_partner_accounts")
        .select("bank_account, bank_name, bank_branch")
        .eq("partner_id", partnerId)
        .order("is_default", { ascending: false })
        .limit(1);
      const a = acc?.[0] as { bank_account?: string; bank_name?: string; bank_branch?: string } | undefined;
      if (a) {
        soTaiKhoan = a.bank_account || "";
        taiNganHang = [a.bank_name, a.bank_branch].filter(Boolean).join(" - ");
      }
    }
  }

  // Phòng ban người lập — khớp email TUYỆT ĐỐI (`%X%` chỉ là bộ lọc thô ở DB;
  // email này có thể là chuỗi con của email người khác nên phải lọc lại).
  let phongBan = "";
  if (row.created_by) {
    const { data: emp } = await supabase
      .from("employees_directory")
      .select("department, email")
      .ilike("email", `%${row.created_by}%`);
    phongBan =
      (emp || []).find((r) => emailFieldMatches((r as { email?: string | null }).email, row.created_by))
        ?.department || "";
  }

  const amount = row.de_nghi_thanh_toan ?? tinhDeNghi(row);
  const hasAmount = typeof amount === "number" && Number.isFinite(amount);

  const { error } = await supabase.from("payment_dossiers").insert([{
    signing_submission_id: row.id,
    ngay_nhap: ddmmyyyy(new Date()),
    ngay_de_nghi: row.created_at ? ddmmyyyy(new Date(row.created_at)) : ddmmyyyy(new Date()),
    nguoi_nhan_tien: ten || null,
    // Phiếu chuyển tiền: ve_viec chỉ là câu trình ("Kính trình BLĐ phê duyệt"),
    // nội dung thật nằm ở noi_dung_trinh — đúng thứ tự ô "Nội dung chuyển tiền"
    // trong SigningPanel. Các loại phiếu khác giữ nguyên thứ tự cũ.
    noi_dung_tt: (row.loai === "chuyen_tien" || row.loai === "tam_ung"
      ? row.noi_dung_trinh || row.ve_viec
      : row.ve_viec || row.noi_dung_trinh) || null,
    so_tien_de_nghi: hasAmount ? fmtMoney(amount) : null,
    so_tien_de_nghi_num: hasAmount ? amount : null,
    du_an: row.du_an || null,
    nguoi_de_nghi_tt: row.created_by_name || row.created_by || null,
    don_vi_cong_tac: phongBan || null,
    so_tai_khoan: soTaiKhoan || null,
    tai_ngan_hang: taiNganHang || null,
    ten_file_pdf: row.files.length ? row.files.map((f) => f.name).join("; ") : null,
    created_by: actorEmail || null,
  }]);

  // Trùng khoá = đã tạo ở lần duyệt trước -> bỏ qua, không phải lỗi.
  if (error && (error as { code?: string }).code !== "23505") throw error;
}

export async function resolveDossierUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(SIGNING_BUCKET)
    .createSignedUrl(path, SIGNED_TTL);
  if (error || !data) return null;
  return data.signedUrl;
}

// ─── Báo email lúc TRÌNH PHIẾU ĐI (dùng chung cho 2 cửa) ───
// Phiếu có thể được trình từ HAI chỗ: nút "Trình" ở màn hình chi tiết
// (SigningPanel) và nút "Trình duyệt" ngay trong form lập phiếu
// (SigningFormModal — cũng là cửa mà "Trình ký online" bên Kế hoạch thu chi đi
// vào). Trước 15/09/2026 chỉ cửa thứ nhất gửi email, nên phiếu lập-và-trình
// một lèo thì cấp 1 KHÔNG nhận được gì: không mail, không chuông, việc nằm im.
//
// Fire-and-forget đúng khuôn của SigningPanel: phiếu đã chuyển bước trong CSDL
// rồi, SMTP hỏng cũng không được phép làm hỏng thao tác — chỉ trả về câu cảnh
// báo (hoặc chuỗi rỗng nếu êm) để nơi gọi hiển thị mềm.
export async function notifySigningSubmitted(params: {
  row: {
    ma_phieu?: string | null; hop_dong_so?: string | null; du_an?: string | null;
    chu_dau_tu?: string | null; dot_so?: number | null; de_nghi_thanh_toan?: number | null;
    cap1_email?: string | null; created_by?: string | null; created_by_name?: string | null;
  };
  firstStep: SigningStatus;
  actorName: string;
}): Promise<string> {
  const { row, firstStep, actorName } = params;
  try {
    // Bước cấp 1 không theo cờ — email người duyệt đã chốt trên chính phiếu.
    const nextEmails =
      firstStep === "cho_cap1"
        ? (row.cap1_email || "").split(",").map((e) => e.trim()).filter((e) => e.includes("@"))
        : await fetchStageApproverEmails(firstStep);
    const res = await apiFetch("/api/send-signing-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        maPhieu: row.ma_phieu,
        hopDongSo: row.hop_dong_so,
        duAn: row.du_an,
        chuDauTu: row.chu_dau_tu,
        dotSo: row.dot_so,
        soTien: row.de_nghi_thanh_toan,
        event: "trinh",
        nextLabel: STATUS_META[firstStep]?.label,
        actorName,
        creatorEmail: row.created_by,
        creatorName: row.created_by_name,
        nextApproverEmails: nextEmails,
        siteUrl: typeof window !== "undefined" ? window.location.origin : "",
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return j.error || `Không gửi được email (${res.status}).`;
    if (j.failed?.length) return `Gửi email lỗi: ${j.failed.join("; ")}`;
    if (!j.sent?.length) return "Không có địa chỉ email nào để gửi thông báo.";
    return "";
  } catch (e) {
    return `Không gửi được email: ${errText(e)}`;
  }
}
