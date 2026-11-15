"use client";

// ============================================================
// SigningFormModal — lập / sửa PHIẾU TRÌNH KÝ HỒ SƠ/VĂN BẢN.
//
// Ba việc trong một màn hình:
//   1. Tải bộ hồ sơ lên kho riêng (bucket signing-dossiers, migration 051)
//   2. Bấm bóc tách -> api/analyze-signing-dossier đọc cả bộ, trả 13 trường
//   3. Người lập SOÁT LẠI rồi mới lưu — AI điền hộ, người chịu trách nhiệm ký
//
// VÌ SAO LUÔN CHO SỬA TAY MỌI Ô AI ĐIỀN: đây là số liệu tiền trình Giám đốc ký.
// Prompt đã cấm model bịa, trường nào không chắc nó trả null và ghi vào "thiếu",
// nhưng người lập vẫn phải là chốt chặn cuối.
//
// ⚠ Modal dùng createPortal ra document.body — panel cha nằm trong khối `.glass`
// và backdrop-filter tạo containing block mới, phần tử `fixed` sẽ bị nhốt lại.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/lib/supabase";
import { apiFetch } from "@/lib/apiClient";
import { useProjectCatalog } from "@/lib/projectCatalog";
import { exportTransferRequestDocx } from "@/components/TransferRequestPreview";
import { useDepartments } from "@/lib/departments";
import { resolveModel, DEFAULT_AI_MODEL, AI_MODEL_OPTIONS } from "@/lib/aiModel";
import {
  useFinancePartners, PARTY_TYPE_LABELS, foldVi,
  type FinancePartnerContract,
} from "@/lib/financePartners";
import {
  tinhDeNghi, tinhLuyKe, fmtMoney, uploadDossierFile, resolveDossierUrl, errText,
  downloadSigningForm, docxFileName, buildSigningRoute, resolveCap1,
  notifySigningSubmitted,
  type SigningSubmission, type SigningFile,
  LOAI_META, SO_SANH_MAU, DDH_FIELDS, downloadPurchaseOrder, hasSigningVatTuApprover,
  type SigningLoai, type SoSanhRow, type VatTuRow, type DdhField,
} from "@/lib/signingSubmissions";
import {
  X, Upload, Sparkles, Loader2, Save, Send, Trash2, FileText, Plus,
  AlertTriangle, Download, Calculator, ExternalLink, Settings, Search, Check,
} from "lucide-react";

const inputCls =
  "border border-slate-200 rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 font-semibold text-slate-800 text-xs bg-white transition-all w-full";
const labelCls = "text-[10px] font-bold text-slate-400 uppercase tracking-wider";

// Bản nháp trong form: mọi ô là chuỗi để người dùng gõ thoải mái (kể cả rỗng),
// chỉ đổi sang số đúng lúc lưu. Giữ number ngay từ ô nhập thì xoá hết ký tự sẽ
// thành NaN và React nhảy về 0 giữa lúc đang gõ.
type Draft = Record<string, string>;

const NUM_FIELDS = [
  "gia_tri_hd", "gia_tri_nghiem_thu", "giu_bao_hanh", "giu_lai_tung_lan",
  "khau_tru_tam_ung", "luy_ke_da_thanh_toan", "tam_ung_con_lai", "de_nghi_thanh_toan",
] as const;
const RATE_FIELDS = ["ty_le_giu_lai", "ty_le_thu_hoi"] as const;

const toNum = (s: string): number | null => {
  const t = (s || "").replace(/[^\d.,-]/g, "").replace(/\./g, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const toRate = (s: string): number | null => {
  const t = (s || "").replace(/%/g, "").replace(",", ".").replace(/[^\d.-]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const showNum = (v: number | null | undefined): string =>
  typeof v === "number" && Number.isFinite(v) ? new Intl.NumberFormat("vi-VN").format(v) : "";

// Cấu hình cột bảng vật tư (migration 091). Phiếu yêu cầu dùng 5 cột, đơn đặt
// hàng dùng 12 — cùng một mảng `vat_tu`, khác bộ khoá. Khai ở MỘT chỗ để tiêu đề
// cột và ô nhập không bao giờ lệch nhau.
type VatTuCol = { key: keyof VatTuRow; label: string; w: string; hint?: string; num?: boolean };

const VAT_TU_COLS = (ddh: boolean): VatTuCol[] =>
  ddh
    ? [
        { key: "ten", label: "Tên vật tư hàng hoá (1)", w: "200px", hint: "Bấc thấm đứng" },
        { key: "quyCach", label: "Quy cách (2)", w: "150px" },
        { key: "dvt", label: "ĐVT (3)", w: "70px", hint: "M" },
        { key: "dinhMuc", label: "Định mức KL theo dự toán (4)", w: "120px", num: true },
        { key: "luyKeTrong", label: "Đã TH trong định mức (5a)", w: "110px", num: true },
        { key: "luyKeNgoai", label: "Đã TH ngoài định mức (5b)", w: "110px", num: true },
        { key: "chenhLech", label: "Chênh lệch còn lại (6)", w: "110px", num: true },
        { key: "dexuatTrong", label: "Đề xuất trong định mức (7a)", w: "120px", num: true },
        { key: "dexuatNgoai", label: "Đề xuất ngoài định mức (7b)", w: "120px", num: true },
        { key: "lyDo", label: "Lý do đặt (8)", w: "150px" },
        { key: "chiPhi", label: "Chi phí", w: "110px", hint: "Công trình" },
        { key: "ghiChu", label: "Ghi chú / ưu tiên", w: "120px" },
      ]
    : [
        { key: "ten", label: "Tên vật tư, hàng hoá, máy móc thiết bị", w: "minmax(180px,1fr)", hint: "Pano Cầu Phước An" },
        { key: "quyCach", label: "Quy cách", w: "minmax(160px,1fr)", hint: "2M x 8M in bạt hiflex" },
        { key: "dvt", label: "ĐVT", w: "80px", hint: "Bảng" },
        { key: "soLuong", label: "Số lượng", w: "90px", num: true },
        { key: "ngayCap", label: "Ngày cấp", w: "110px", hint: "25/03/2026" },
      ];

function toDraft(s: SigningSubmission | null, defaultDept = "", prefill?: Record<string, string>): Draft {
  // Phiếu mới: mặc định Phòng ban = phòng của người lập (tra danh bạ). "Chưa xếp
  // phòng" thì để trống cho họ tự chọn thay vì ghi một giá trị vô nghĩa.
  // `prefill` (vd trình ký từ dòng Kế hoạch TC) đè lên mặc định.
  if (!s) {
    const base: Draft = { don_vi: /^chưa xếp/i.test(defaultDept) ? "" : defaultDept };
    return prefill ? { ...base, ...prefill } : base;
  }
  const d: Draft = {};
  for (const k of ["don_vi", "ve_viec", "noi_dung_trinh", "chu_dau_tu", "du_an",
    "hop_dong_so", "ngay_ky_hop_dong", "goi_thau", "project_code",
    // migration 060 — chỉ dùng cho phiếu hợp đồng
    "hang_muc", "ben_a", "ben_b",
    // migration 079 — chỉ dùng cho phiếu đề nghị chuyển tiền
    "so_tai_khoan", "ngan_hang",
    // migration 088 — chỉ dùng cho tờ trình
    "so_to_trinh", "can_cu", "kien_nghi",
    // migration 094 — ngày thanh toán / cấp phát của đợt này
    "ngay_dot"] as const) {
    d[k] = (s[k] as string) || "";
  }
  d.vat_percent = s.vat_percent != null ? String(s.vat_percent) : "";
  d.dot_so = s.dot_so != null ? String(s.dot_so) : "";
  // migration 074 — 2 ô tích PGĐ, dẫn xuất từ route của phiếu (nguồn sự thật).
  d.pgd_qlda = s.route?.includes("cho_pgd_qlda") ? "1" : "";
  d.pgd_khdt = s.route?.includes("cho_pgd_khdt") ? "1" : "";
  // migration 093 — ô tích "Phòng QLDA" của đơn đặt hàng, cũng dẫn xuất từ route.
  d.phong_qlda = s.route?.includes("cho_phong_qlda") ? "1" : "";
  for (const k of NUM_FIELDS) d[k] = showNum(s[k]);
  for (const k of RATE_FIELDS) d[k] = s[k] != null ? String(s[k]) : "";
  return d;
}

export default function SigningFormModal({
  existing, loai: loaiMoi, currentEmail, currentName, currentDepartment, prefill, onClose, onSaved, onCreated,
  onMailWarn,
}: {
  existing: SigningSubmission | null;
  /** Loại phiếu khi LẬP MỚI. Sửa phiếu cũ thì lấy theo phiếu, không đổi được. */
  loai?: SigningLoai;
  currentEmail: string;
  currentName: string;
  /** Phòng ban của người lập (useCurrentUser().department) — mặc định ô Phòng ban. */
  currentDepartment?: string;
  /** Giá trị điền sẵn khi LẬP MỚI (vd trình ký từ dòng Kế hoạch TC). Khoá draft. */
  prefill?: Record<string, string>;
  onClose: () => void;
  onSaved: () => void;
  /** Gọi sau khi TẠO MỚI phiếu thành công, kèm id — để nơi gọi liên kết (Kế hoạch TC). */
  onCreated?: (id: string) => void | Promise<void>;
  /** Cảnh báo mềm khi email báo cấp duyệt gửi không được. Modal đóng ngay sau khi
      trình nên câu này phải nổi ở PANEL CHA, không hiển thị được trong form. */
  onMailWarn?: (m: string) => void;
}) {
  const { projects } = useProjectCatalog();
  // Danh sách phòng ban + BĐH (bảng departments) — nguồn cho ô "Phòng ban".
  const departments = useDepartments();
  // Danh mục đối tác (migration 048/059) — để ô "Đơn vị / Đối tác" chọn từ danh
  // sách có sẵn thay vì gõ tay, và điền hộ dữ liệu cơ bản đã lưu (dự án, số HĐ).
  const { partners, contracts, accounts } = useFinancePartners();
  // Loại phiếu KHÔNG cho đổi sau khi đã tạo: đổi giữa chừng thì nửa số trường
  // đang có dữ liệu bỗng thành trường của loại kia, và luồng duyệt đã đi được
  // vài bước lại nhảy sang luồng khác.
  const loai: SigningLoai = existing ? existing.loai : (loaiMoi || "ho_so");
  const laHopDong = loai === "hop_dong";
  // Giấy đề nghị chuyển tiền (HC-BM021/ĐNCT, migration 079): tờ này chỉ hỏi
  // CHUYỂN CHO AI, VÀO TÀI KHOẢN NÀO, BAO NHIÊU, VÌ VIỆC GÌ. Không hợp đồng,
  // không đợt, không A−B−C−D — mấy ô đó là của tờ TL/BM/011.
  // Giấy đề nghị TẠM ỨNG (TCKT/BM/001, migration 134) đi chung nhóm này: cùng
  // bộ ô thụ hưởng + tài khoản + số tiền + lý do, khác mẫu in và có thêm ô
  // "Thời gian thanh toán". Cần phân biệt thì dùng `laTamUng`.
  const laTamUng = loai === "tam_ung";
  const laChuyenTien = loai === "chuyen_tien" || laTamUng;
  // Tờ trình (TTr/Lodeza EOP, migration 088): xin CHỦ TRƯƠNG, không phải xin tiền.
  // Bộ ô của nó là Căn cứ → Nội dung đề nghị → Chi phí dự kiến → Kiến nghị;
  // không hợp đồng, không đợt, không tài khoản nhận.
  const laToTrinh = loai === "to_trinh";
  // Hai biểu mẫu có BẢNG DÒNG (migration 091). Phiếu yêu cầu 6 cột in ra Word;
  // đơn đặt hàng 13 cột in ra EXCEL và có thêm ~14 ô đầu phiếu riêng.
  const laPhieuYeuCau = loai === "phieu_yeu_cau";
  const laDonDatHang = loai === "don_dat_hang";
  const coBangVatTu = laPhieuYeuCau || laDonDatHang;
  // Ba loại kia mỗi loại một bộ ô riêng, nên rất nhiều khối chỉ dành cho phiếu
  // hồ sơ/văn bản. Đặt tên thẳng thay vì viết `!laHopDong && !laChuyenTien && …`
  // ở chục chỗ — thêm loại thứ năm mà quên một chỗ là ô của loại khác lòi ra.
  const laHoSo = loai === "ho_so";
  const meta = LOAI_META[loai];
  const [d, setD] = useState<Draft>(() => toDraft(existing, currentDepartment, prefill));
  // Bảng so sánh A-B ↔ B-B′ — mảng riêng, không nhét vào Draft (Draft toàn chuỗi).
  const [soSanh, setSoSanh] = useState<SoSanhRow[]>(
    () => (existing?.so_sanh?.length ? existing.so_sanh : SO_SANH_MAU).map((r) => ({ ...r }))
  );
  // Bảng vật tư (migration 091) — cùng khuôn `soSanh`: mảng riêng, số dòng
  // thêm/bớt được. Phiếu mới mở sẵn 3 dòng trống cho đỡ phải bấm "Thêm dòng".
  const [vatTu, setVatTu] = useState<VatTuRow[]>(
    () => (existing?.vat_tu?.length ? existing.vat_tu.map((r) => ({ ...r }))
                                    : [{}, {}, {}])
  );
  // Các ô đầu phiếu riêng của đơn đặt hàng — object phẳng, lưu vào cột `chi_tiet`.
  const [chiTiet, setChiTiet] = useState<Partial<Record<DdhField, string>>>(
    () => ({ ...(existing?.chi_tiet || {}) })
  );
  const setCt = (k: DdhField, v: string) => setChiTiet((p) => ({ ...p, [k]: v }));
  // MỘT danh sách duy nhất. Trước đây tách làm hai — `files` để hiển thị/lưu và
  // `pending` để gửi cho AI — nhưng nút thùng rác chỉ xoá khỏi `files`, nên tệp
  // đã xoá VẪN được gửi lên OpenAI ở lần bóc kế tiếp. Hậu quả thật: xoá một PDF
  // scan 39 trang rồi chọn 3 ảnh, lượt bóc sau vẫn kèm cả PDF đó -> ~43k token
  // -> OpenAI trả 429 "request too large", không phân tích gì cả.
  // `raw` chỉ có với tệp vừa chọn trong phiên này; tệp của phiếu cũ đọc từ CSDL
  // không có File object nên không bóc lại được (phải chọn lại từ máy).
  type LocalFile = SigningFile & { raw?: File };
  const [files, setFiles] = useState<LocalFile[]>(existing?.files || []);
  const pending = useMemo(() => files.filter((f) => f.raw).map((f) => f.raw as File), [files]);
  const [aiThieu, setAiThieu] = useState<string[]>(existing?.ai_thieu || []);
  const [aiGhiChu, setAiGhiChu] = useState(existing?.ai_ghi_chu || "");

  const [busy, setBusy] = useState<"" | "ai" | "save" | "submit" | "export">("");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // ─── Cấu hình AI ───
  // Dùng CHUNG localStorage với trang Hành chính ("..._hanh_chinh") thay vì đẻ
  // khoá riêng: người dùng đã nhập khoá ở đó thì sang đây chạy được ngay, không
  // phải nhập lại lần hai và không phải nhớ có hai chỗ cấu hình.
  // Mặc định GPT-6.1 Sol — hợp đồng xây dựng
  // dài, nhiều bảng số, mini đọc sai điều khoản.
  const [showCfg, setShowCfg] = useState(false);
  const [aiKey, setAiKey] = useState("");
  const [aiModel, setAiModel] = useState(DEFAULT_AI_MODEL);
  const [cfgSaved, setCfgSaved] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setAiKey(
      localStorage.getItem("openai_api_key_hanh_chinh") ||
      localStorage.getItem("openai_api_key") || ""
    );
    setAiModel(resolveModel(localStorage.getItem("openai_model_hanh_chinh")));
  }, []);

  const saveCfg = () => {
    localStorage.setItem("openai_api_key_hanh_chinh", aiKey.trim());
    localStorage.setItem("openai_model_hanh_chinh", aiModel);
    setCfgSaved(true);
    setTimeout(() => setCfgSaved(false), 2000);
  };

  const set = (k: string, v: string) => setD((p) => ({ ...p, [k]: v }));

  // ─── Ô "Đơn vị / Đối tác" — chọn từ danh mục (chỉ phiếu hồ sơ/văn bản) ───
  // Bê nguyên khuôn ô "Khách hàng" bên Kế hoạch TC: gõ để tìm, danh sách xổ
  // xuống, chọn xong thành thẻ có nút gỡ. VẪN cho gõ tên NGOÀI danh mục — có đơn
  // vị chưa kịp đưa vào danh mục thì vẫn lập phiếu được như trước.
  const [custSearch, setCustSearch] = useState("");
  const [showCust, setShowCust] = useState(false);
  const [contractId, setContractId] = useState("");
  const custRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (custRef.current && !custRef.current.contains(e.target as Node)) setShowCust(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // Đối tác khớp ĐÚNG TÊN với ô đã chọn. Gõ tay tên chưa có trong danh mục thì
  // không khớp ai — vẫn nhập bình thường, chỉ là không có gì để điền hộ.
  const partner = useMemo(() => {
    const q = (d.chu_dau_tu || "").trim().toLowerCase();
    if (!q) return null;
    return partners.find((p) => p.name.trim().toLowerCase() === q) || null;
  }, [partners, d.chu_dau_tu]);

  const partnerContracts = useMemo(
    () => (partner ? contracts.filter((c) => c.partner_id === partner.id) : []),
    [contracts, partner]
  );

  const custResults = useMemo(() => {
    const q = foldVi(custSearch);
    return partners
      .filter((p) => !q || foldVi(p.name).includes(q) || foldVi(p.short_name || "").includes(q))
      .slice(0, 30);
  }, [partners, custSearch]);

  // Tài khoản mặc định của đối tác — hiện ở dòng phụ để người lập thấy "số tài
  // khoản chính thức nhận tiền" đã lưu, xác nhận đúng đơn vị trước khi trình.
  const partnerAccount = useMemo(() => {
    if (!partner) return null;
    const mine = accounts.filter((a) => a.partner_id === partner.id);
    return mine.find((a) => a.is_default) || mine[0] || null;
  }, [partner, accounts]);

  // Phiếu chuyển tiền: điền hộ số tài khoản + ngân hàng từ danh mục đối tác,
  // nhưng CHỈ khi ô còn trống — người lập gõ đè rồi thì không giật lại, và mở
  // phiếu cũ ra sửa cũng không bị ghi đè bằng số tài khoản hiện hành.
  useEffect(() => {
    if (!laChuyenTien || !partnerAccount) return;
    setD((prev) => {
      if (prev.so_tai_khoan || prev.ngan_hang) return prev;
      return {
        ...prev,
        so_tai_khoan: partnerAccount.bank_account || "",
        ngan_hang: [partnerAccount.bank_name, partnerAccount.bank_branch].filter(Boolean).join(" — "),
      };
    });
  }, [laChuyenTien, partnerAccount]);

  // Điền hộ từ một dòng hợp đồng đã lưu. `overwrite=false` (hệ thống tự điền khi
  // đối tác chỉ có 1 hợp đồng): chỉ đổ vào ô CÒN TRỐNG, không đè lên số liệu AI
  // đã bóc hay người lập đã gõ. Bấm chọn trong ô "Lấy theo hợp đồng" thì
  // overwrite=true — thao tác cố ý, đè lên là đúng ý.
  const applyContract = (c: FinancePartnerContract, overwrite: boolean) => {
    const proj = projects.find((x) => x.code === c.project_code);
    setD((prev) => ({
      ...prev,
      du_an: overwrite || !prev.du_an ? (proj?.name || c.project_name || prev.du_an || "") : prev.du_an,
      hop_dong_so: overwrite || !prev.hop_dong_so ? (c.contract_no || prev.hop_dong_so || "") : prev.hop_dong_so,
      project_code: overwrite || !prev.project_code ? (c.project_code || prev.project_code || "") : prev.project_code,
    }));
    setContractId(c.id);
  };

  // Chọn đối tác xong: đối tác có đúng 1 hợp đồng (hoặc 1 hợp đồng khớp dự án đã
  // chọn) thì tự điền; nhiều hợp đồng thì KHÔNG đoán, để ô chọn bên dưới.
  const pickPartner = (name: string) => {
    setD((prev) => ({ ...prev, chu_dau_tu: name }));
    setContractId("");
    const q = name.trim().toLowerCase();
    const pn = partners.find((x) => x.name.trim().toLowerCase() === q);
    if (!pn) return;
    const list = contracts.filter((c) => c.partner_id === pn.id);
    const byProject = d.project_code ? list.filter((c) => c.project_code === d.project_code) : [];
    const auto = byProject.length === 1 ? byProject[0] : list.length === 1 ? list[0] : null;
    if (auto) applyContract(auto, false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  // ─── A-B-C-D tự tính, hiện ngay khi gõ ───
  const abcd = useMemo(
    () => tinhDeNghi({
      gia_tri_nghiem_thu: toNum(d.gia_tri_nghiem_thu || ""),
      giu_bao_hanh: toNum(d.giu_bao_hanh || ""),
      giu_lai_tung_lan: toNum(d.giu_lai_tung_lan || ""),
      khau_tru_tam_ung: toNum(d.khau_tru_tam_ung || ""),
    }),
    [d.gia_tri_nghiem_thu, d.giu_bao_hanh, d.giu_lai_tung_lan, d.khau_tru_tam_ung]
  );
  // Ô "đề nghị thanh toán" bỏ trống = dùng số tự tính. Điền tay = ghi đè.
  const deNghiCuoi = toNum(d.de_nghi_thanh_toan || "") ?? abcd;

  const buildPayload = useCallback(() => {
    const p: Record<string, unknown> = {
      don_vi: d.don_vi?.trim() || null,
      ve_viec: d.ve_viec?.trim() || null,
      noi_dung_trinh: d.noi_dung_trinh?.trim() || null,
      dot_so: d.dot_so ? Number(d.dot_so) : null,
      chu_dau_tu: d.chu_dau_tu?.trim() || null,
      du_an: d.du_an?.trim() || null,
      hop_dong_so: d.hop_dong_so?.trim() || null,
      ngay_ky_hop_dong: d.ngay_ky_hop_dong?.trim() || null,
      goi_thau: d.goi_thau?.trim() || null,
      project_code: d.project_code || null,
      project_name: projects.find((x) => x.code === d.project_code)?.name || null,
      // Tờ trình: chi phí là ô TÙY CHỌN (có tờ trình chỉ xin chủ trương, không
      // kèm tiền). Không được rơi vào `?? abcd` = 0 như hai loại kia — lưu 0 thì
      // tờ in ra có dòng "Giá dự kiến: 0 đồng".
      de_nghi_thanh_toan: laToTrinh ? toNum(d.de_nghi_thanh_toan || "") : deNghiCuoi,
      ai_ghi_chu: aiGhiChu || null,
      ai_thieu: aiThieu,
      // Lột bỏ File gốc trước khi lưu: cột `files` là jsonb, nhét File object
      // vào thì JSON.stringify ra {} và mất sạch đường dẫn tệp.
      files: files.map((f) => ({ path: f.path, name: f.name, size: f.size })),
      loai,
      hang_muc: d.hang_muc?.trim() || null,
      ben_a: d.ben_a?.trim() || null,
      ben_b: d.ben_b?.trim() || null,
      vat_percent: toRate(d.vat_percent || ""),
      // migration 079 — tài khoản nhận tiền, chỉ phiếu 'chuyen_tien' dùng tới.
      so_tai_khoan: d.so_tai_khoan?.trim() || null,
      ngan_hang: d.ngan_hang?.trim() || null,
      // migration 088 — ba ô riêng của tờ trình.
      so_to_trinh: d.so_to_trinh?.trim() || null,
      can_cu: d.can_cu?.trim() || null,
      kien_nghi: d.kien_nghi?.trim() || null,
      // migration 094 — ngày của đợt. Chỉ hai loại có đợt mới có ô này; loại
      // khác luôn gửi null để không đọng lại ngày cũ khi người lập đổi loại phiếu.
      ngay_dot: (loai === "ho_so" || loai === "don_dat_hang")
        ? (d.ngay_dot?.trim() || null) : null,
      // migration 091 — bảng vật tư + ô đầu phiếu của đơn đặt hàng.
      // Bỏ dòng trống trước khi lưu: form mở sẵn 3 dòng, phần lớn phiếu không
      // dùng hết, lưu nguyên thì phiếu in ra có hàng rỗng.
      vat_tu: vatTu.filter((r) =>
        Object.entries(r).some(([k, v]) => k !== "stt" && String(v || "").trim() !== "")),
      chi_tiet: Object.fromEntries(
        DDH_FIELDS.map((k) => [k, (chiTiet[k] || "").trim()]).filter(([, v]) => v !== "")
      ),
      // Bỏ dòng trống trước khi lưu — người lập hay để lại vài dòng mẫu chưa điền.
      so_sanh: soSanh.filter((r) => [r.muc, r.ab, r.bb].some((v) => (v || "").trim() !== "")),
      // migration 074 — ghi lại lựa chọn PGĐ (route dựng ở save()); route mới là
      // nguồn sự thật, cột này chỉ để đối chiếu nhanh.
      pgd_chon: [d.pgd_qlda ? "qlda" : "", d.pgd_khdt ? "khdt" : ""].filter(Boolean).join(","),
    };
    for (const k of NUM_FIELDS) if (k !== "de_nghi_thanh_toan") p[k] = toNum(d[k] || "");
    for (const k of RATE_FIELDS) p[k] = toRate(d[k] || "");
    return p;
  }, [d, projects, deNghiCuoi, aiGhiChu, aiThieu, files, loai, laToTrinh, soSanh, vatTu, chiTiet]);

  // ─── Tải tệp lên kho ───
  const doUpload = async (picked: File[]) => {
    setErr(""); setInfo("");
    const done: LocalFile[] = [];
    for (const f of picked) {
      try {
        // Giữ kèm File gốc để bóc tách khỏi phải tải ngược từ kho về.
        done.push({ ...(await uploadDossierFile(f)), raw: f });
      } catch (e) {
        setErr(errText(e));
      }
    }
    if (done.length) setFiles((p) => [...p, ...done]);
  };

  // ─── Bóc tách bằng AI ───
  // Gửi tệp NGUYÊN BẢN từ máy người dùng, không tải ngược từ kho về: tệp vừa
  // upload xong đang có sẵn trong bộ nhớ, tải lại chỉ tốn thêm một vòng mạng.
  const runAI = async () => {
    if (pending.length === 0) {
      setErr("Chọn file hồ sơ trước khi bóc tách.");
      return;
    }
    setBusy("ai"); setErr(""); setInfo("");
    try {
      const fd = new FormData();
      pending.forEach((f) => fd.append("files", f));

      const headers: Record<string, string> = {};
      // Lấy từ ô cấu hình ngay trên màn hình này (đã đồng bộ localStorage).
      // Không có khoá thì server dùng OPENAI_API_KEY của môi trường.
      if (aiKey.trim()) headers["Authorization"] = `Bearer ${aiKey.trim()}`;
      headers["x-openai-model"] = resolveModel(aiModel);

      const res = await apiFetch("/api/analyze-signing-dossier", {
        method: "POST", headers, body: fd,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Lỗi máy chủ (${res.status})`);

      const a = json.data || {};
      setD((p) => ({
        ...p,
        // Chỉ ghi đè ô đang TRỐNG — người lập đã sửa tay thì AI không được đạp lên.
        chu_dau_tu: p.chu_dau_tu || a.chuDauTu || "",
        du_an: p.du_an || a.duAn || "",
        hop_dong_so: p.hop_dong_so || a.hopDongSo || "",
        ngay_ky_hop_dong: p.ngay_ky_hop_dong || a.ngayKyHopDong || "",
        goi_thau: p.goi_thau || a.goiThau || "",
        dot_so: p.dot_so || (a.dotSo != null ? String(a.dotSo) : ""),
        gia_tri_hd: p.gia_tri_hd || showNum(a.giaTriHD),
        gia_tri_nghiem_thu: p.gia_tri_nghiem_thu || showNum(a.giaTriNghiemThu),
        giu_bao_hanh: p.giu_bao_hanh || showNum(a.giuBaoHanh),
        giu_lai_tung_lan: p.giu_lai_tung_lan || showNum(a.giuLaiTungLan),
        ty_le_giu_lai: p.ty_le_giu_lai || (a.tyLeGiuLai != null ? String(a.tyLeGiuLai) : ""),
        khau_tru_tam_ung: p.khau_tru_tam_ung || showNum(a.khauTruTamUng),
        ty_le_thu_hoi: p.ty_le_thu_hoi || (a.tyLeThuHoi != null ? String(a.tyLeThuHoi) : ""),
        luy_ke_da_thanh_toan: p.luy_ke_da_thanh_toan || showNum(a.luyKeDaThanhToan),
        tam_ung_con_lai: p.tam_ung_con_lai || showNum(a.tamUngConLai),
      }));
      setAiThieu(Array.isArray(a.thieu) ? a.thieu : []);
      // Tạm ứng theo HỢP ĐỒNG: cố ý KHÔNG tự điền vào ô "Tạm ứng còn lại chưa
      // thu hồi" — hai con số khác nhau (một là tổng tạm ứng ban đầu, một là số
      // dư sau khi đã thu hồi vài đợt). Chỉ nêu ra làm căn cứ để người lập tự
      // quyết; tự điền vào ô tiền là cách nhanh nhất để sai số trình Giám đốc.
      const tuHopDong =
        a.giaTriTamUng != null
          ? `Hợp đồng ghi tạm ứng ${Number(a.giaTriTamUng).toLocaleString("vi-VN")} đồng`
            + (a.tyLeTamUng != null ? ` (${a.tyLeTamUng}%)` : "")
            + ". Ô “Tạm ứng còn lại” là số DƯ sau khi đã thu hồi — tự điền theo bảng theo dõi."
          : "";
      setAiGhiChu([a.ghiChu || "", tuHopDong].filter(Boolean).join(" · "));

      // Nhật ký đọc tệp: nói rõ mỗi tệp được đọc bằng cách nào và ra bao nhiêu
      // chữ. Đây là thứ phân biệt "PDF là bản scan nên không rút được chữ" với
      // "đọc được nhưng model bỏ sót" — thiếu nó thì AI bóc hụt là một hộp đen.
      type DiagRow = { ten: string; cach: string; kyTu?: number; trang?: number };
      const nk: DiagRow[] = Array.isArray(json.nhatKy) ? json.nhatKy : [];
      const parts = [`Model ${json.model || "?"} · đã đọc ${nk.length || (json.daDoc || []).length} tệp.`];
      for (const r of nk) {
        const so = r.kyTu != null ? ` — ${r.kyTu.toLocaleString("vi-VN")} ký tự` : "";
        const tr = r.trang ? `, ${r.trang} trang` : "";
        parts.push(`• ${r.ten}: ${r.cach}${so}${tr}`);
      }
      if (json.boQua?.length) parts.push(`Bỏ qua: ${json.boQua.join("; ")}.`);
      parts.push("Soát lại toàn bộ số liệu trước khi trình.");
      setInfo(parts.join("\n"));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy("");
    }
  };

  // ─── Luỹ kế: hỏi CSDL, không cộng ở máy người dùng ───
  const autoLuyKe = async () => {
    const hd = d.hop_dong_so?.trim();
    const dot = Number(d.dot_so);
    if (!hd || !dot) {
      setErr("Cần có Số hợp đồng và Đợt số để tính luỹ kế.");
      return;
    }
    setErr("");
    const v = await tinhLuyKe(hd, dot, deNghiCuoi);
    if (v == null) {
      setErr("Không tính được luỹ kế (chưa chạy migration 050 hoặc tài khoản chưa có quyền).");
      return;
    }
    set("luy_ke_da_thanh_toan", showNum(v));
    setInfo(`Luỹ kế = tổng các đợt trước của HĐ ${hd} + đợt này (${fmtMoney(deNghiCuoi)}).`);
  };

  // ─── Lưu ───
  const save = async (submit: boolean) => {
    setBusy(submit ? "submit" : "save"); setErr("");
    try {
      const payload = buildPayload();
      // Giấy đề nghị chuyển tiền KHÔNG gắn hợp đồng/đợt — nó trình một khoản
      // chi trong kế hoạch thu chi. Bắt buộc của nó là: chuyển cho ai, bao
      // nhiêu, và vì việc gì.
      // Tờ trình: bắt buộc phải có ĐỦ 3 phần làm nên một tờ trình — trình việc
      // gì, đề nghị cái gì, kiến nghị ra sao. Thiếu một phần thì Ban Giám đốc
      // nhận về một tờ giấy không ký được.
      // Hai biểu mẫu bảng dòng: thứ bắt buộc là CÓ ÍT NHẤT MỘT DÒNG VẬT TƯ —
      // phiếu yêu cầu / đơn đặt hàng mà bảng rỗng thì cấp trên không ký được gì.
      if (submit && coBangVatTu) {
        const rows = payload.vat_tu as VatTuRow[];
        if (!rows.length) throw new Error("Phải nhập ít nhất một dòng vật tư / hàng hoá.");
        if (laPhieuYeuCau && !payload.noi_dung_trinh) {
          throw new Error("Phải ghi Nội dung yêu cầu trước khi trình.");
        }
        if (laDonDatHang && !payload.du_an) {
          throw new Error("Phải ghi Dự án trước khi trình.");
        }
      } else if (submit && laToTrinh) {
        if (!payload.ve_viec) throw new Error("Phải ghi “Về việc” trước khi trình.");
        if (!payload.noi_dung_trinh) throw new Error("Phải ghi Nội dung đề nghị trước khi trình.");
        if (!payload.kien_nghi) throw new Error("Phải ghi Kiến nghị trước khi trình.");
      } else if (submit && laChuyenTien) {
        if (!payload.chu_dau_tu) throw new Error("Phải chọn Đơn vị thụ hưởng trước khi trình.");
        if (!payload.de_nghi_thanh_toan) {
          throw new Error(`Phải có Số tiền đề nghị ${laTamUng ? "tạm ứng" : "chuyển"} trước khi trình.`);
        }
        if (!payload.noi_dung_trinh && !payload.ve_viec) {
          throw new Error(`Phải ghi Nội dung / lý do ${laTamUng ? "tạm ứng" : "chuyển tiền"} trước khi trình.`);
        }
      } else {
        if (submit && !payload.hop_dong_so) throw new Error("Phải có Số hợp đồng trước khi trình.");
        // "Đợt số" là khái niệm của phiếu thanh toán. Phiếu hợp đồng trình MỘT
        // hợp đồng, không có đợt nào cả.
        if (submit && !laHopDong && !payload.dot_so) throw new Error("Phải có Đợt số trước khi trình.");
      }

      // Dựng luồng riêng của phiếu + tính người duyệt cấp 1 (theo Phòng ban trên
      // phiếu + người lập). Bước đầu luôn là 'cho_cap1'. Tính cả khi lưu nháp để
      // lúc "Trình" ở màn chi tiết cũng đi đúng luồng.
      // Đơn đặt hàng: hỏi MỘT LẦN ở đây xem có ai giữ cờ Phòng Vật tư không,
      // rồi chốt vào route của chính đơn. Không ai giữ -> Giám đốc duyệt là xong.
      const coPvt = laDonDatHang ? await hasSigningVatTuApprover() : false;
      const route = buildSigningRoute(
        loai, d.pgd_qlda === "1", d.pgd_khdt === "1", coPvt, d.phong_qlda === "1"
      );
      const cap1 = await resolveCap1({
        submitterName: currentName || "",
        submitterEmail: currentEmail || "",
        dept: ((payload.don_vi as string) || currentDepartment || ""),
      });
      const routeFields = { route, cap1_email: cap1.email };

      // Dữ liệu để báo email cho cấp duyệt đầu tiên (chỉ khi TRÌNH, không phải
      // lưu nháp). Gom ở đây vì hai nhánh dưới lấy ma_phieu từ hai nguồn khác
      // nhau: phiếu cũ đã có sẵn, phiếu mới do trigger CSDL sinh lúc insert.
      let maPhieu: string | null = existing?.ma_phieu ?? null;

      if (existing) {
        // `.select()` + đếm dòng: RLS chặn UPDATE thì PostgreSQL không báo lỗi,
        // chỉ sửa 0 dòng — form sẽ đóng lại như thể đã lưu trong khi CSDL không
        // đổi gì (cùng lớp lỗi với sự cố 16/09/2026, xem migration 081).
        const { data: hit, error } = await supabase
          .from("signing_submissions")
          .update({ ...payload, ...routeFields, ...(submit ? { status: route[0] } : {}) })
          .eq("id", existing.id)
          .select("id");
        if (error) throw error;
        if (!hit?.length) {
          throw new Error(
            "Máy chủ từ chối ghi: tài khoản của bạn không được phép sửa phiếu ở bước này. " +
            "Phiếu KHÔNG thay đổi."
          );
        }
      } else {
        const { data, error } = await supabase.from("signing_submissions").insert([{
          ...payload,
          ...routeFields,
          status: submit ? route[0] : "nhap",
          created_by: currentEmail,
          created_by_name: currentName || null,
        }]).select("id, ma_phieu").single();
        if (error) throw error;
        maPhieu = (data?.ma_phieu as string) ?? null;
        // Liên kết ngược (vd dòng Kế hoạch TC) — chờ xong để khoá dòng chắc chắn.
        if (onCreated && data?.id) await onCreated(data.id as string);
      }

      // ─── BÁO CẤP DUYỆT ĐẦU TIÊN ───
      // Nút này trình phiếu đi thẳng, y hệt nút "Trình" ở màn hình chi tiết —
      // nên cũng phải gửi email y hệt. Thiếu đoạn này (trước 15/09/2026) thì
      // phiếu lập-và-trình một lèo nằm im ở bước cấp 1, không ai được báo.
      // Fire-and-forget: phiếu đã chuyển bước trong CSDL, SMTP hỏng không được
      // làm hỏng thao tác — cảnh báo nổi ở panel cha vì modal đóng ngay.
      if (submit) {
        const snapshot = {
          ma_phieu: maPhieu,
          hop_dong_so: (payload.hop_dong_so as string) || null,
          du_an: (payload.du_an as string) || null,
          chu_dau_tu: (payload.chu_dau_tu as string) || null,
          dot_so: (payload.dot_so as number) ?? null,
          de_nghi_thanh_toan: deNghiCuoi,
          cap1_email: cap1.email,
          created_by: existing?.created_by || currentEmail,
          created_by_name: existing?.created_by_name || currentName || null,
        };
        void notifySigningSubmitted({
          row: snapshot,
          firstStep: route[0],
          actorName: currentName || currentEmail,
        }).then((w) => { if (w) onMailWarn?.(w); });
      }

      onSaved();
      onClose();
    } catch (e) {
      const m = errText(e);
      setErr(
        /duplicate key|uq_signing_hopdong_dot/i.test(m)
          ? "Hợp đồng này đã có phiếu cho đợt đó rồi. Mở phiếu cũ ra sửa thay vì tạo mới."
          : m
      );
    } finally {
      setBusy("");
    }
  };

  // ─── Xuất Word ───
  const exportDocx = async () => {
    setBusy("export"); setErr("");
    try {
      // Xuất theo BẢN NHÁP đang gõ (chưa cần lưu), nên dựng payload từ `d` chứ
      // không dùng docxPayloadFromRow — hàm đó đọc phiếu đã lưu trong CSDL.
      //
      // Phiếu chuyển tiền đi ĐƯỜNG KHÁC HẲN hai loại kia: nó in ra tờ
      // HC-BM021/ĐNCT, đã có sẵn mẫu + route riêng (/api/export-invoice-payment
      // templateType "transfer") mà Hành chính và Kế hoạch TC đang dùng chung.
      // Không dựng mẫu Word thứ ba cho cùng một tờ giấy.
      if (laChuyenTien) {
        await exportTransferRequestDocx({
          kind: laTamUng ? "advance" : "transfer",
          paymentTime: d.hang_muc?.trim() || "",
          employeeName: currentName || currentEmail,
          employeeDept: d.don_vi || currentDepartment || "",
          reason: d.noi_dung_trinh?.trim() || d.ve_viec?.trim() || "",
          projectName: d.du_an || "",
          supplierName: d.chu_dau_tu || "",
          bankAccount: d.so_tai_khoan || "",
          bankNameBranch: d.ngan_hang || "",
          amount: deNghiCuoi || 0,
        });
        return;
      }
      // ĐƠN ĐẶT HÀNG in ra EXCEL — route riêng, KHÔNG phải downloadSigningForm.
      if (laDonDatHang) {
        const boQua = await downloadPurchaseOrder(
          {
            duAn: d.du_an, congTrinh: chiTiet.congTrinh || d.goi_thau,
            hangMuc: d.hang_muc, soDdh: chiTiet.soDdh, lanThu: d.dot_so,
            ngayDatHang: existing?.created_at || new Date().toISOString(),
            ngayDuKien: chiTiet.ngayDuKien,
            nguoiYeuCau: existing?.created_by_name || currentName || "",
            donViYeuCau: chiTiet.donViYeuCau, donViNhanNo: chiTiet.donViNhanNo,
            diaChiNhan: chiTiet.diaChiNhan,
            nguoiNhanHang: chiTiet.nguoiNhanHang, sdtNhanHang: chiTiet.sdtNhanHang,
            canBoKyThuat: chiTiet.canBoKyThuat, sdtKyThuat: chiTiet.sdtKyThuat,
            taiLieuKemTheo: chiTiet.taiLieuKemTheo,
            cdtThanhToan: chiTiet.cdtThanhToan,
            lyDoKhongThanhToan: chiTiet.lyDoKhongThanhToan,
            nguyenNhanPhatSinh: chiTiet.nguyenNhanPhatSinh,
            vatTu,
          },
          docxFileName({ ...(existing || {}), loai: "don_dat_hang", chi_tiet: chiTiet })
        );
        if (boQua > 0) {
          setErr(`Biểu mẫu Excel chỉ có 15 dòng vật tư — đơn này bị cắt mất ${boQua} dòng cuối. Tách thành 2 đơn hoặc tự chèn thêm dòng vào file tải về.`);
        }
        return;
      }
      // PHIẾU YÊU CẦU — Word, đi chung route với hồ sơ / hợp đồng / tờ trình.
      if (laPhieuYeuCau) {
        await downloadSigningForm(
          {
            loai: "phieu_yeu_cau",
            nguoiYeuCau: existing?.created_by_name || currentName || "",
            boPhan: d.don_vi || currentDepartment || "",
            noiDungYeuCau: d.noi_dung_trinh || d.ve_viec,
            ngayLap: existing?.created_at || new Date().toISOString(),
            vatTu,
          },
          docxFileName({ ...(existing || {}), loai: "phieu_yeu_cau" })
        );
        return;
      }
      // Tờ trình đi chung route /api/export-signing-form (mẫu thứ ba của route
      // đó), khác phiếu chuyển tiền — tờ TTr/Lodeza EOP là mẫu riêng của module này,
      // không dùng chung với Hành chính.
      if (laToTrinh) {
        await downloadSigningForm(
          {
            loai: "to_trinh",
            soToTrinh: d.so_to_trinh,
            // Phiếu chưa lưu thì lấy hôm nay; phiếu cũ giữ đúng ngày lập.
            ngayLap: existing?.created_at || new Date().toISOString(),
            donVi: d.don_vi || currentDepartment || "",
            veViec: d.ve_viec,
            canCu: d.can_cu,
            noiDung: d.noi_dung_trinh,
            donViBaoGia: d.chu_dau_tu,
            chiPhiDuKien: toNum(d.de_nghi_thanh_toan || ""),
            vatPercent: toRate(d.vat_percent || ""),
            dienGiaiChiPhi: d.hang_muc,
            kienNghi: d.kien_nghi,
            nguoiTrinh: existing?.created_by_name || currentName || "",
          },
          docxFileName({ ...(existing || {}), so_to_trinh: d.so_to_trinh, loai: "to_trinh" })
        );
        return;
      }
      if (laHopDong) {
        await downloadSigningForm(
          {
            loai: "hop_dong",
            donVi: d.don_vi,
            duAn: d.du_an,
            goiThau: d.goi_thau,
            hangMuc: d.hang_muc,
            hopDongSo: d.hop_dong_so,
            benA: d.ben_a,
            benB: d.ben_b,
            giaTriHD: toNum(d.gia_tri_hd || ""),
            vatPercent: toRate(d.vat_percent || ""),
            soSanh,
            ykienQLDA: existing?.ykien_qlda || "",
            ykienKHDT: existing?.ykien_khdt || "",
            ykienGiamDoc: existing?.ykien_giam_doc || "",
            nguoiTrinh: existing?.created_by_name || currentName || "",
          },
          docxFileName({ ...(existing || {}), hop_dong_so: d.hop_dong_so, loai: "hop_dong" })
        );
        return;
      }

      await downloadSigningForm(
        {
          donVi: d.don_vi, veViec: d.ve_viec, noiDungTrinh: d.noi_dung_trinh,
          dotSo: d.dot_so, chuDauTu: d.chu_dau_tu, duAn: d.du_an,
          hopDongSo: [d.hop_dong_so, d.ngay_ky_hop_dong ? `ký ngày ${d.ngay_ky_hop_dong}` : ""]
            .filter(Boolean).join(" "),
          goiThau: d.goi_thau,
          giaTriHD: toNum(d.gia_tri_hd || ""),
          giaTriNghiemThu: toNum(d.gia_tri_nghiem_thu || ""),
          giuBaoHanh: toNum(d.giu_bao_hanh || ""),
          giuLaiTungLan: toNum(d.giu_lai_tung_lan || ""),
          tyLeGiuLai: toRate(d.ty_le_giu_lai || ""),
          khauTruTamUng: toNum(d.khau_tru_tam_ung || ""),
          tyLeThuHoi: toRate(d.ty_le_thu_hoi || ""),
          deNghiThanhToan: deNghiCuoi,
          luyKeDaThanhToan: toNum(d.luy_ke_da_thanh_toan || ""),
          tamUngConLai: toNum(d.tam_ung_con_lai || ""),
          ykienQLDA: existing?.ykien_qlda || "",
          ykienKHDT: existing?.ykien_khdt || "",
          ykienGiamDoc: existing?.ykien_giam_doc || "",
          nguoiTrinh: existing?.created_by_name || currentName || "",
        },
        docxFileName({ hop_dong_so: d.hop_dong_so, dot_so: d.dot_so ? Number(d.dot_so) : null })
      );
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy("");
    }
  };

  const openFile = async (f: SigningFile) => {
    const url = await resolveDossierUrl(f.path);
    if (url) window.open(url, "_blank", "noopener");
    else setErr(`Không mở được "${f.name}" — tệp đã bị xoá hoặc tài khoản hết quyền.`);
  };

  const num = (k: string, label: string, hint?: string) => (
    <label className="flex flex-col gap-1.5">
      <span className={labelCls}>{label}</span>
      <input
        value={d[k] || ""}
        onChange={(e) => set(k, e.target.value)}
        placeholder={hint}
        inputMode="numeric"
        className={`${inputCls} font-mono text-right`}
      />
    </label>
  );

  return createPortal(
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-start justify-center pt-[5vh] p-4">
      <div
        className="bg-white rounded-2xl w-full max-w-4xl max-h-[88vh] overflow-hidden shadow-2xl border border-slate-100 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-200/60 bg-slate-50/70 shrink-0">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-600 to-cyan-500 flex items-center justify-center shadow-sm shrink-0">
            <FileText size={15} className="text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="font-heading font-extrabold text-slate-800 text-xs leading-tight truncate">
              {existing ? `Sửa phiếu ${existing.ma_phieu || ""}` : `Lập ${meta.label.toLowerCase()}`}
            </h4>
          </div>
          <button type="button" onClick={onClose} disabled={!!busy}
            className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-200 rounded-lg transition-all cursor-pointer disabled:opacity-40">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {err && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 flex items-start gap-2.5">
              <AlertTriangle size={15} className="text-rose-500 shrink-0 mt-0.5" />
              <p className="text-[11px] font-bold text-rose-700 flex-1">{err}</p>
              <button type="button" onClick={() => setErr("")}
                className="p-0.5 text-rose-400 hover:text-rose-600 cursor-pointer"><X size={13} /></button>
            </div>
          )}
          {info && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 flex items-start gap-2.5">
              <Sparkles size={15} className="text-blue-500 shrink-0 mt-0.5" />
              {/* whitespace-pre-line: nhật ký đọc tệp xuống dòng từng tệp một */}
              <p className="text-[11px] font-semibold text-blue-800 flex-1 whitespace-pre-line leading-relaxed">{info}</p>
              <button type="button" onClick={() => setInfo("")}
                className="p-0.5 text-blue-400 hover:text-blue-600 cursor-pointer"><X size={13} /></button>
            </div>
          )}

          {/* ─── 1. Hồ sơ + AI ─── */}
          <section className="space-y-3">
            <h5 className={labelCls}>1. Hồ sơ gốc</h5>
            <div className="border-2 border-dashed border-slate-200 rounded-xl p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileRef} type="file" multiple hidden
                  accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx"
                  onChange={(e) => {
                    const picked = Array.from(e.target.files || []);
                    doUpload(picked);
                    e.target.value = "";
                  }}
                />
                <button type="button" onClick={() => fileRef.current?.click()} disabled={!!busy}
                  className="flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-200 hover:border-blue-300 hover:text-blue-600 text-slate-600 font-bold rounded-xl text-[11px] transition-all cursor-pointer disabled:opacity-50">
                  <Upload size={13} /> Chọn file
                </button>
                <span className="text-[10px] font-semibold text-slate-400">
                  PDF · ảnh · Word · Excel — tối đa 8 tệp / 25MB
                </span>
                {/* Bóc tách AI đọc HỢP ĐỒNG + biên bản nghiệm thu để điền
                    A−B−C−D, đợt số, luỹ kế… — phiếu chuyển tiền không có ô nào
                    trong số đó, nên nút này ở đây chỉ gây hiểu nhầm. Ô đính kèm
                    thì vẫn giữ: giấy đề nghị chuyển tiền hay kèm hoá đơn/báo giá. */}
                {(laHoSo || laHopDong) && (
                <>
                <button type="button" onClick={runAI} disabled={!!busy || pending.length === 0}
                  className="flex items-center gap-1.5 px-3 py-2 bg-gradient-to-r from-blue-600 to-cyan-500 hover:opacity-90 disabled:opacity-40 text-white font-bold rounded-xl text-[11px] transition-all cursor-pointer">
                  {busy === "ai" ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  {busy === "ai"
                    ? "Đang đọc hồ sơ…"
                    : `Bóc tách ${pending.length || ""} tệp`.replace("  ", " ")}
                </button>
                <button
                  type="button"
                  onClick={() => setShowCfg((v) => !v)}
                  title="Cấu hình model và API key"
                  className={`ml-auto flex items-center gap-1.5 px-2.5 py-2 rounded-xl text-[11px] font-bold transition-all cursor-pointer border ${
                    showCfg
                      ? "bg-slate-100 border-slate-300 text-slate-700"
                      : "bg-white border-slate-200 text-slate-500 hover:border-blue-300 hover:text-blue-600"
                  }`}
                >
                  <Settings size={13} />
                  {aiModel}
                  {!aiKey.trim() && (
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" title="Chưa nhập API key riêng" />
                  )}
                </button>
                </>
                )}
              </div>

              {showCfg && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2.5">
                  <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-2.5">
                    <label className="flex flex-col gap-1.5">
                      <span className={labelCls}>Model</span>
                      <select value={aiModel} onChange={(e) => setAiModel(e.target.value)}
                        className={`${inputCls} cursor-pointer`}>
                        {AI_MODEL_OPTIONS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className={labelCls}>OpenAI API key</span>
                      <input type="password" value={aiKey} onChange={(e) => setAiKey(e.target.value)}
                        placeholder="sk-… (để trống sẽ dùng khoá cấu hình sẵn trên máy chủ)"
                        className={`${inputCls} font-mono`} autoComplete="off" />
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={saveCfg}
                      className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg text-[11px] transition-all cursor-pointer">
                      Lưu cấu hình
                    </button>
                    {cfgSaved && (
                      <span className="text-[11px] font-bold text-emerald-600">Đã lưu.</span>
                    )}
                  </div>
                </div>
              )}

              {files.length === 0 ? (
                <p className="text-[11px] text-slate-400 italic">Chưa có tệp nào.</p>
              ) : (
                <div className="space-y-1.5">
                  {files.map((f, i) => (
                    <div key={f.path} className="flex items-center gap-2 bg-slate-50 rounded-lg px-2.5 py-1.5">
                      <FileText size={12} className="text-slate-400 shrink-0" />
                      <button type="button" onClick={() => openFile(f)}
                        className="flex-1 min-w-0 text-left text-[11px] font-semibold text-slate-700 hover:text-blue-600 truncate cursor-pointer">
                        {f.name}
                      </button>
                      <ExternalLink size={11} className="text-slate-300 shrink-0" />
                      <button type="button"
                        onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}
                        className="p-1 text-rose-400 hover:text-rose-600 hover:bg-rose-50 rounded cursor-pointer">
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {(aiThieu.length > 0 || aiGhiChu) && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 space-y-1">
                  {aiThieu.length > 0 && (() => {
                    // Tách hai loại "thiếu" — trước đây gộp chung một dòng dài
                    // nên nhìn như AI đọc hỏng, trong khi phần lớn là số liệu
                    // KHÔNG NẰM trong hợp đồng, phải có biên bản nghiệm thu.
                    const TU_NGHIEM_THU = new Set([
                      "dotSo", "giaTriNghiemThu", "giuLaiTungLan",
                      "khauTruTamUng", "luyKeDaThanhToan", "tamUngConLai",
                    ]);
                    const canHoSo = aiThieu.filter((f) => TU_NGHIEM_THU.has(f));
                    const doSot = aiThieu.filter((f) => !TU_NGHIEM_THU.has(f));
                    return (
                      <>
                        {canHoSo.length > 0 && (
                          <p className="text-[11px] font-bold text-amber-800">
                            Chưa có số liệu đợt thanh toán ({canHoSo.join(", ")}) — mấy số này
                            nằm ở <strong>biên bản nghiệm thu / bảng xác định giá trị đợt</strong>,
                            hợp đồng không có. Tải thêm hồ sơ đó rồi bóc lại, hoặc điền tay.
                          </p>
                        )}
                        {doSot.length > 0 && (
                          <p className="text-[11px] font-bold text-amber-800">
                            Không đọc ra từ hồ sơ đã tải: {doSot.join(", ")} — cần điền tay.
                          </p>
                        )}
                      </>
                    );
                  })()}
                  {aiGhiChu && <p className="text-[11px] font-medium text-amber-700">{aiGhiChu}</p>}
                </div>
              )}
            </div>
          </section>

          {/* ─── 2. Đầu phiếu ─── */}
          <section className="space-y-3">
            <h5 className={labelCls}>2. Đầu phiếu (tự gõ)</h5>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
              <label className="flex flex-col gap-1.5">
                <span className={labelCls}>
                  {laToTrinh || laPhieuYeuCau ? "Bộ phận" : "Phòng ban"}
                </span>
                {/* Lấy danh sách phòng ban/BĐH từ danh bạ (bảng departments), mặc
                    định theo phòng của người lập; nhân viên BĐH thì mặc định đúng
                    BĐH đó. Vẫn cho chọn phòng ban khác trong danh sách. */}
                <select value={d.don_vi || ""} onChange={(e) => set("don_vi", e.target.value)}
                  className={`${inputCls} cursor-pointer`}>
                  <option value="">— Chọn phòng ban —</option>
                  {departments.all.map((dep) => (
                    <option key={dep} value={dep}>{dep}</option>
                  ))}
                  {/* Giá trị cũ không có trong danh sách (phiếu cũ / phòng đổi tên)
                      vẫn hiển thị được, không bị xoá mất khi mở ra sửa. */}
                  {d.don_vi && !departments.all.includes(d.don_vi) && (
                    <option value={d.don_vi}>{d.don_vi}</option>
                  )}
                </select>
              </label>
              {/* Số hiệu tờ trình do văn thư cấp SAU khi ký, nên để trống là
                  bình thường — tờ in ra sẽ có sẵn khung "………/26/TTr/Lodeza EOP" để
                  điền tay. */}
              {laToTrinh && (
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Số tờ trình</span>
                  <input value={d.so_to_trinh || ""} onChange={(e) => set("so_to_trinh", e.target.value)}
                    placeholder="012/026/TTr/Lodeza EOP — để trống nếu chưa cấp số"
                    className={`${inputCls} font-mono`} />
                </label>
              )}
              {/* Phiếu yêu cầu / đơn đặt hàng không có dòng "Về việc" trên tờ
                  giấy — nội dung nằm ở ô bên dưới và ở bảng vật tư. */}
              {!coBangVatTu && (
              <label className={`flex flex-col gap-1.5 ${laToTrinh ? "md:col-span-3" : "md:col-span-2"}`}>
                <span className={labelCls}>Về việc {laToTrinh && "*"}</span>
                <input value={d.ve_viec || ""} onChange={(e) => set("ve_viec", e.target.value)}
                  placeholder={laToTrinh
                    ? "Đề xuất nâng cấp giao diện website theo nhận diện thương hiệu mới."
                    : 'Kính trình BGĐ phê duyệt: "Hồ sơ thanh toán Đợt 02 (thanh toán A-B)".'}
                  className={inputCls} />
              </label>
              )}
              {/* Căn cứ — dòng in nghiêng mở đầu tờ trình, nêu cơ sở của đề nghị. */}
              {laToTrinh && (
                <label className="flex flex-col gap-1.5 md:col-span-3">
                  <span className={labelCls}>Căn cứ</span>
                  <input value={d.can_cu || ""} onChange={(e) => set("can_cu", e.target.value)}
                    placeholder="Căn cứ nhu cầu đồng bộ nhận diện thương hiệu trên các nền tảng digital…"
                    className={inputCls} />
                </label>
              )}
              <label className="flex flex-col gap-1.5 md:col-span-3">
                <span className={labelCls}>
                  {laToTrinh ? "Nội dung đề nghị *"
                    : laPhieuYeuCau ? "Nội dung yêu cầu *"
                    : laDonDatHang ? "Ghi chú chung (tuỳ chọn)"
                    : "Nội dung trình"}
                </span>
                {/* Tờ trình là một lá thư nên phần thân dài và xuống dòng nhiều
                    lần; ô một dòng của ba loại kia không đủ. Xuống dòng ở đây in
                    ra Word cũng xuống dòng đúng chỗ. */}
                {laToTrinh || laPhieuYeuCau ? (
                  <textarea value={d.noi_dung_trinh || ""} onChange={(e) => set("noi_dung_trinh", e.target.value)}
                    rows={laPhieuYeuCau ? 2 : 4}
                    placeholder={laPhieuYeuCau
                      ? "Yêu cầu làm bảng hiệu logo Lodeza EOP mới cho dự án Cầu Phước An"
                      : "Kính đề nghị Ban Giám đốc phê duyệt… (Enter để xuống dòng)"}
                    className={`${inputCls} resize-y leading-relaxed`} />
                ) : (
                  <input value={d.noi_dung_trinh || ""} onChange={(e) => set("noi_dung_trinh", e.target.value)}
                    className={inputCls} />
                )}
              </label>
              {/* Ô TÍCH CHỌN CẤP DUYỆT — tích vị nào thì chèn cấp đó vào luồng
                  (route dựng lúc lưu theo lựa chọn này).
                  · Phiếu hồ sơ / hợp đồng / chuyển tiền: hai ô THAM VẤN Phó Giám
                    đốc, không tích thì cấp 1 xong lên thẳng Giám đốc.
                  · ĐƠN ĐẶT HÀNG: đây là các CẤP DUYỆT THẬT trên tờ KD/BM/001
                    (Phòng QLDA rồi PGĐ QLDA), không phải tham vấn — nên đổi nhãn
                    và bỏ ô KHĐT, tờ đó không có ô ký nào cho KHĐT.
                  · TỜ TRÌNH không có khối này: TTr/Lodeza EOP chỉ in 3 ô ký, luồng cố
                    định 2 cấp; cho tích thêm là phiếu đi qua cấp không có chỗ ký. */}
              {!laToTrinh && (
              <div className="flex flex-col gap-1.5 md:col-span-3">
                <span className={labelCls}>
                  {laDonDatHang
                    ? "Trình duyệt qua các cấp (tích để đưa vào luồng)"
                    : "Tham vấn Phó Giám đốc (Tùy chọn - nếu cần)"}
                </span>
                <div className="flex flex-wrap gap-2">
                  {(laDonDatHang
                    ? ([
                        ["phong_qlda", "Phòng QLDA (Trưởng / Phó phòng)"],
                        ["pgd_qlda", "Phó Giám đốc phụ trách Dự án (QLDA)"],
                      ] as const)
                    : ([
                        ["pgd_qlda", "Phó Giám đốc phụ trách Dự án (QLDA)"],
                        ["pgd_khdt", "Phó Giám đốc phụ trách Kế hoạch Đấu thầu (KHĐT)"],
                      ] as const)
                  ).map(([k, lb]) => {
                    const on = d[k] === "1";
                    return (
                      <button key={k} type="button" onClick={() => set(k, on ? "" : "1")}
                        className={`flex items-center gap-2 px-3.5 py-2 rounded-xl border text-xs font-semibold transition-all cursor-pointer ${
                          on ? "bg-blue-50 border-blue-300 text-blue-700"
                             : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
                        }`}>
                        <span className={`w-4 h-4 rounded flex items-center justify-center shrink-0 ${
                          on ? "bg-blue-600 text-white" : "border border-slate-300"
                        }`}>
                          {on && <Check size={11} />}
                        </span>
                        {lb}
                      </button>
                    );
                  })}
                </div>
              </div>
              )}
            </div>
          </section>

          {/* Mục 3 là bộ ô của HỢP ĐỒNG (đối tác, số HĐ, gói thầu, đợt).
              Phiếu yêu cầu và đơn đặt hàng không có khái niệm nào trong số đó —
              chúng có mục 3 riêng bên dưới. */}
          {!coBangVatTu && (<>
          {/* ─── 3. Thông tin hợp đồng ─── */}
          <section className="space-y-3">
            <h5 className={labelCls}>
              {laChuyenTien ? "3. Người thụ hưởng & dự án"
                : laToTrinh ? "3. Đơn vị báo giá & dự án"
                : "3. Hợp đồng & dự án"}
            </h5>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {/* Chủ đầu tư chỉ có trên phiếu hồ sơ/văn bản. Phiếu hợp đồng nói
                  vai bằng ô "Bên A / Bên B" bên dưới, vì tuỳ loại hợp đồng mà
                  chủ đầu tư đứng vai A hay Lodeza EOP đứng vai A. */}
              {!laHopDong && (
                <div className="flex flex-col gap-1.5 md:col-span-2">
                  <span className={labelCls}>
                    {laChuyenTien ? "Đơn vị thụ hưởng"
                      : laToTrinh ? "Đơn vị báo giá (nếu có)"
                      : "Đơn vị / Đối tác"}
                  </span>
                  <div className="relative" ref={custRef}>
                    {d.chu_dau_tu ? (
                      // Đã chọn: hiện thành thẻ, bấm X để chọn lại.
                      <div className="w-full min-h-[38px] px-3 py-2 border border-slate-200 rounded-xl flex items-center gap-2 bg-white">
                        <span className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-cyan-400 text-white text-[9px] font-bold flex items-center justify-center shrink-0">
                          {(d.chu_dau_tu || "").split(" ").filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-xs font-bold text-slate-800 truncate">{d.chu_dau_tu}</span>
                          <span className="block text-[10px] font-semibold text-slate-400 truncate">
                            {partner
                              ? [
                                  PARTY_TYPE_LABELS[partner.party_type],
                                  partner.short_name || null,
                                  partnerAccount ? `TK ${partnerAccount.bank_account}${partnerAccount.bank_name ? ` · ${partnerAccount.bank_name}` : ""}` : null,
                                ].filter(Boolean).join(" • ")
                              : "Tên gõ tay — chưa có trong danh mục đối tác"}
                          </span>
                        </span>
                        <button type="button"
                          onClick={() => { pickPartner(""); setContractId(""); setCustSearch(""); setShowCust(true); }}
                          title="Chọn đơn vị / đối tác khác"
                          className="p-1 text-slate-300 hover:text-rose-500 rounded-lg transition-colors cursor-pointer shrink-0">
                          <X size={13} />
                        </button>
                      </div>
                    ) : (
                      <div className="w-full min-h-[38px] px-3 py-2 border border-slate-200 rounded-xl flex items-center gap-1.5 bg-white focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-400">
                        <Search size={12} className="text-slate-400 shrink-0" />
                        <input
                          type="text"
                          value={custSearch}
                          onChange={(e) => { setCustSearch(e.target.value); setShowCust(true); }}
                          onFocus={() => setShowCust(true)}
                          placeholder="Tìm đối tác trong danh mục hoặc gõ tên đơn vị…"
                          className="flex-1 min-w-0 py-0.5 outline-none text-xs font-semibold text-slate-800 placeholder:font-normal placeholder:text-slate-400 bg-transparent"
                        />
                      </div>
                    )}

                    {showCust && !d.chu_dau_tu && (
                      <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-premium z-20 max-h-56 overflow-y-auto">
                        {custResults.map((p) => (
                          <button key={p.id} type="button"
                            onClick={() => { pickPartner(p.name); setCustSearch(""); setShowCust(false); }}
                            className="w-full flex items-center gap-2.5 px-4 py-2 hover:bg-slate-50 transition-colors text-left cursor-pointer">
                            <span className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-cyan-400 text-white text-[9px] font-bold flex items-center justify-center shrink-0">
                              {p.name.split(" ").filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
                            </span>
                            <span className="flex-1 min-w-0">
                              <span className="block text-xs font-bold text-slate-700 truncate">{p.name}</span>
                              <span className="block text-[10px] text-slate-400 font-semibold truncate">
                                {PARTY_TYPE_LABELS[p.party_type]}{p.short_name ? ` • ${p.short_name}` : ""}
                              </span>
                            </span>
                          </button>
                        ))}

                        {/* Vẫn nhận tên NGOÀI danh mục: có đơn vị chưa kịp đưa vào. */}
                        {custSearch.trim() && !custResults.some((p) => foldVi(p.name) === foldVi(custSearch)) && (
                          <button type="button"
                            onClick={() => { pickPartner(custSearch.trim()); setCustSearch(""); setShowCust(false); }}
                            className="w-full flex items-center gap-2.5 px-4 py-2 hover:bg-blue-50 border-t border-slate-100 transition-colors text-left cursor-pointer">
                            <span className="w-6 h-6 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center shrink-0">
                              <Plus size={13} />
                            </span>
                            <span className="text-xs font-semibold text-slate-600 truncate">
                              Dùng tên gõ tay: “{custSearch.trim()}”
                            </span>
                          </button>
                        )}

                        {custResults.length === 0 && !custSearch.trim() && (
                          <p className="px-4 py-3 text-[11px] font-semibold text-slate-400">
                            Danh mục đối tác đang rỗng — thêm ở tab “Danh mục đối tác”.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Nhiều hợp đồng: KHÔNG đoán bừa — cho người lập chọn để điền hộ
                  dự án + số hợp đồng đã lưu (đè lên vì là thao tác cố ý). */}
              {laHoSo && partnerContracts.length > 1 && (
                <label className="flex flex-col gap-1.5 md:col-span-2">
                  <span className={labelCls}>Lấy theo hợp đồng đã lưu</span>
                  <select value={contractId}
                    onChange={(e) => {
                      const c = partnerContracts.find((x) => x.id === e.target.value);
                      if (c) applyContract(c, true); else setContractId("");
                    }}
                    className={`${inputCls} cursor-pointer`}>
                    <option value="">— Chọn 1 trong {partnerContracts.length} hợp đồng —</option>
                    {partnerContracts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {[c.contract_no, c.project_name].filter(Boolean).join(" · ") || "(hợp đồng chưa có số)"}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex flex-col gap-1.5 md:col-span-2">
                <span className={labelCls}>Dự án</span>
                <input value={d.du_an || ""} onChange={(e) => set("du_an", e.target.value)} className={inputCls} />
              </label>
              {/* Số tài khoản + ngân hàng: chỉ tờ ĐNCT mới có, và là hai ô
                  quan trọng nhất của nó (tiền đi đâu). Điền hộ từ danh mục đối
                  tác khi ô còn trống, nhưng vẫn cho sửa: có đơn vị đổi tài khoản
                  cho riêng một lần chi. */}
              {laChuyenTien && (
                <>
                  <label className="flex flex-col gap-1.5">
                    <span className={labelCls}>Số tài khoản thụ hưởng</span>
                    <input value={d.so_tai_khoan || ""} onChange={(e) => set("so_tai_khoan", e.target.value)}
                      placeholder="0123456789" className={`${inputCls} font-mono`} />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className={labelCls}>Ngân hàng — chi nhánh</span>
                    <input value={d.ngan_hang || ""} onChange={(e) => set("ngan_hang", e.target.value)}
                      placeholder="Vietcombank — CN Tân Bình" className={inputCls} />
                  </label>
                  {/* Chỉ giấy tạm ứng: hạn hoàn ứng / thanh toán. Lưu ở cột `hang_muc`. */}
                  {laTamUng && (
                    <label className="flex flex-col gap-1.5 md:col-span-2">
                      <span className={labelCls}>Thời gian thanh toán</span>
                      <input value={d.hang_muc || ""} onChange={(e) => set("hang_muc", e.target.value)}
                        placeholder="VD: Trước ngày 30/10/2026 hoặc Khi hoàn thành công tác" className={inputCls} />
                    </label>
                  )}
                </>
              )}
              {(laHoSo || laHopDong) && (
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Số hợp đồng *</span>
                  <input value={d.hop_dong_so || ""} onChange={(e) => set("hop_dong_so", e.target.value)}
                    className={`${inputCls} font-mono`} />
                </label>
              )}
              {laHoSo && (
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Ngày ký</span>
                  <input value={d.ngay_ky_hop_dong || ""} onChange={(e) => set("ngay_ky_hop_dong", e.target.value)}
                    placeholder="01/4/2026" className={inputCls} />
                </label>
              )}
              {/* Hạng mục — chỉ có trên tờ KHKT/BM/001 */}
              {laHopDong && (
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Hạng mục</span>
                  <input value={d.hang_muc || ""} onChange={(e) => set("hang_muc", e.target.value)}
                    className={inputCls} />
                </label>
              )}
              {(laHoSo || laHopDong) && (
                <label className="flex flex-col gap-1.5 md:col-span-2">
                  <span className={labelCls}>Gói thầu</span>
                  <input value={d.goi_thau || ""} onChange={(e) => set("goi_thau", e.target.value)} className={inputCls} />
                </label>
              )}
              <label className="flex flex-col gap-1.5">
                <span className={labelCls}>Dự án trong danh mục</span>
                <select value={d.project_code || ""} onChange={(e) => set("project_code", e.target.value)}
                  className={`${inputCls} cursor-pointer`}>
                  <option value="">— Không gắn —</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.code}>{p.code} — {p.name}</option>
                  ))}
                </select>
              </label>
              {laHoSo && (
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Đợt số *</span>
                  <input value={d.dot_so || ""} onChange={(e) => set("dot_so", e.target.value)}
                    inputMode="numeric" placeholder="2" className={`${inputCls} font-mono`} />
                </label>
              )}
              {/* 094 — ngày của ĐỢT NÀY, người lập chọn. Khác ô "Ngày chi" mà Kế
                  toán ghi ở chặng cuối: ngày đó chỉ có sau khi tiền đã ra khỏi
                  tài khoản, còn cột "đã thanh toán" ngoài danh sách phải đọc
                  được ngay từ lúc phiếu còn đang trình. */}
              {laHoSo && (
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Ngày thanh toán đợt này</span>
                  <input type="date" value={d.ngay_dot || ""} onChange={(e) => set("ngay_dot", e.target.value)}
                    className={`${inputCls} cursor-pointer`} />
                </label>
              )}
            </div>
          </section>
          </>)}

          {/* ─── 3. Thông tin đơn đặt hàng (chỉ đơn đặt hàng) ─── */}
          {laDonDatHang && (
            <section className="space-y-3">
              <h5 className={labelCls}>3. Thông tin đơn đặt hàng</h5>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {/* Dự án chọn từ DANH MỤC (bảng `projects`, migration 037 — 16 dự án
                    seed ở 048), không gõ tay: gõ tay thì mỗi người viết một kiểu
                    ("Cầu Ba Lai 8" / "Xây dựng cầu Ba Lai 8") và không đối chiếu
                    được với các module khác.
                    Ô select bám theo TÊN dự án chứ không phải mã, vì tên mới là
                    thứ in ra file Excel; `project_code` điền kèm để liên kết
                    danh mục. Cùng khuôn ô "Phòng ban" ở mục 2. */}
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Dự án *</span>
                  {projects.length > 0 ? (
                    <select
                      value={d.du_an || ""}
                      onChange={(e) => {
                        const ten = e.target.value;
                        const p = projects.find((x) => x.name === ten);
                        setD((prev) => ({ ...prev, du_an: ten, project_code: p?.code || "" }));
                      }}
                      className={`${inputCls} cursor-pointer`}>
                      <option value="">— Chọn dự án —</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.name}>{p.code} — {p.name}</option>
                      ))}
                      {/* Đơn cũ trỏ vào dự án đã gỡ khỏi danh mục vẫn hiện được,
                          không bị xoá mất khi mở ra sửa. */}
                      {d.du_an && !projects.some((p) => p.name === d.du_an) && (
                        <option value={d.du_an}>{d.du_an} (ngoài danh mục)</option>
                      )}
                    </select>
                  ) : (
                    // LƯỚI AN TOÀN: danh mục dự án có thể đang RỖNG (bảng `projects`
                    // cố ý không seed mẫu — xem lib/projectCatalog.ts). Đổi hẳn sang
                    // select thì lúc đó ô này thành ngõ cụt: Dự án là trường bắt
                    // buộc, không chọn được là không trình nổi đơn nào.
                    <>
                      <input value={d.du_an || ""} onChange={(e) => set("du_an", e.target.value)}
                        placeholder="Xây dựng cầu Ba Lai 8" className={inputCls} />
                      <span className="text-[10px] font-semibold text-amber-600">
                        Danh mục dự án đang rỗng — thêm ở Cài đặt → Danh mục công việc
                        để lần sau chọn từ danh sách.
                      </span>
                    </>
                  )}
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Công trình</span>
                  <input value={chiTiet.congTrinh || ""} onChange={(e) => setCt("congTrinh", e.target.value)}
                    placeholder="Gói thầu số 1A" className={inputCls} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Cấp cho hạng mục</span>
                  <input value={d.hang_muc || ""} onChange={(e) => set("hang_muc", e.target.value)}
                    placeholder="Thép xây dựng" className={inputCls} />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1.5">
                    <span className={labelCls}>Số ĐĐH</span>
                    <input value={chiTiet.soDdh || ""} onChange={(e) => setCt("soDdh", e.target.value)}
                      placeholder="809" className={`${inputCls} font-mono`} />
                  </label>
                  {/* "Yêu cầu lần thứ" dùng lại cột `dot_so` — cùng nghĩa "đợt
                      thứ mấy", không đẻ thêm cột chỉ để chứa một con số. */}
                  <label className="flex flex-col gap-1.5">
                    <span className={labelCls}>Yêu cầu lần thứ</span>
                    <input value={d.dot_so || ""} onChange={(e) => set("dot_so", e.target.value)}
                      inputMode="numeric" placeholder="1" className={`${inputCls} font-mono`} />
                  </label>
                </div>
                {/* KHÔNG có ô "Tổng dự toán" ở đây. Ba cột Dự toán · Cấp phát ·
                    Còn lại ngoài danh sách đọc thẳng từ BẢNG VẬT TƯ bên dưới —
                    cột (4) và (5a)/(5b) — nên bắt gõ lại một lần nữa ở đầu phiếu
                    chỉ đẻ ra hai con số có thể lệch nhau. */}
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Ngày cấp phát lần này</span>
                  <input type="date" value={d.ngay_dot || ""} onChange={(e) => set("ngay_dot", e.target.value)}
                    className={`${inputCls} cursor-pointer`} />
                  <span className="text-[10px] font-semibold text-slate-400 leading-snug">
                    Để trống thì lấy ngày lập phiếu.
                  </span>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Đơn vị yêu cầu (sử dụng cuối)</span>
                  <input value={chiTiet.donViYeuCau || ""} onChange={(e) => setCt("donViYeuCau", e.target.value)}
                    className={inputCls} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Đơn vị nhận nợ từ TNG</span>
                  <input value={chiTiet.donViNhanNo || ""} onChange={(e) => setCt("donViNhanNo", e.target.value)}
                    className={inputCls} />
                </label>
                <label className="flex flex-col gap-1.5 md:col-span-2">
                  <span className={labelCls}>Địa chỉ nhận hàng</span>
                  <input value={chiTiet.diaChiNhan || ""} onChange={(e) => setCt("diaChiNhan", e.target.value)}
                    placeholder="Xã Thạnh Phước, tỉnh Vĩnh Long" className={inputCls} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Ngày dự kiến sử dụng</span>
                  <input value={chiTiet.ngayDuKien || ""} onChange={(e) => setCt("ngayDuKien", e.target.value)}
                    placeholder="30/09/2026" className={inputCls} />
                </label>
                <div className="grid grid-cols-[1fr_140px] gap-2">
                  <label className="flex flex-col gap-1.5">
                    <span className={labelCls}>Người nhận hàng</span>
                    <input value={chiTiet.nguoiNhanHang || ""} onChange={(e) => setCt("nguoiNhanHang", e.target.value)}
                      className={inputCls} />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className={labelCls}>Điện thoại</span>
                    <input value={chiTiet.sdtNhanHang || ""} onChange={(e) => setCt("sdtNhanHang", e.target.value)}
                      inputMode="tel" className={`${inputCls} font-mono`} />
                  </label>
                </div>
                <div className="grid grid-cols-[1fr_140px] gap-2 md:col-span-2">
                  <label className="flex flex-col gap-1.5">
                    <span className={labelCls}>Cán bộ kỹ thuật</span>
                    <input value={chiTiet.canBoKyThuat || ""} onChange={(e) => setCt("canBoKyThuat", e.target.value)}
                      className={inputCls} />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className={labelCls}>Điện thoại</span>
                    <input value={chiTiet.sdtKyThuat || ""} onChange={(e) => setCt("sdtKyThuat", e.target.value)}
                      inputMode="tel" className={`${inputCls} font-mono`} />
                  </label>
                </div>
                <label className="flex flex-col gap-1.5 md:col-span-2">
                  <span className={labelCls}>Yêu cầu tài liệu kèm theo</span>
                  <input value={chiTiet.taiLieuKemTheo || ""} onChange={(e) => setCt("taiLieuKemTheo", e.target.value)}
                    placeholder="Cung cấp đầy đủ hoá đơn, hồ sơ, chứng chỉ chất lượng liên quan"
                    className={inputCls} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Khối lượng có được CĐT thanh toán</span>
                  <select value={chiTiet.cdtThanhToan || ""} onChange={(e) => setCt("cdtThanhToan", e.target.value)}
                    className={`${inputCls} cursor-pointer`}>
                    <option value="">— Chưa xác định —</option>
                    <option value="Có">Có</option>
                    <option value="Không">Không</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Nguyên nhân phát sinh</span>
                  <input value={chiTiet.nguyenNhanPhatSinh || ""} onChange={(e) => setCt("nguyenNhanPhatSinh", e.target.value)}
                    placeholder="Phát sinh ngoài hợp đồng" className={inputCls} />
                </label>
                {/* Chỉ hỏi lý do khi đã chọn "Không" — hiện sẵn lúc chưa chọn gì
                    là bắt người lập đoán xem có phải điền hay không. */}
                {chiTiet.cdtThanhToan === "Không" && (
                  <label className="flex flex-col gap-1.5 md:col-span-2">
                    <span className={labelCls}>Nếu không được thanh toán, nêu rõ lý do</span>
                    <input value={chiTiet.lyDoKhongThanhToan || ""} onChange={(e) => setCt("lyDoKhongThanhToan", e.target.value)}
                      className={inputCls} />
                  </label>
                )}
              </div>
            </section>
          )}

          {/* ─── 4. Bảng vật tư (phiếu yêu cầu · đơn đặt hàng) ─── */}
          {coBangVatTu && (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <h5 className={labelCls}>
                  {laDonDatHang ? "4. Bảng vật tư đặt hàng" : "4. Bảng vật tư / hàng hoá"}
                  {" "}({vatTu.length} dòng)
                </h5>
                <button type="button" onClick={() => setVatTu((v) => [...v, {}])}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-white border border-slate-200 hover:border-blue-300 hover:text-blue-600 text-slate-600 font-bold rounded-lg text-[10px] transition-all cursor-pointer">
                  <Plus size={12} /> Thêm dòng
                </button>
              </div>

              {/* Bảng 12 cột không vừa bề ngang modal -> CUỘN NGANG, không thu
                  nhỏ ô nhập. Không có ô "STT": số thứ tự do hệ thống đánh lúc
                  xuất file, bắt gõ tay chỉ sinh ra phiếu đánh số nhảy cóc. */}
              <div className="overflow-x-auto -mx-1 px-1">
                <div style={{ minWidth: laDonDatHang ? 1560 : 740 }} className="space-y-2">
                  <div className="grid gap-2 px-1"
                    style={{ gridTemplateColumns: VAT_TU_COLS(laDonDatHang).map((c) => c.w).join(" ") + " 28px" }}>
                    {VAT_TU_COLS(laDonDatHang).map((c) => (
                      <span key={c.key} className={`${labelCls} leading-tight`}>{c.label}</span>
                    ))}
                    <span />
                  </div>
                  {vatTu.map((r, i) => (
                    <div key={i} className="grid gap-2 items-start"
                      style={{ gridTemplateColumns: VAT_TU_COLS(laDonDatHang).map((c) => c.w).join(" ") + " 28px" }}>
                      {VAT_TU_COLS(laDonDatHang).map((c) => (
                        <input key={c.key}
                          value={r[c.key] || ""}
                          onChange={(e) => setVatTu((prev) =>
                            prev.map((x, j) => (j === i ? { ...x, [c.key]: e.target.value } : x)))}
                          placeholder={c.hint}
                          inputMode={c.num ? "decimal" : undefined}
                          className={`${inputCls} ${c.num ? "font-mono text-right" : ""}`} />
                      ))}
                      <button type="button" onClick={() => setVatTu((prev) => prev.filter((_, j) => j !== i))}
                        title="Xoá dòng"
                        className="p-1.5 text-slate-300 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all cursor-pointer mt-0.5">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Đơn đặt hàng KHÔNG có dòng mô tả này (user chốt 23/09/2026):
                  form đã dài, đoạn chữ xám cuối trang không ai đọc. Phiếu yêu
                  cầu vẫn giữ — form của nó ngắn, câu này còn nói được việc. */}
              {!laDonDatHang && (
                <p className="text-[11px] font-semibold text-slate-400">
                  Dòng để trống tự bỏ khi lưu; số thứ tự do hệ thống đánh lúc in.{" "}
                  Phiếu đi <strong className="text-slate-500">2 cấp</strong>: Phụ trách bộ phận{" → "}Thủ trưởng đơn vị.
                </p>
              )}
            </section>
          )}

          {/* ─── 4b. Chủ thể + giá trị + bảng so sánh (chỉ phiếu hợp đồng) ─── */}
          {laHopDong && (
            <section className="space-y-3">
              <h5 className={labelCls}>4. Chủ thể &amp; giá trị hợp đồng</h5>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {/* KHÔNG mặc định Lodeza EOP vào ô nào: hợp đồng A-B thì Bên A là
                    chủ đầu tư, hợp đồng B-B′ thì Bên A mới là Lodeza EOP. */}
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Bên A</span>
                  <input value={d.ben_a || ""} onChange={(e) => set("ben_a", e.target.value)}
                    className={inputCls} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Bên B</span>
                  <input value={d.ben_b || ""} onChange={(e) => set("ben_b", e.target.value)}
                    className={inputCls} />
                </label>
                <div className="grid grid-cols-[1fr_100px] gap-2">
                  {num("gia_tri_hd", "Giá trị hợp đồng")}
                  <label className="flex flex-col gap-1.5">
                    <span className={labelCls}>VAT %</span>
                    <input value={d.vat_percent || ""} onChange={(e) => set("vat_percent", e.target.value)}
                      inputMode="decimal" placeholder="8" className={`${inputCls} font-mono text-right`} />
                  </label>
                </div>
              </div>

              {/* ─── Bảng so sánh A-B ↔ B-B′ ───
                  Số dòng THÊM/BỚT được nên đây là danh sách động, không phải 6 ô
                  cố định. Mở phiếu mới thì có sẵn 6 dòng a–f theo tờ mẫu để khỏi
                  gõ lại tên mục. */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h5 className={labelCls}>Nội dung so sánh ({soSanh.length} dòng)</h5>
                  <button type="button" onClick={() => setSoSanh((v) => [...v, { stt: "", muc: "", ab: "", bb: "" }])}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-white border border-slate-200 hover:border-blue-300 hover:text-blue-600 text-slate-600 font-bold rounded-lg text-[10px] transition-all cursor-pointer">
                    <Plus size={12} /> Thêm dòng
                  </button>
                </div>

                <div className="hidden md:grid grid-cols-[36px_1fr_1fr_1fr_28px] gap-2 px-1">
                  <span className={labelCls}>TT</span>
                  <span className={labelCls}>Nội dung</span>
                  <span className={labelCls}>Hợp đồng A-B</span>
                  <span className={labelCls}>Hợp đồng B-B′</span>
                  <span />
                </div>

                {soSanh.map((r, i) => {
                  const upd = (k: keyof SoSanhRow, v: string) =>
                    setSoSanh((prev) => prev.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
                  return (
                    <div key={i} className="grid grid-cols-1 md:grid-cols-[36px_1fr_1fr_1fr_28px] gap-2 items-start">
                      <input value={r.stt} onChange={(e) => upd("stt", e.target.value)}
                        placeholder={`${String.fromCharCode(97 + i)})`}
                        className={`${inputCls} text-center font-mono px-1`} />
                      <input value={r.muc} onChange={(e) => upd("muc", e.target.value)}
                        placeholder="Tạm ứng" className={inputCls} />
                      <textarea value={r.ab} onChange={(e) => upd("ab", e.target.value)} rows={2}
                        className={`${inputCls} resize-y leading-relaxed`} />
                      <textarea value={r.bb} onChange={(e) => upd("bb", e.target.value)} rows={2}
                        className={`${inputCls} resize-y leading-relaxed`} />
                      <button type="button" onClick={() => setSoSanh((prev) => prev.filter((_, j) => j !== i))}
                        title="Xoá dòng"
                        className="p-1.5 text-slate-300 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all cursor-pointer mt-0.5">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* ─── 4b. Số tiền đề nghị chuyển (chỉ phiếu chuyển tiền) ─── */}
          {laChuyenTien && (
            <section className="space-y-3">
              <h5 className={labelCls}>4. Số tiền đề nghị {laTamUng ? "tạm ứng" : "chuyển"}</h5>
              {/* MỘT con số duy nhất, gõ thẳng. Tờ ĐNCT không có nghiệm thu,
                  giữ bảo hành hay khấu trừ tạm ứng để mà trừ ra — đưa bảng
                  A−B−C−D vào đây chỉ làm người lập phải bỏ qua 8 ô trống. */}
              <div className="bg-gradient-to-r from-emerald-600 to-teal-600 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-bold text-emerald-100 uppercase tracking-wider">
                    Số tiền đề nghị {laTamUng ? "tạm ứng" : "chuyển"}
                  </p>
                  <p className="font-heading font-extrabold text-white text-xl leading-tight mt-0.5">
                    {fmtMoney(deNghiCuoi)} <span className="text-xs font-bold text-emerald-100">đồng</span>
                  </p>
                </div>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-bold text-emerald-100 uppercase tracking-wider">
                    Số tiền (VNĐ)
                  </span>
                  <input value={d.de_nghi_thanh_toan || ""} onChange={(e) => set("de_nghi_thanh_toan", e.target.value)}
                    inputMode="numeric" placeholder="0"
                    className="border border-white/30 bg-white/10 rounded-lg px-2.5 py-1.5 text-xs font-mono font-bold text-white placeholder:text-emerald-200/70 outline-none focus:bg-white/20 w-44 text-right" />
                </label>
              </div>
            </section>
          )}

          {/* ─── 4b. Chi phí dự kiến & kiến nghị (chỉ tờ trình) ─── */}
          {laToTrinh && (
            <section className="space-y-3">
              <h5 className={labelCls}>4. Chi phí dự kiến &amp; kiến nghị</h5>
              {/* Chi phí là ô TÙY CHỌN: có tờ trình chỉ xin chủ trương, chưa có
                  con số nào. Bỏ trống thì tờ in ra không có dòng chi phí chứ
                  không in "0 đồng". */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                <div className="grid grid-cols-[1fr_100px] gap-2">
                  {num("de_nghi_thanh_toan", "Giá dự kiến (VNĐ)", "13.500.000")}
                  <label className="flex flex-col gap-1.5">
                    <span className={labelCls}>VAT %</span>
                    <input value={d.vat_percent || ""} onChange={(e) => set("vat_percent", e.target.value)}
                      inputMode="decimal" placeholder="8" className={`${inputCls} font-mono text-right`} />
                  </label>
                </div>
                {/* Dùng lại cột `hang_muc` — với tờ trình nó là câu diễn giải đi
                    kèm con số, in ngay sau "Giá dự kiến: …" trên cùng một dòng. */}
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Diễn giải kèm giá</span>
                  <input value={d.hang_muc || ""} onChange={(e) => set("hang_muc", e.target.value)}
                    placeholder="nâng cấp toàn bộ với 3 phiên bản Anh, Việt, Trung"
                    className={inputCls} />
                </label>
                <label className="flex flex-col gap-1.5 md:col-span-2">
                  <span className={labelCls}>Kiến nghị *</span>
                  <textarea value={d.kien_nghi || ""} onChange={(e) => set("kien_nghi", e.target.value)}
                    rows={3}
                    placeholder="Bộ phận … kính đề nghị Ban Giám đốc xem xét và phê duyệt để triển khai…"
                    className={`${inputCls} resize-y leading-relaxed`} />
                </label>
              </div>
              <p className="text-[11px] font-semibold text-slate-400">
                Tờ trình đi <strong className="text-slate-500">2 cấp</strong>: Trưởng bộ phận
                {" → "}Ban Giám đốc. Ô “NGƯỜI TRÌNH KÝ” trên tờ in ra điền sẵn tên{" "}
                <strong className="text-slate-500">{currentName || currentEmail}</strong>.
              </p>
            </section>
          )}

          {/* ─── 4. Số liệu (chỉ phiếu hồ sơ/văn bản) ─── */}
          {laHoSo && (
          <section className="space-y-3">
            <h5 className={labelCls}>4. Số liệu đợt thanh toán</h5>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {num("gia_tri_hd", "Giá trị HĐ")}
              {num("gia_tri_nghiem_thu", "Giá trị nghiệm thu đợt này (A)")}
              {num("giu_bao_hanh", "Giữ bảo hành (B)")}
              <div className="grid grid-cols-[1fr_88px] gap-2">
                {num("giu_lai_tung_lan", "Giữ lại từng lần (C)")}
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Tỉ lệ %</span>
                  <input value={d.ty_le_giu_lai || ""} onChange={(e) => set("ty_le_giu_lai", e.target.value)}
                    placeholder="5" className={`${inputCls} font-mono text-right`} />
                </label>
              </div>
              <div className="grid grid-cols-[1fr_88px] gap-2">
                {num("khau_tru_tam_ung", "Khấu trừ tạm ứng (D)")}
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>Thu hồi %</span>
                  <input value={d.ty_le_thu_hoi || ""} onChange={(e) => set("ty_le_thu_hoi", e.target.value)}
                    placeholder="46.5" className={`${inputCls} font-mono text-right`} />
                </label>
              </div>
              {num("tam_ung_con_lai", "Tạm ứng còn lại chưa thu hồi")}
              <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
                {num("luy_ke_da_thanh_toan", "Luỹ kế đã thanh toán")}
                <button type="button" onClick={autoLuyKe} disabled={!!busy}
                  title="Cộng từ các đợt trước của cùng hợp đồng"
                  className="h-[34px] px-2.5 bg-white border border-slate-200 hover:border-blue-300 hover:text-blue-600 text-slate-500 rounded-xl cursor-pointer disabled:opacity-50">
                  <Calculator size={14} />
                </button>
              </div>
            </div>

            {/* A-B-C-D */}
            <div className="bg-gradient-to-r from-blue-600 to-[#005BAC] rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-bold text-blue-100 uppercase tracking-wider">
                  Giá trị đề nghị thanh toán (A−B−C−D)
                </p>
                <p className="font-heading font-extrabold text-white text-xl leading-tight mt-0.5">
                  {fmtMoney(deNghiCuoi)} <span className="text-xs font-bold text-blue-100">đồng</span>
                </p>
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-bold text-blue-100 uppercase tracking-wider">
                  Ghi đè (để trống = tự tính)
                </span>
                <input value={d.de_nghi_thanh_toan || ""} onChange={(e) => set("de_nghi_thanh_toan", e.target.value)}
                  placeholder={showNum(abcd)}
                  className="border border-white/30 bg-white/10 rounded-lg px-2.5 py-1.5 text-xs font-mono font-bold text-white placeholder:text-blue-200/70 outline-none focus:bg-white/20 w-44 text-right" />
              </label>
            </div>
          </section>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-200/60 bg-slate-50/70 px-5 py-3 flex flex-wrap justify-end gap-2 shrink-0">
          <button type="button" onClick={exportDocx} disabled={!!busy}
            className="mr-auto flex items-center gap-1.5 px-3 py-2 text-slate-600 hover:bg-slate-200/60 font-bold rounded-xl text-[11px] transition-all cursor-pointer disabled:opacity-50">
            {busy === "export" ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            Xuất phiếu Word
          </button>
          <button type="button" onClick={onClose} disabled={!!busy}
            className="px-4 py-2 text-slate-500 hover:bg-slate-200/60 font-bold rounded-xl text-xs transition-all cursor-pointer disabled:opacity-50">
            Đóng
          </button>
          <button type="button" onClick={() => save(false)} disabled={!!busy}
            className="flex items-center gap-1.5 px-4 py-2 bg-white border border-slate-200 hover:border-blue-300 text-slate-700 text-xs font-bold rounded-xl transition-all cursor-pointer disabled:opacity-50">
            {busy === "save" ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Lưu nháp
          </button>
          <button type="button" onClick={() => save(true)} disabled={!!busy}
            className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-xs font-semibold px-4 py-2 rounded-xl shadow-md shadow-blue-500/10 transition-all cursor-pointer">
            {busy === "submit" ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            Trình duyệt
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
