"use client";

// ============================================================
// SigningPanel — danh sách phiếu trình ký + hộp duyệt của từng cấp.
//
// Một màn hình phục vụ 3 vai khác nhau, phân biệt bằng bộ lọc chứ không tách
// trang: người lập (xem phiếu của mình), cấp duyệt (xem việc cần xử lý), và
// người theo dõi (xem toàn bộ). Tách 3 trang thì cùng một dữ liệu phải dựng 3
// lần, mà thực tế một người có thể kiêm nhiều vai.
//
// Luật hiển thị lấy từ lib/signingSubmissions (canActOn / canEdit). Chốt chặn
// thật nằm ở trigger + RLS của migration 050 — ẩn nút chỉ là cho gọn mắt.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/lib/supabase";
import { useCurrentUser } from "@/lib/useCurrentUser";
import SigningFormModal from "./SigningFormModal";
import { exportTransferRequestDocx } from "./TransferRequestPreview";
import { apiFetch } from "@/lib/apiClient";
import { crumpleToss } from "@/lib/crumpleToss";
import { isResignedRow } from "@/lib/resigned";
import { useConfirmBox } from "@/components/ConfirmDialog";
import {
  fetchSubmissions, canActOn, canEdit, advanceStatus, stepsOfSubmission, tinhDeNghi,
  soLieuChinh, conLai, deNghiCapPhat, tienDoBuoc, fmtNgayNgan,
  fetchDotList, khoaNhomDot, type DotRow,
  fmtMoney, fmtDateTime, resolveDossierUrl, fetchStageApproverEmails, errText,
  normalizeStatus, pgdOpinionField, downloadSigningForm, docxPayloadFromRow, docxFileName,
  deleteSubmission, duplicateSubmission, appendDossierFiles, removeDossierFile, canDelete,
  pushToPaymentDossier, downloadPurchaseOrder, ddhPayloadFromRow,
  STATUS_META, ACTION_LABEL, EVENT_LABEL, FLOW, LOAI_META,
  type SigningSubmission, type SigningStatus, type SigningLoai,
} from "@/lib/signingSubmissions";
import {
  FileText, Plus, Loader2, Search, AlertTriangle, X, Check,
  Undo2, Inbox, ClipboardCheck, CircleDot, ExternalLink, Pencil, Send, Download, Trash2,
  CopyPlus, Eye, Upload, FileWarning, Calendar,
} from "lucide-react";

// Cột "File gốc" chỉ nhận PDF và ảnh, tối đa 4MB. Chặt hơn hẳn ô tải hồ sơ
// trong form soạn phiếu (8 tệp / 25MB, nhận cả Word/Excel) — đây là chỗ đính
// kèm nhanh ngay trên danh sách, không phải nơi nộp cả bộ hồ sơ.
const QUICK_MAX_BYTES = 4 * 1024 * 1024;
const QUICK_ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp";
const QUICK_TYPE_RE = /\.(pdf|png|jpe?g|webp)$/i;

const labelCls = "text-[10px] font-bold text-slate-400 uppercase tracking-wider";
// Nhãn cột trên thanh tiêu đề nền xanh — cùng cỡ chữ với labelCls, khác mỗi màu.
const headCls = "text-[10px] font-extrabold text-white uppercase tracking-wider";

// Câu báo khi UPDATE đi lọt nhưng sửa 0 dòng — tức RLS đã chặn. PostgreSQL
// không coi đó là lỗi, nên nếu không tự kiểm thì giao diện sẽ báo thành công
// trong khi CSDL không đổi gì (sự cố 16/09/2026 — cấp 1 và Phó Giám đốc bấm
// duyệt/trả lại mà phiếu đứng im, vá ở migration 081).
const KHONG_GHI_DUOC =
  "Máy chủ từ chối ghi: tài khoản của bạn không được phép đổi trạng thái phiếu ở bước này. " +
  "Phiếu KHÔNG thay đổi. Báo quản trị kiểm tra quyền duyệt (migration 081).";
const inputCls =
  "border border-slate-200 rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 font-semibold text-slate-800 text-xs bg-white transition-all";

// MỘT bộ lọc duy nhất thay cho hai nhóm nút (trạng thái + loại) trước đây.
// Hai nhóm nằm cạnh nhau trông như hai thứ độc lập nhưng thực tế người dùng chỉ
// bấm một cái mỗi lần, và tổng 6 nút chiếm gần nửa chiều ngang thanh công cụ.
type Filter =
  | "tat_ca" | "ho_so" | "hop_dong" | "chuyen_tien" | "to_trinh"
  | "phieu_yeu_cau" | "don_dat_hang" | "tam_ung" | "cua_toi";

// Bảy nút lập phiếu — dữ liệu hoá để thêm loại thứ tám chỉ thêm một dòng.
// Lớp màu viết ĐẦY ĐỦ (không ghép chuỗi) để Tailwind quét thấy.
const NUT_LAP_PHIEU: { loai: SigningLoai; label: string; title: string; cls: string }[] = [
  { loai: "ho_so", label: "Hồ sơ / Văn bản", cls: "bg-blue-600 hover:bg-blue-700 shadow-blue-500/10",
    title: "Trình duyệt một đợt thanh toán của hợp đồng đã ký (TL/BM/011)" },
  { loai: "hop_dong", label: "Hợp đồng", cls: "bg-violet-600 hover:bg-violet-700 shadow-violet-500/10",
    title: "Trình duyệt nội dung hợp đồng trước khi ký (KHKT/BM/001)" },
  { loai: "chuyen_tien", label: "Chuyển tiền", cls: "bg-emerald-600 hover:bg-emerald-700 shadow-emerald-500/10",
    title: "Đề nghị chuyển tiền cho một khoản chi (HC-BM021/ĐNCT)" },
  { loai: "tam_ung", label: "Tạm ứng", cls: "bg-rose-600 hover:bg-rose-700 shadow-rose-500/10",
    title: "Giấy đề nghị tạm ứng (TCKT/BM/001)" },
  { loai: "to_trinh", label: "Tờ trình", cls: "bg-indigo-600 hover:bg-indigo-700 shadow-indigo-500/10",
    title: "Trình Ban Giám đốc một đề xuất / xin chủ trương (TTr/Lodeza EOP)" },
  { loai: "phieu_yeu_cau", label: "Phiếu yêu cầu", cls: "bg-amber-600 hover:bg-amber-700 shadow-amber-500/10",
    title: "Yêu cầu cấp vật tư, hàng hoá, máy móc thiết bị (HC-BM 023/PYC)" },
  { loai: "don_dat_hang", label: "Đơn đặt hàng", cls: "bg-teal-600 hover:bg-teal-700 shadow-teal-500/10",
    title: "Đơn đặt hàng vật tư cho dự án — xuất Excel (KD/BM/001)" },
];

// `created_at` là timestamptz — cắt 10 ký tự đầu là lấy ngày theo giờ UTC, nên
// phiếu lập sau 7 giờ tối giờ VN sẽ bị tính sang ngày hôm sau và rơi ra ngoài
// khoảng lọc. Phải đổi múi giờ đàng hoàng.
function ngayVN(iso: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
}

const homNay = (): string => ngayVN(new Date().toISOString());

/** Mùng 1 -> ngày cuối của tháng chứa `iso`. */
function tronThang(iso: string): { from: string; to: string } {
  const [y, m] = iso.split("-").map(Number);
  const cuoi = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(cuoi).padStart(2, "0")}` };
}

const ddmmyyyy = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso || "";
};

export default function SigningPanel() {
  const user = useCurrentUser();
  const [rows, setRows] = useState<SigningSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState<Filter>("tat_ca");
  const [search, setSearch] = useState("");
  // Khoảng ngày LẬP PHIẾU. Để TRỐNG mặc định = xem tất cả.
  //
  // KHÁC Kế hoạch TC (mở ra là trọn tháng này) và đó là chủ đích: kế hoạch tài
  // chính lập theo tháng, còn phiếu trình ký thì chạy vắt qua nhiều tháng —
  // mặc định bó vào tháng hiện tại sẽ GIẤU MẤT phiếu tháng trước còn đang chờ
  // duyệt, cấp duyệt mở trang ra không thấy việc của mình.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [editing, setEditing] = useState<SigningSubmission | null>(null);
  // Lập phiếu mới: giữ LOẠI đang chọn chứ không phải cờ true/false — mở form ra
  // là biết ngay đang lập tờ nào, không phải hỏi lại giữa chừng.
  const [creating, setCreating] = useState<SigningLoai | null>(null);
  const [viewing, setViewing] = useState<SigningSubmission | null>(null);
  const [mailWarn, setMailWarn] = useState("");
  // id phiếu đang xoá — khoá riêng từng dòng để không chặn cả bảng, và để bấm
  // trùng vào cùng một nút không bắn hai lệnh delete.
  const [deleting, setDeleting] = useState<string | null>(null);
  // Lỗi khi xoá KHÔNG dùng chung state `err`: `err` có early-return che sạch
  // panel, một lần bấm hụt là mất cả danh sách.
  const [delErr, setDelErr] = useState("");
  // Hộp xác nhận căn giữa màn hình — thay window.confirm().
  const { ask, confirmNode } = useConfirmBox();
  // Nhân đôi / đính kèm nhanh — khoá theo TỪNG dòng để bấm ở dòng này không làm
  // đơ nút của dòng khác, và bấm trùng vào cùng một nút không bắn hai lệnh.
  const [dupId, setDupId] = useState<string | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const quickFileRef = useRef<HTMLInputElement>(null);
  const quickTargetRef = useRef<SigningSubmission | null>(null);
  // Phiếu đang mở cửa sổ xem tệp. Giữ CẢ DÒNG chứ không giữ mỗi đường dẫn: phiếu
  // có nhiều tệp thì cửa sổ còn cho lật qua lại giữa chúng.
  const [previewRow, setPreviewRow] = useState<SigningSubmission | null>(null);

  const duplicateRow = async (r: SigningSubmission) => {
    if (dupId) return;
    setDupId(r.id);
    setDelErr("");
    try {
      const copy = await duplicateSubmission(r, user.email, user.name);
      await load();
      // Mở luôn bản sao ra sửa — nhân đôi bao giờ cũng là để sửa thành phiếu
      // khác, bắt người dùng tự đi tìm dòng mới trong danh sách là thừa một bước.
      setEditing(copy);
    } catch (e) {
      setDelErr(`Không nhân đôi được phiếu: ${errText(e)}`);
    } finally {
      setDupId(null);
    }
  };

  const pickQuickFile = (r: SigningSubmission) => {
    quickTargetRef.current = r;
    quickFileRef.current?.click();
  };

  const uploadQuickFiles = async (picked: File[]) => {
    const r = quickTargetRef.current;
    if (!r || picked.length === 0) return;
    // Kiểm ở client TRƯỚC khi gửi: để kho tự từ chối thì người dùng chờ hết cả
    // lượt tải rồi mới nhận lỗi, mà thông báo của kho lại bằng tiếng Anh.
    const sai = picked.find(f => !QUICK_TYPE_RE.test(f.name));
    if (sai) {
      setDelErr(`"${sai.name}" không phải PDF hay ảnh — cột File gốc chỉ nhận PDF, PNG, JPG, WEBP.`);
      return;
    }
    const to = picked.find(f => f.size > QUICK_MAX_BYTES);
    if (to) {
      setDelErr(`"${to.name}" nặng ${(to.size / 1024 / 1024).toFixed(1)}MB — vượt mức 4MB.`);
      return;
    }
    setUploadId(r.id);
    setDelErr("");
    try {
      await appendDossierFiles(r, picked);
      await load();
    } catch (e) {
      setDelErr(`Không tải lên được tệp: ${errText(e)}`);
    } finally {
      setUploadId(null);
      quickTargetRef.current = null;
    }
  };

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setErr("");
      setRows(await fetchSubmissions());
    } catch (e) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ─── Các đợt thanh toán / cấp phát (migration 094) ───
  //
  // Nạp RIÊNG một lượt sau khi có danh sách phiếu, KHÔNG gộp vào `load()`:
  // · hàm SQL đọc xuyên RLS nên phải gọi qua RPC, không lấy được bằng cách
  //   gom `rows` đang có (nhân viên thường chỉ thấy phiếu của chính mình);
  // · hỏng thì bảng vẫn hiện đủ, chỉ hai cột đợt/còn lại trống — chặn cả bảng
  //   vì một cột phụ là đánh đổi sai.
  const [dot, setDot] = useState<Map<string, DotRow[]>>(new Map());
  const [dotErr, setDotErr] = useState("");

  // Khoá nhóm rút từ `rows`, gộp trùng. Ký vào chuỗi để useEffect không chạy lại
  // mỗi lần `rows` đổi tham chiếu mà nội dung khoá y hệt.
  const khoaNhom = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) { const k = khoaNhomDot(r); if (k) s.add(k); }
    return [...s].sort();
  }, [rows]);
  const khoaKy = khoaNhom.join("\u0001");

  useEffect(() => {
    let huy = false;
    const keys = khoaKy ? khoaKy.split("\u0001") : [];
    if (!keys.length) { setDot(new Map()); setDotErr(""); return; }
    (async () => {
      try {
        const m = await fetchDotList(keys);
        if (!huy) { setDot(m); setDotErr(""); }
      } catch (e) {
        if (!huy) {
          setDot(new Map());
          setDotErr(
            /function .*signing_dot_list|does not exist|PGRST202/i.test(errText(e))
              // Cột "Đề nghị TT / Cấp phát" tính tại chỗ nên vẫn chạy; thiếu hàm
              // SQL thì chỉ mất phần CÁC ĐỢT KHÁC, và "Còn lại" sẽ báo cao hơn
              // thực tế. Phải nói đúng cái mất, đừng doạ là hỏng cả hai cột.
              ? "Chưa chạy migrations/094_signing_dot_payments.sql: cột \"Còn lại\" mới chỉ trừ đợt trên chính dòng này, CHƯA trừ các đợt khác của cùng hợp đồng."
              : `Không đọc được các đợt thanh toán: ${errText(e)}`
          );
        }
      }
    })();
    return () => { huy = true; };
  }, [khoaKy]);

  // Xoá phiếu — CHỈ Admin thấy nút này (RLS migration 050 chặn lần hai ở DB).
  // Xoá xong nạp lại cả bảng thay vì gỡ dòng khỏi state: KPI phía trên đếm từ
  // `rows`, gỡ tay thì phải nhớ trừ đúng ô KPI tương ứng, nạp lại là chắc.
  const removeRow = (r: SigningSubmission, rowEl: HTMLElement | null, btn: HTMLElement | null) => {
    if (deleting) return;
    ask({
      title: `Xoá phiếu "${r.ma_phieu || "(chưa có mã)"}"?`,
      message:
        (r.hop_dong_so ? `Hợp đồng: ${r.hop_dong_so}\n` : "") +
        (r.status === "nhap"
          ? "Bản nháp này chưa trình đi nên chưa ai thấy. Xoá là mất hẳn, không khôi phục được."
          : "Toàn bộ lịch sử duyệt của phiếu cũng mất theo. Không khôi phục được."),
      onConfirm: async () => {
        setDeleting(r.id);
        setDelErr("");
        // Vò dòng ném vào sọt NGAY khi bấm, không đợi server: phản hồi tức thì là
        // điểm chính của hiệu ứng. Xoá hỏng thì toss.cancel() bung dòng trở lại.
        const toss = crumpleToss(rowEl, { origin: btn });
        try {
          await deleteSubmission(r.id);
          toss.done(`Đã xoá phiếu ${r.ma_phieu || "trình ký"}`);
          await load();
        } catch (e) {
          toss.cancel();
          setDelErr(errText(e));
        } finally {
          setDeleting(null);
        }
      },
    });
  };

  // Ai lập được phiếu — PHẢI khớp `can_create_signing_caller()` ở CSDL
  // (migration 090): mọi nhân sự có hồ sơ trong danh bạ và chưa nghỉ việc, cộng
  // với người được cấp cờ riêng (tài khoản ngoài danh bạ). Lệch với CSDL thì
  // hoặc nút hiện ra rồi bấm báo lỗi RLS, hoặc người dùng hợp lệ mất nút.
  const canCreate =
    user.isAdmin || user.perms.canCreateSigning ||
    (user.inDirectory && !isResignedRow({ status: user.status }));

  // Không còn tự chọn bộ lọc theo vai: bộ lọc mới không có mục "Cần tôi duyệt"
  // để nhảy vào. Mở ra là xem TẤT CẢ — số phiếu đang chờ mình xử lý đã có thẻ
  // "Cần tôi xử lý" ở dải KPI phía trên đếm hộ.

  const canDuyet = useMemo(
    () => rows.filter((r) => canActOn(r, user.perms, user.isAdmin, user.email) && !["hoan_tat", "nhap", "tra_lai"].includes(r.status)),
    [rows, user.perms, user.isAdmin, user.email]
  );
  const cuaToi = useMemo(
    () => rows.filter((r) => r.created_by.toLowerCase() === user.email.toLowerCase()),
    [rows, user.email]
  );

  const visible = useMemo(() => {
    // Mọi mục lọc TRỪ "tat_ca"/"cua_toi" đều trùng tên với một giá trị `loai`,
    // nên so thẳng — thêm loại phiếu thứ bảy không phải nối thêm một nhánh nữa.
    const base =
      filter === "cua_toi" ? cuaToi
      : filter === "tat_ca" ? rows
      : rows.filter((r) => r.loai === (filter as SigningLoai));
    const q = search.trim().toLowerCase();
    const list = !q ? base : base.filter((r) =>
      // Thêm Bên A / Bên B / hạng mục vào diện tìm — với phiếu hợp đồng thì đó
      // mới là thứ người ta nhớ, chứ không phải "chủ đầu tư".
      [r.ma_phieu, r.hop_dong_so, r.chu_dau_tu, r.du_an, r.goi_thau, r.ben_a, r.ben_b, r.hang_muc]
        .some((x) => (x || "").toLowerCase().includes(q))
    );

    // Khoảng ngày lập phiếu — bỏ qua khi cả hai ô còn trống.
    const trongKhoang = (r: SigningSubmission) => {
      if (!from && !to) return true;
      const d = ngayVN(r.created_at);
      if (!d) return false;
      return (!from || d >= from) && (!to || d <= to);
    };
    const list2 = list.filter(trongKhoang);

    // Ở mục "Tất cả": đẩy phiếu ĐANG CHỜ CHÍNH MÌNH DUYỆT lên đầu.
    //
    // Bộ lọc mới không còn mục "Cần tôi duyệt" nên cấp duyệt mở trang ra là vào
    // thẳng danh sách chung; không xếp lên đầu thì họ phải dò cả bảng tìm dòng
    // có chấm vàng.
    //
    // `sort` của JS ổn định, nên các phiếu cùng nhóm giữ nguyên thứ tự cũ
    // (mới nhất trước) — chỉ nhấc nhóm chờ duyệt lên, không xáo trộn phần còn lại.
    if (filter !== "tat_ca") return list2;
    const cho = new Set(canDuyet.map((r) => r.id));
    return [...list2].sort((a, b) => Number(cho.has(b.id)) - Number(cho.has(a.id)));
  }, [filter, cuaToi, rows, search, canDuyet, from, to]);

  const stats = useMemo(() => ({
    canXuLy: canDuyet.length,
    dangChay: rows.filter((r) => FLOW.includes(normalizeStatus(r.status)) && r.status !== "hoan_tat").length,
    traLai: rows.filter((r) => r.status === "tra_lai").length,
    hoanTat: rows.filter((r) => r.status === "hoan_tat").length,
  }), [rows, canDuyet]);

  if (user.loading || loading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-slate-400 gap-2">
        <Loader2 className="animate-spin text-[#005BAC]" size={32} />
        <p className="text-xs font-semibold">Đang tải phiếu trình ký…</p>
      </div>
    );
  }

  if (err) {
    return (
      <div className="bg-rose-50 border border-rose-200 rounded-2xl p-5 flex items-start gap-3">
        <AlertTriangle size={18} className="text-rose-500 shrink-0 mt-0.5" />
        <div>
          <p className="text-[11px] font-bold text-rose-700">{err}</p>
          <p className="font-medium text-rose-600 text-[11px] mt-1.5">
            Nếu báo bảng không tồn tại: chạy{" "}
            <code className="bg-white px-1 rounded">050_signing_submissions.sql</code> rồi{" "}
            <code className="bg-white px-1 rounded">051_signing_dossier_bucket.sql</code>{" "}
            trong Supabase SQL Editor.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 w-full">
      {mailWarn && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 flex items-start gap-3">
          <AlertTriangle size={15} className="text-amber-500 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-bold text-amber-800">
              Phiếu ĐÃ chuyển bước, nhưng có một việc phụ chưa hoàn tất:
            </p>
            <p className="text-[11px] font-medium text-amber-700 mt-0.5 break-words">{mailWarn}</p>
          </div>
          <button type="button" onClick={() => setMailWarn("")}
            className="p-1 text-amber-400 hover:text-amber-600 hover:bg-amber-100 rounded-lg cursor-pointer">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Hai cột đợt/còn lại rỗng thì phải nói rõ VÌ SAO — không thì người dùng
          tưởng hợp đồng chưa thanh toán đồng nào. */}
      {dotErr && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 flex items-start gap-3">
          <AlertTriangle size={15} className="text-amber-500 shrink-0 mt-0.5" />
          <p className="flex-1 min-w-0 text-[11px] font-bold text-amber-800 break-words">{dotErr}</p>
          <button type="button" onClick={() => setDotErr("")}
            className="p-1 text-amber-400 hover:text-amber-600 hover:bg-amber-100 rounded-lg cursor-pointer">
            <X size={14} />
          </button>
        </div>
      )}

      {delErr && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl px-4 py-3 flex items-start gap-3">
          <AlertTriangle size={15} className="text-rose-500 shrink-0 mt-0.5" />
          <p className="flex-1 min-w-0 text-[11px] font-bold text-rose-700 break-words">{delErr}</p>
          <button type="button" onClick={() => setDelErr("")}
            className="p-1 text-rose-400 hover:text-rose-600 hover:bg-rose-100 rounded-lg cursor-pointer">
            <X size={14} />
          </button>
        </div>
      )}

      {/* KPI */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <Kpi label="Cần tôi xử lý" value={stats.canXuLy} icon={Inbox} grad="from-amber-500 to-orange-600" />
        <Kpi label="Đang luân chuyển" value={stats.dangChay} icon={CircleDot} grad="from-blue-500 to-cyan-600" />
        <Kpi label="Bị trả lại" value={stats.traLai} icon={Undo2} grad="from-rose-500 to-pink-600" />
        <Kpi label="Hoàn tất" value={stats.hoanTat} icon={ClipboardCheck} grad="from-emerald-500 to-teal-600" />
      </div>

      {/* ─── THANH CÔNG CỤ (bố cục 07/10/2026) ───
          Hai khối, mỗi khối một việc, cùng mép trái/phải với hàng KPI bên trên:
            1. Tiêu đề + đếm phiếu (trái)  ·  7 nút lập phiếu MỘT HÀNG (phải)
            2. Khoảng ngày  ·  cụm tab lọc loại phiếu  ·  ô tìm kiếm
          7 nút nằm trong lưới `grid-cols-7` nên bảy ô RỘNG BẰNG NHAU, chữ căn giữa
          — thẳng hàng tuyệt đối thay vì mỗi nút một độ rộng theo nhãn. Dưới cỡ xl
          lưới tự gập 4 + 3 / 2 cột để nhãn không bị ép vỡ.
          ⚠ Đừng đưa lại lưới 2 cột `[1fr_auto]` của bản cũ: nó chỉ chứa nổi 6 nút
          xếp 2 hàng, thêm nút thứ 7 là lệch cả hai hàng. */}
      <div className="space-y-3">
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_min(1040px,64%)] gap-x-4 gap-y-3 items-center">
          <div className="min-w-0 flex flex-wrap items-end gap-x-5 gap-y-3">
            <div className="min-w-0">
              <h3 className={labelCls}>Phiếu trình ký hồ sơ / văn bản</h3>
              <p className="text-[11px] text-slate-400 font-medium mt-1">
                Hiện <strong className="text-slate-600">{visible.length}</strong> phiếu
                {(from || to) && (
                  <> · lập {from ? `từ ${ddmmyyyy(from)}` : ""}{to ? ` đến ${ddmmyyyy(to)}` : ""}</>
                )}
              </p>
            </div>


            {/* Khoảng ngày lập phiếu — hai ô ngày chung một khung để đọc ra là MỘT
                khoảng, `max`/`min` chéo nhau chặn luôn khoảng ngược đời. */}
            <div className="flex items-center gap-1.5 bg-slate-100/50 border border-slate-200/60 rounded-xl px-2.5 py-1.5 shrink-0">
              <Calendar size={14} className="text-slate-400 shrink-0" />
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Từ</span>
              <input type="date" value={from} max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
                className="bg-transparent border-0 text-xs font-bold text-slate-700 outline-none cursor-pointer p-0" />
              <span className="text-slate-300 font-bold">–</span>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Đến</span>
              <input type="date" value={to} min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
                className="bg-transparent border-0 text-xs font-bold text-slate-700 outline-none cursor-pointer p-0" />
              {(from || to) ? (
                <button type="button" onClick={() => { setFrom(""); setTo(""); }}
                  title="Bỏ lọc theo ngày, xem tất cả"
                  className="p-1 text-slate-400 hover:text-rose-500 hover:bg-slate-200 rounded-lg transition-all cursor-pointer">
                  <X size={12} />
                </button>
              ) : (
                <button type="button"
                  onClick={() => { const b = tronThang(homNay()); setFrom(b.from); setTo(b.to); }}
                  title="Lọc nhanh trọn tháng này"
                  className="px-2 py-0.5 text-[10px] font-bold text-slate-400 hover:text-blue-600 hover:bg-white rounded-lg transition-all cursor-pointer">
                  Tháng này
                </button>
              )}
            </div>

          </div>

          {/* Nhãn ngắn, câu giải thích đầy đủ nằm ở `title`. */}
          {canCreate && (
            <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-2">
              {NUT_LAP_PHIEU.map((n) => (
                <button key={n.loai} type="button" onClick={() => setCreating(n.loai)}
                  title={n.title}
                  className={`flex items-center justify-center gap-1.5 whitespace-nowrap ${n.cls} text-white text-xs font-semibold px-2 py-2.5 rounded-xl shadow-md hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer`}>
                  <Plus size={14} className="shrink-0" />
                  <span>{n.label}</span>
                </button>
              ))}
            </div>
          )}
          {/* Không có quyền lập phiếu: giữ ô lưới trống để hàng 2 không nhảy lên. */}
          {!canCreate && <div className="hidden xl:block" />}
          </div>

          {/* Hàng 2: cụm tab lọc (trái) và ô tìm kiếm (phải) CÙNG CHIỀU CAO (h-10),
              cùng khuôn cột với hàng 1 — ô tìm kiếm thẳng cột với 7 nút phía trên. */}
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_min(1040px,64%)] gap-x-4 gap-y-3 items-center">
          {/* Tab lọc: quá hẹp thì cuộn ngang. */}
          <div className="flex items-center h-10 bg-slate-100/70 rounded-xl p-1 gap-1 min-w-0 max-w-full w-fit overflow-x-auto">
            {([
              ["tat_ca", `Tất cả (${rows.length})`],
              ["ho_so", `Hồ sơ (${rows.filter((r) => r.loai === "ho_so").length})`],
              ["hop_dong", `Hợp đồng (${rows.filter((r) => r.loai === "hop_dong").length})`],
              ["chuyen_tien", `Chuyển tiền (${rows.filter((r) => r.loai === "chuyen_tien").length})`],
              ["tam_ung", `Tạm ứng (${rows.filter((r) => r.loai === "tam_ung").length})`],
              ["to_trinh", `Tờ trình (${rows.filter((r) => r.loai === "to_trinh").length})`],
              ["phieu_yeu_cau", `Phiếu yêu cầu (${rows.filter((r) => r.loai === "phieu_yeu_cau").length})`],
              ["don_dat_hang", `Đơn đặt hàng (${rows.filter((r) => r.loai === "don_dat_hang").length})`],
              ["cua_toi", `Phiếu của tôi (${cuaToi.length})`],
            ] as [Filter, string][]).map(([k, lb]) => (
              <button key={k} type="button" onClick={() => setFilter(k)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-bold whitespace-nowrap transition-all cursor-pointer ${
                  filter === k ? "bg-white text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-700"
                }`}>
                {lb}
              </button>
            ))}
          </div>

          <div className="relative min-w-0">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm theo mã phiếu, số hợp đồng, chủ đầu tư, dự án…"
              className="w-full h-10 pl-9 pr-4 bg-slate-100/50 hover:bg-slate-100 focus:bg-white text-xs font-semibold text-slate-700 placeholder:text-slate-400 placeholder:font-medium border border-slate-200/60 rounded-xl outline-none focus:ring-2 focus:ring-blue-500/20 transition-all" />
          </div>
          </div>
      </div>

      {/* Danh sách */}
      {visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-16 px-6 space-y-3 bg-white rounded-2xl border border-slate-200/60 shadow-premium">
          <div className="w-14 h-14 rounded-2xl bg-slate-50 flex items-center justify-center text-slate-300 ring-4 ring-slate-100/50">
            <FileText size={26} />
          </div>
          <p className="font-heading font-extrabold text-slate-700 text-xs">
            {(from || to) ? "Không có phiếu nào lập trong khoảng ngày đã chọn"
              : filter === "cua_toi" ? "Bạn chưa lập phiếu nào"
              : filter === "ho_so" ? "Chưa có phiếu trình ký hồ sơ / văn bản nào"
              : filter === "hop_dong" ? "Chưa có phiếu trình ký hợp đồng nào"
              : filter === "to_trinh" ? "Chưa có tờ trình nào"
              : filter === "phieu_yeu_cau" ? "Chưa có phiếu yêu cầu nào"
              : filter === "tam_ung" ? "Chưa có giấy đề nghị tạm ứng nào"
              : filter === "don_dat_hang" ? "Chưa có đơn đặt hàng nào"
              : "Chưa có phiếu trình ký nào"}
          </p>
          {canCreate && (
            <button type="button" onClick={() => setCreating("ho_so")}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-4 py-2.5 rounded-xl shadow-md shadow-blue-500/10 transition-all cursor-pointer">
              <Plus size={14} /> Lập phiếu đầu tiên
            </button>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200/60 shadow-premium overflow-hidden">
          <div className="max-h-[calc(100vh-380px)] min-h-[360px] overflow-y-auto">
            {/* Thanh tiêu đề nền xanh, chữ trắng. Bản trước dùng nền xám nhạt
                + chữ slate-400 nên chìm nghỉm vào dòng dữ liệu, nhìn lướt không
                thấy đâu là tiêu đề cột. Màu đặc nên hiện đúng ở cả nền sáng lẫn
                nền tối, không phải nhờ bảng remap dark mode. */}
            <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-[#005BAC] to-blue-500 shadow-sm">
              <span className={`${headCls} w-24 shrink-0`}>Mã phiếu</span>
              <span className={`${headCls} flex-1 min-w-0`}>Hợp đồng / Dự án</span>
              {/* "Đợt / Lần": phiếu hồ sơ gọi là ĐỢT thanh toán, đơn đặt hàng gọi
                  là YÊU CẦU LẦN THỨ — hai tên gọi của cùng một cột `dot_so`. */}
              <span className={`${headCls} w-14 shrink-0 text-center hidden sm:block`}>Đợt / Lần</span>
              {/* BA CỘT ĐỌC LIỀN MẠCH: tổng − đã chi = còn lại. Nhãn nhỏ ngay
                  dưới mỗi con số nói rõ đó là số gì, vì mỗi loại phiếu đổ một
                  thứ khác nhau vào cột đầu (xem `soLieuChinh`).
                  pr-*: số căn phải, chip trạng thái căn trái — không chừa lề thì
                  hai cột dính vào nhau thành một khối chữ. */}
              <span className={`${headCls} w-36 shrink-0 text-right pr-4 hidden md:block leading-tight`}>
                Tổng giá trị HĐ / Dự toán
              </span>
              <span className={`${headCls} w-28 shrink-0 text-right pr-3 hidden lg:block leading-tight`}>
                Đề nghị TT / Cấp phát
              </span>
              <span className={`${headCls} w-28 shrink-0 text-right pr-4 hidden lg:block`}>Còn lại</span>
              <span className={`${headCls} w-20 shrink-0 text-center hidden md:block`}>File gốc</span>
              <span className={`${headCls} w-32 shrink-0 hidden lg:block`}>Trạng thái</span>
              {(user.isAdmin || canCreate) && (
                <span className={`${headCls} w-20 shrink-0 text-center`}>Thao tác</span>
              )}
            </div>
            <div className="divide-y divide-slate-100">
              {visible.map((r) => {
                const meta = STATUS_META[r.status];
                const buoc = tienDoBuoc(r);
                const mine = canActOn(r, user.perms, user.isAdmin, user.email) &&
                  !["hoan_tat", "nhap", "tra_lai"].includes(r.status);
                return (
                  // Dòng là <div role="button"> chứ không phải <button>: bên trong
                  // có nút Xoá riêng, mà <button> lồng <button> là HTML sai và
                  // trình duyệt sẽ nuốt cú bấm của nút con.
                  <div key={r.id} role="button" tabIndex={0} data-toss-row
                    onClick={() => setViewing(r)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setViewing(r); }
                    }}
                    className="w-full text-left flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50/80 transition-colors cursor-pointer">
                    <span className="w-24 shrink-0 font-mono font-bold text-[11px] text-slate-500 truncate">
                      {r.ma_phieu || "—"}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block font-semibold text-slate-800 text-xs truncate leading-tight">
                        {/* Phiếu chuyển tiền không gắn hợp đồng — "(chưa có số HĐ)"
                            ở đây đọc như phiếu nhập thiếu, trong khi đúng ra là
                            không có khái niệm đó. Hiện nội dung chi thay vào. */}
                        {r.loai === "ho_so" || r.loai === "hop_dong"
                          ? (r.hop_dong_so || "(chưa có số HĐ)")
                          : r.loai === "don_dat_hang"
                          ? (r.du_an || r.hang_muc || "(chưa ghi dự án)")
                          : (r.ve_viec || r.noi_dung_trinh || "(chưa ghi nội dung)")}
                      </span>
                      <span className="flex items-center gap-1.5 mt-0.5 min-w-0">
                        <span className={`shrink-0 text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded ${LOAI_META[r.loai].chip}`}>
                          {LOAI_META[r.loai].short}
                        </span>
                        <span className="block text-[10px] font-medium text-slate-400 truncate">
                          {/* Phiếu hợp đồng thì thứ đáng nhớ là hai bên ký, không
                              phải chủ đầu tư (ô đó bỏ trống ở loại này). Đơn đặt
                              hàng thì là SỐ ĐĐH — dòng trên đã hiện dự án rồi, lặp
                              lại chủ đầu tư ở đây chỉ tốn chỗ. */}
                          {r.loai === "hop_dong"
                            ? [r.ben_b, r.du_an].filter(Boolean).join(" · ") || "—"
                            : r.loai === "don_dat_hang"
                            ? [r.chi_tiet?.soDdh ? `ĐĐH ${r.chi_tiet.soDdh}` : null,
                               r.hang_muc, r.chi_tiet?.congTrinh].filter(Boolean).join(" · ") || "—"
                            : r.chu_dau_tu || r.du_an || "—"}
                        </span>
                        {/* Ngày lập + người lập. Nhét vào dòng phụ thay vì thêm hai
                            cột: bảng đã 7 cột, thêm nữa là vỡ ở màn hình hẹp. Trưởng
                            phòng thấy phiếu của cả phòng nên "ai lập" là thứ phải
                            đọc được ngay, không phải mở phiếu ra mới biết. */}
                        <span className="shrink-0 flex items-center gap-1 text-[10px] font-medium text-slate-300">
                          <span className="whitespace-nowrap">· {fmtNgayNgan(r.created_at)}</span>
                          {r.created_by_name && (
                            <span className="max-w-[110px] truncate" title={r.created_by_name}>
                              · {r.created_by_name}
                            </span>
                          )}
                        </span>
                      </span>
                    </span>
                    {/* Đợt / Lần — CÙNG một cột `dot_so` cho cả hai loại có khái
                        niệm này. Trước đây chặn cứng `loai === "ho_so"` nên đơn đặt
                        hàng luôn hiện "—" dù ô "Yêu cầu lần thứ" đã nhập và đã lưu. */}
                    <span className="w-14 shrink-0 text-center text-[11px] font-bold text-slate-500 hidden sm:block">
                      {(r.loai === "ho_so" || r.loai === "don_dat_hang") && r.dot_so != null
                        ? r.dot_so
                        : <span className="text-slate-300">—</span>}
                    </span>
                    {/* Ba ô của phép tính. Dựng chung một khuôn `O` để ba cột
                        cùng cỡ chữ, cùng cách căn — đọc ngang là ra phép trừ. */}
                    <O w="w-36" pr="pr-4" hep="md" v={soLieuChinh(r)} />
                    <O w="w-28" pr="pr-3" hep="lg" v={deNghiCapPhat(r, dot)} mau="text-slate-500" />
                    {(() => {
                      const cl = conLai(r, dot);
                      return (
                        <O w="w-28" pr="pr-4" hep="lg" v={cl}
                          mau={cl.am ? "text-rose-600" : "text-emerald-700"} dam />
                      );
                    })()}
                    {/* File gốc — xem tệp đã có và đính kèm thêm ngay tại dòng */}
                    <span className="w-20 shrink-0 hidden md:flex items-center justify-center gap-0.5">
                      {r.files.length > 0 && (
                        <button type="button"
                          onClick={(e) => { e.stopPropagation(); setPreviewRow(r); }}
                          title={`Xem ${r.files.length} tệp:\n${r.files.map(f => f.name).join("\n")}`}
                          className="inline-flex items-center gap-1 px-1.5 py-1 rounded-lg text-[10px] font-bold text-blue-600 hover:bg-blue-50 transition-all cursor-pointer">
                          <Eye size={13} />
                          {r.files.length}
                        </button>
                      )}
                      {canEdit(r, user.email, user.isAdmin) && (
                        <button type="button"
                          onClick={(e) => { e.stopPropagation(); pickQuickFile(r); }}
                          disabled={uploadId === r.id}
                          title="Đính kèm PDF hoặc ảnh (tối đa 4MB)"
                          className="p-1.5 rounded-lg text-slate-300 hover:text-blue-600 hover:bg-blue-50 transition-all cursor-pointer disabled:opacity-40">
                          {uploadId === r.id
                            ? <Loader2 size={13} className="animate-spin" />
                            : <Upload size={13} />}
                        </button>
                      )}
                      {r.files.length === 0 && !canEdit(r, user.email, user.isAdmin) && (
                        <span className="text-[10px] font-bold text-slate-300">—</span>
                      )}
                    </span>
                    <span className="w-32 shrink-0 hidden lg:flex items-center gap-1.5">
                      <span className={`text-[9px] font-extrabold uppercase px-2 py-0.5 rounded-full ${meta.chip}`}>
                        {meta.short}
                      </span>
                      {/* Bước mấy / tổng mấy bước. Số cấp duyệt KHÔNG cố định —
                          cùng chip "Phó GĐ" có thể là 2/3 (hợp đồng) hay 2/4
                          (hồ sơ có chặng Kế toán), nhìn chip không thể biết còn
                          bao nhiêu chặng nữa. Rỗng với nháp / trả lại / hoàn tất. */}
                      {buoc && (
                        <span className="text-[9px] font-mono font-bold text-slate-400 shrink-0"
                          title={`Phiếu đang ở bước ${buoc} của luồng duyệt`}>
                          {buoc}
                        </span>
                      )}
                      {mine && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" title="Chờ bạn xử lý" />}
                    </span>
                    {(user.isAdmin || canCreate) && (
                      <span className="w-20 shrink-0 flex items-center justify-center gap-0.5">
                        {canCreate && (
                          <button type="button"
                            onClick={(e) => { e.stopPropagation(); duplicateRow(r); }}
                            disabled={dupId === r.id}
                            title="Nhân đôi phiếu này thành bản nháp mới"
                            className="p-1.5 rounded-lg text-slate-300 hover:text-blue-600 hover:bg-blue-50 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
                            {dupId === r.id
                              ? <Loader2 size={14} className="animate-spin" />
                              : <CopyPlus size={14} />}
                          </button>
                        )}
                        {/* Nút xoá theo ĐÚNG luật của policy `signing_delete`, không
                            còn chỉ Admin: người lập tự dọn được bản nháp và phiếu bị
                            trả lại của mình. Phiếu ĐANG TRÌNH thì không ai ngoài
                            Admin xoá được — nó đã nằm trong hộp việc của cấp duyệt
                            và có thể đã mang vết ký. */}
                        {canDelete(r, user.email, user.isAdmin) && (
                          <button type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              // Lấy dòng ngay trong handler: sau await thì React đã
                              // dựng lại bảng, không còn tìm được node này nữa.
                              removeRow(r, e.currentTarget.closest("[data-toss-row]") as HTMLElement | null, e.currentTarget);
                            }}
                            disabled={deleting === r.id}
                            title={r.status === "nhap"
                              ? `Xoá bản nháp ${r.ma_phieu || ""}`.trim()
                              : `Xoá phiếu ${r.ma_phieu || ""}`.trim()}
                            className="p-1.5 rounded-lg text-slate-300 hover:text-rose-600 hover:bg-rose-50 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
                            {deleting === r.id
                              ? <Loader2 size={14} className="animate-spin" />
                              : <Trash2 size={14} />}
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Một ô chọn tệp dùng chung cho mọi dòng — dựng 1 ô cho mỗi dòng thì
          danh sách 50 phiếu sẽ có 50 input thừa trong DOM. */}
      <input
        ref={quickFileRef}
        type="file"
        multiple
        hidden
        accept={QUICK_ACCEPT}
        onChange={(e) => {
          const picked = Array.from(e.target.files || []);
          uploadQuickFiles(picked);
          // Xoá giá trị để lần sau chọn LẠI ĐÚNG tệp đó vẫn kích hoạt onChange.
          e.target.value = "";
        }}
      />

      {previewRow && (
        <FilePreviewModal
          row={previewRow}
          canDelete={canEdit(previewRow, user.email, user.isAdmin)}
          onChanged={load}
          onClose={() => setPreviewRow(null)}
        />
      )}

      {(creating || editing) && (
        <SigningFormModal
          existing={editing}
          loai={creating || undefined}
          currentEmail={user.email}
          currentName={user.name}
          currentDepartment={user.department}
          onClose={() => { setCreating(null); setEditing(null); }}
          onSaved={load}
          onMailWarn={setMailWarn}
        />
      )}

      {viewing && (
        <DetailModal
          row={viewing}
          user={user}
          onClose={() => setViewing(null)}
          onEdit={() => { setEditing(viewing); setViewing(null); }}
          onDone={() => { setViewing(null); load(); }}
          onMailWarn={setMailWarn}
        />
      )}

      {confirmNode}
    </div>
  );
}

// ─── Cửa sổ xem tệp hồ sơ ───
// Mở ngay giữa màn hình thay vì bật tab mới: người duyệt đang dò danh sách,
// nhảy tab rồi quay lại là mất chỗ đang xem và mất cả bộ lọc đang đặt.
//
// ⚠ createPortal ra document.body — panel này nằm trong khối `.glass` của trang
// /bao-cao, mà `backdrop-filter` tạo containing block mới nên phần tử `fixed` sẽ
// bị nhốt trong thẻ cha thay vì phủ toàn màn hình.
function FilePreviewModal({ row, canDelete, onChanged, onClose }: {
  row: SigningSubmission;
  canDelete: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(0);
  // Danh sách tệp giữ ngay trong cửa sổ: xoá xong phải thấy mất ngay, không đợi
  // tải lại cả bảng rồi mới cập nhật.
  const [files, setFiles] = useState(row.files);
  const [busy, setBusy] = useState(false);
  const [delErr, setDelErr] = useState("");
  // Giữ CẢ đường dẫn đã giải trong state, không tách thành url/loading/err rời.
  // Nhờ vậy "đang tải" được SUY RA từ việc kết quả có khớp tệp đang xem hay
  // không, thay vì phải dọn 3 ô state ngay đầu effect — dọn kiểu đó là gọi
  // setState thẳng trong thân effect, React cảnh báo và dễ sinh render thừa.
  const [resolved, setResolved] = useState<{ path: string; url: string; err: string } | null>(null);
  const { ask, confirmNode } = useConfirmBox();

  const file = files[idx];
  const isPdf = /\.pdf$/i.test(file?.name || "");

  const ready = !!file && resolved?.path === file.path;
  const loading = !ready;
  const url = ready ? resolved.url : "";
  const err = ready ? resolved.err : "";

  // Đường dẫn kho là loại có hạn dùng, phải xin lại mỗi lần đổi tệp — không
  // dựng sẵn một lượt cho cả bộ rồi dùng dần, hết hạn giữa chừng là ảnh trắng.
  useEffect(() => {
    if (!file) return;
    let mounted = true;
    resolveDossierUrl(file.path)
      .then(u => {
        if (!mounted) return;
        setResolved({
          path: file.path,
          url: u || "",
          err: u ? "" : `Không mở được "${file.name}" — tệp đã bị xoá hoặc tài khoản hết quyền.`,
        });
      })
      .catch(e => {
        if (mounted) setResolved({ path: file.path, url: "", err: errText(e) });
      });
    return () => { mounted = false; };
  }, [file]);

  const removeCurrent = () => {
    if (!file || busy) return;
    const target = file;
    ask({
      title: `Gỡ "${target.name}" khỏi phiếu ${row.ma_phieu || ""}?`.trim(),
      message: "Tệp vẫn còn trong kho, chỉ là phiếu này không trỏ tới nữa.",
      confirmLabel: "Gỡ tệp",
      onConfirm: async () => {
        setBusy(true);
        setDelErr("");
        try {
          const next = await removeDossierFile(row.id, files, target.path);
          setFiles(next);
          // Lùi con trỏ nếu vừa xoá tệp cuối; hết tệp thì đóng luôn cửa sổ.
          setIdx(i => Math.max(0, Math.min(i, next.length - 1)));
          onChanged();
          if (next.length === 0) onClose();
        } catch (e) {
          setDelErr(errText(e));
        } finally {
          setBusy(false);
        }
      },
    });
  };

  // Esc để đóng — cửa sổ chiếm gần hết màn hình, với chuột thì phải rê lên tận
  // góc trên bên phải mới bấm được nút X.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-5xl h-[88vh] overflow-hidden shadow-2xl border border-slate-100 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Đầu cửa sổ */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-200/60 bg-slate-50/70 shrink-0">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#005BAC] to-blue-500 flex items-center justify-center shadow-sm shrink-0">
            <Eye size={15} className="text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="font-heading font-extrabold text-slate-800 text-xs leading-tight truncate">
              {file?.name || "Tệp hồ sơ"}
            </h4>
            <p className="text-[10px] text-slate-400 font-semibold truncate">
              Phiếu {row.ma_phieu || "—"} · tệp {idx + 1}/{files.length}
            </p>
          </div>
          {canDelete && file && (
            <button type="button" onClick={removeCurrent} disabled={busy}
              title={`Gỡ "${file.name}" khỏi phiếu`}
              className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all cursor-pointer disabled:opacity-40">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
            </button>
          )}
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="Mở ở tab mới"
              className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all cursor-pointer">
              <ExternalLink size={15} />
            </a>
          )}
          <button type="button" onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-200 rounded-lg transition-all cursor-pointer">
            <X size={15} />
          </button>
        </div>

        {/* Thanh lật tệp — chỉ hiện khi phiếu có nhiều hơn một tệp */}
        {files.length > 1 && (
          <div className="flex items-center gap-1.5 px-4 py-2 border-b border-slate-100 bg-white overflow-x-auto shrink-0">
            {files.map((f, i) => (
              <button key={f.path} type="button" onClick={() => setIdx(i)}
                title={f.name}
                className={`px-2.5 py-1 rounded-lg text-[10px] font-bold whitespace-nowrap transition-all cursor-pointer ${
                  i === idx
                    ? "bg-blue-600 text-white shadow-sm"
                    : "bg-slate-100 text-slate-500 hover:text-slate-700"
                }`}>
                {i + 1}. {f.name.length > 22 ? `${f.name.slice(0, 20)}…` : f.name}
              </button>
            ))}
          </div>
        )}

        {delErr && (
          <div className="px-4 py-2.5 bg-rose-50 border-b border-rose-200 flex items-start gap-2 shrink-0">
            <AlertTriangle size={14} className="text-rose-500 shrink-0 mt-0.5" />
            <p className="flex-1 min-w-0 text-[11px] font-bold text-rose-700 break-words">{delErr}</p>
            <button type="button" onClick={() => setDelErr("")}
              className="p-0.5 text-rose-400 hover:text-rose-600 cursor-pointer"><X size={13} /></button>
          </div>
        )}

        {/* Thân — nền xám để ảnh nền trắng còn thấy được mép */}
        <div className="flex-1 min-h-0 bg-slate-100 flex items-center justify-center overflow-auto">
          {loading ? (
            <div className="flex flex-col items-center gap-2 text-slate-400">
              <Loader2 size={28} className="animate-spin text-[#005BAC]" />
              <p className="text-xs font-semibold">Đang mở tệp…</p>
            </div>
          ) : err ? (
            <div className="flex flex-col items-center gap-2 text-center px-8">
              <FileWarning size={30} className="text-rose-400" />
              <p className="text-[11px] font-bold text-rose-600 max-w-sm">{err}</p>
            </div>
          ) : isPdf ? (
            // PDF nhờ trình xem sẵn có của trình duyệt, không nạp thêm thư viện.
            <iframe src={url} title={file?.name || "PDF"} className="w-full h-full border-0" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={file?.name || "Ảnh hồ sơ"}
              className="max-w-full max-h-full object-contain" />
          )}
        </div>
      </div>

      {confirmNode}
    </div>,
    document.body
  );
}

/**
 * Một ô số của bộ ba "Tổng − Đã chi = Còn lại": con số ở trên, nhãn nhỏ nói đó
 * là số gì ở dưới. Gói thành component để ba cột không thể lệch cỡ chữ hay lệch
 * cách căn — ba cột đọc ngang phải ra một phép trừ, lệch một nhịp là mất mạch.
 */
function O({ w, pr, hep, v, mau = "text-slate-700", dam = false }: {
  w: string; pr: string;
  /** Ngưỡng bắt đầu hiện cột — cột càng phụ thì ẩn càng sớm ở màn hình hẹp. */
  hep: "md" | "lg";
  v: { so: string; nhan: string; tip?: string };
  mau?: string; dam?: boolean;
}) {
  const rong = v.so === "—";
  return (
    <span
      className={`${w} shrink-0 text-right ${pr} leading-tight ${
        hep === "md" ? "hidden md:block" : "hidden lg:block"
      }`}
      title={v.tip}
    >
      <span className={`block font-mono ${dam ? "font-extrabold" : "font-bold"} text-[11px] ${
        rong ? "text-slate-300" : mau
      }`}>
        {v.so}
      </span>
      {v.nhan && (
        <span className="block text-[9px] font-bold text-slate-400 uppercase tracking-wide truncate">
          {v.nhan}
        </span>
      )}
    </span>
  );
}

function Kpi({ label, value, icon: Icon, grad }: {
  label: string; value: number; icon: typeof Inbox; grad: string;
}) {
  return (
    <div className="glass bg-white/80 rounded-2xl p-5 border border-slate-100 shadow-premium hover-elevate flex items-center justify-between gap-3">
      <div className="space-y-1 min-w-0">
        <p className="text-slate-500 text-[11px] font-semibold truncate">{label}</p>
        <p className="font-heading font-extrabold text-3xl text-slate-800 leading-none">{value}</p>
      </div>
      <div className={`w-11 h-11 rounded-xl bg-gradient-to-br ${grad} flex items-center justify-center shadow-md shrink-0`}>
        <Icon className="text-white" size={20} />
      </div>
    </div>
  );
}

// ─── Modal chi tiết + thao tác duyệt ───
function DetailModal({ row, user, onClose, onEdit, onDone, onMailWarn }: {
  row: SigningSubmission;
  user: ReturnType<typeof useCurrentUser>;
  onClose: () => void;
  onEdit: () => void;
  onDone: () => void;
  // Modal đóng ngay sau khi duyệt, nên cảnh báo email phải nổi ở PANEL CHA —
  // để trong modal thì nó biến mất cùng modal, không ai kịp đọc.
  onMailWarn: (msg: string) => void;
}) {
  const setMailWarn = onMailWarn;
  const [ykien, setYkien] = useState("");
  const [lyDo, setLyDo] = useState("");
  const [showReturn, setShowReturn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [err, setErr] = useState("");
  // Khoá bằng ref chứ không bằng state `busy`: modal đóng ngay sau khi ghi CSDL
  // nên `busy` chưa kịp vẽ lại, bấm nhanh hai cái vẫn lọt được lệnh thứ hai.
  // Ref đổi giá trị tức thì, không chờ render.
  const dangChay = useRef(false);

  const exportDocx = async () => {
    setExporting(true); setErr("");
    try {
      // Phiếu chuyển tiền in ra tờ HC-BM021/ĐNCT qua route đã có sẵn, KHÔNG đi
      // downloadSigningForm (route đó chỉ biết hai mẫu TL/BM/011 và KHKT/BM/001).
      if (row.loai === "chuyen_tien" || row.loai === "tam_ung") {
        await exportTransferRequestDocx({
          kind: row.loai === "tam_ung" ? "advance" : "transfer",
          paymentTime: row.hang_muc || "",
          employeeName: row.created_by_name || row.created_by,
          employeeDept: row.don_vi || "",
          reason: row.noi_dung_trinh || row.ve_viec || "",
          projectName: row.du_an || "",
          supplierName: row.chu_dau_tu || "",
          bankAccount: row.so_tai_khoan || "",
          bankNameBranch: row.ngan_hang || "",
          amount: row.de_nghi_thanh_toan || 0,
        });
        return;
      }
      // Đơn đặt hàng in ra EXCEL — route riêng (/api/export-purchase-order),
      // downloadSigningForm chỉ biết ba mẫu Word.
      if (row.loai === "don_dat_hang") {
        const boQua = await downloadPurchaseOrder(ddhPayloadFromRow(row), docxFileName(row));
        if (boQua > 0) {
          setErr(`Biểu mẫu Excel chỉ có 15 dòng vật tư — đơn này bị cắt mất ${boQua} dòng cuối.`);
        }
        return;
      }
      await downloadSigningForm(docxPayloadFromRow(row), docxFileName(row));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setExporting(false);
    }
  };

  const actable = canActOn(row, user.perms, user.isAdmin, user.email) &&
    !["hoan_tat", "nhap", "tra_lai"].includes(row.status);
  const editable = canEdit(row, user.email, user.isAdmin);
  // Người lập trình phiếu đi — từ nháp hoặc sau khi bị trả lại. Nút này trước
  // chỉ nằm trong form soạn thảo, nên mở phiếu ra xem lại thì không thấy đâu.
  const submittable =
    (row.status === "nhap" || row.status === "tra_lai") &&
    (user.isAdmin || row.created_by.toLowerCase() === user.email.toLowerCase());

  // Gửi email báo luồng. KHÔNG chặn thao tác nếu email hỏng: phiếu đã chuyển
  // bước trong CSDL rồi, bắt người dùng làm lại chỉ vì SMTP lỗi là sai.
  // Gửi email báo cấp kế tiếp. CỐ Ý không await ở nơi gọi — xem ghi chú tại
  // `approve` / `sendBack` / `submit`.
  const notify = async (
    event: "trinh" | "duyet" | "tra_lai",
    fromStatus: SigningStatus,
    toStatus: SigningStatus,
    extra: { ykien?: string; lyDo?: string }
  ) => {
    try {
      const nextEmails =
        event === "tra_lai" || toStatus === "hoan_tat"
          ? []
          // Bước cấp 1 không theo cờ — email người duyệt đã lưu trên phiếu.
          : toStatus === "cho_cap1"
          ? (row.cap1_email || "").split(",").map((e) => e.trim()).filter((e) => e.includes("@"))
          : await fetchStageApproverEmails(toStatus);
      const res = await apiFetch("/api/send-signing-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maPhieu: row.ma_phieu,
          hopDongSo: row.hop_dong_so,
          duAn: row.du_an,
          chuDauTu: row.chu_dau_tu,
          dotSo: row.dot_so,
          soTien: row.de_nghi_thanh_toan ?? tinhDeNghi(row),
          event,
          eventLabel: event === "duyet" ? EVENT_LABEL[fromStatus] : undefined,
          nextLabel: STATUS_META[toStatus]?.label,
          actorName: user.name || user.email,
          ykien: extra.ykien,
          lyDo: extra.lyDo,
          creatorEmail: row.created_by,
          creatorName: row.created_by_name,
          nextApproverEmails: nextEmails,
          siteUrl: window.location.origin,
        }),
      });
      const j = await res.json().catch(() => ({}));
      // Email hỏng KHÔNG chặn thao tác (phiếu đã chuyển bước rồi), nhưng phải
      // NÓI RA. Nuốt im lặng thì người dùng tưởng đã báo cho cấp sau, thực tế
      // không ai nhận được gì — đúng tình huống "hình như chưa nhận được mail"
      // mà không ai biết vì sao.
      if (!res.ok) setMailWarn(j.error || `Không gửi được email (${res.status}).`);
      else if (j.failed?.length) setMailWarn(`Gửi email lỗi: ${j.failed.join("; ")}`);
      else if (!j.sent?.length) setMailWarn("Không có địa chỉ email nào để gửi thông báo.");
    } catch (e) {
      setMailWarn(`Không gửi được email: ${errText(e)}`);
    }
  };

  const submit = async () => {
    if (dangChay.current) return;
    dangChay.current = true;
    setBusy(true); setErr("");
    try {
      // Bước đầu = route[0] của phiếu (thường 'cho_cap1'); phiếu cũ không route
      // thì về luồng cũ 'cho_pho_giam_doc'.
      const firstStep: SigningStatus =
        row.route && row.route.length ? row.route[0] : "cho_pho_giam_doc";
      // `.select()` + đếm dòng, KHÔNG chỉ kiểm `error`: RLS chặn UPDATE thì
      // PostgreSQL không báo lỗi, nó sửa 0 dòng. Thiếu vế này là hỏng trong im
      // lặng — modal đóng, email bắn đi, mà CSDL không đổi gì (sự cố 16/09/2026,
      // xem migration 081).
      const { data: hit, error } = await supabase
        .from("signing_submissions")
        .update({ status: firstStep })
        .eq("id", row.id)
        .select("id");
      if (error) throw error;
      if (!hit?.length) throw new Error(KHONG_GHI_DUOC);

      // ─── ĐÓNG NGAY, EMAIL CHẠY NGẦM ───
      // Trước đây phải chờ xong cả `fetchStageApproverEmails` lẫn cú gọi SMTP
      // rồi mới đóng — nút quay vài giây, cấp duyệt tưởng máy treo và bấm lại.
      // Việc chốt là dòng UPDATE ở trên: nó xong thì phiếu ĐÃ chuyển bước.
      // Email chỉ là báo tin, hỏng cũng không làm sai dữ liệu — và cảnh báo của
      // nó nổi ở PANEL CHA (onMailWarn) nên modal đóng rồi vẫn đọc được.
      onDone();
      void notify("trinh", row.status, firstStep, {});
    } catch (e) {
      setErr(errText(e));
      dangChay.current = false;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  // Ghi ý kiến vào đúng cột của cấp đang giữ phiếu, rồi đẩy sang bước kế tiếp.
  const approve = async () => {
    const nxt = advanceStatus(row);
    if (!nxt || dangChay.current) return;
    dangChay.current = true;
    setBusy(true); setErr("");
    try {
      const now = new Date().toISOString();
      const who = user.name || user.email;
      const patch: Record<string, unknown> = { status: nxt };
      // Dùng THẲNG row.status (không normalize): chặng PGĐ mới (cho_pgd_qlda/khdt)
      // ghi vào đúng ô của vị đó; chặng cũ gộp (cho_pho_giam_doc) thì suy theo cờ.
      const cur = row.status;
      if (cur === "cho_cap1") {
        Object.assign(patch, { ykien_cap1: ykien || null, cap1_by: who, cap1_at: now });
      } else if (cur === "cho_pgd_qlda") {
        Object.assign(patch, { ykien_qlda: ykien || null, qlda_by: who, qlda_at: now });
      } else if (cur === "cho_pgd_khdt") {
        Object.assign(patch, { ykien_khdt: ykien || null, khdt_by: who, khdt_at: now });
      } else if (cur === "cho_phong_qlda") {
        Object.assign(patch, { ykien_pqlda: ykien || null, pqlda_by: who, pqlda_at: now });
      } else if (cur === "cho_phong_vat_tu") {
        Object.assign(patch, { ykien_pvt: ykien || null, pvt_by: who, pvt_at: now });
      } else if (cur === "cho_pho_giam_doc") {
        // Phiếu CŨ: chặng PGĐ gộp — ghi vào ô của vị đang ký (theo cờ).
        if (pgdOpinionField(user.perms) === "qlda") {
          Object.assign(patch, { ykien_qlda: ykien || null, qlda_by: who, qlda_at: now });
        } else {
          Object.assign(patch, { ykien_khdt: ykien || null, khdt_by: who, khdt_at: now });
        }
      } else if (cur === "cho_giam_doc") {
        Object.assign(patch, { ykien_giam_doc: ykien || null, giam_doc_by: who, giam_doc_at: now });
      } else if (cur === "cho_ke_toan") {
        Object.assign(patch, { ke_toan_by: who, ke_toan_at: now, ngay_chi: now.slice(0, 10) });
      }

      const { data: hit, error } = await supabase
        .from("signing_submissions").update(patch).eq("id", row.id).select("id");
      if (error) throw error;
      if (!hit?.length) throw new Error(KHONG_GHI_DUOC);

      // ─── ĐÓNG NGAY, EMAIL CHẠY NGẦM ───
      // Trước đây phải chờ xong cả `fetchStageApproverEmails` lẫn cú gọi SMTP
      // rồi mới đóng — nút quay vài giây, cấp duyệt tưởng máy treo và bấm lại.
      // Việc chốt là dòng UPDATE ở trên: nó xong thì phiếu ĐÃ chuyển bước.
      // Email chỉ là báo tin, hỏng cũng không làm sai dữ liệu — và cảnh báo của
      // nó nổi ở PANEL CHA (onMailWarn) nên modal đóng rồi vẫn đọc được.
      onDone();
      void notify("duyet", row.status, nxt, { ykien });

      // Giám đốc duyệt xong phiếu HỒ SƠ/VĂN BẢN -> tự tạo dòng trong Bảng kê hồ
      // sơ thanh toán bên Kế toán. Fire-and-forget như email: phiếu đã sang bước
      // Kế toán rồi, việc này hỏng cũng không làm sai dữ liệu — chỉ cảnh báo mềm
      // ở panel cha để kế toán biết mà tự thêm.
      if (nxt === "cho_ke_toan") {
        pushToPaymentDossier(row, user.email).catch((e) =>
          setMailWarn(
            `Phiếu đã duyệt và chuyển sang Kế toán, nhưng chưa tạo được dòng trong Bảng kê hồ sơ thanh toán: ${errText(e)}. Kế toán có thể tự thêm.`
          )
        );
      }
    } catch (e) {
      setErr(errText(e));
      dangChay.current = false;
    } finally {
      setBusy(false);
    }
  };

  const sendBack = async () => {
    if (!lyDo.trim()) { setErr("Phải ghi lý do khi trả lại."); return; }
    if (dangChay.current) return;
    dangChay.current = true;
    setBusy(true); setErr("");
    try {
      const { data: hit, error } = await supabase.from("signing_submissions").update({
        status: "tra_lai",
        tra_lai_tu: row.status,
        tra_lai_boi: user.name || user.email,
        tra_lai_luc: new Date().toISOString(),
        tra_lai_ly_do: lyDo.trim(),
      }).eq("id", row.id).select("id");
      if (error) throw error;
      if (!hit?.length) throw new Error(KHONG_GHI_DUOC);

      // ─── ĐÓNG NGAY, EMAIL CHẠY NGẦM ───
      // Trước đây phải chờ xong cả `fetchStageApproverEmails` lẫn cú gọi SMTP
      // rồi mới đóng — nút quay vài giây, cấp duyệt tưởng máy treo và bấm lại.
      // Việc chốt là dòng UPDATE ở trên: nó xong thì phiếu ĐÃ chuyển bước.
      // Email chỉ là báo tin, hỏng cũng không làm sai dữ liệu — và cảnh báo của
      // nó nổi ở PANEL CHA (onMailWarn) nên modal đóng rồi vẫn đọc được.
      onDone();
      void notify("tra_lai", row.status, "tra_lai", { lyDo: lyDo.trim() });
    } catch (e) {
      setErr(errText(e));
      dangChay.current = false;
    } finally {
      setBusy(false);
    }
  };

  const openFile = async (path: string, name: string) => {
    const url = await resolveDossierUrl(path);
    if (url) window.open(url, "_blank", "noopener");
    else setErr(`Không mở được "${name}".`);
  };

  const meta = STATUS_META[row.status];
  const laHopDong = row.loai === "hop_dong";
  const laTamUng = row.loai === "tam_ung";
  const laChuyenTien = row.loai === "chuyen_tien" || laTamUng;
  const laToTrinh = row.loai === "to_trinh";
  const laPhieuYeuCau = row.loai === "phieu_yeu_cau";
  const laDonDatHang = row.loai === "don_dat_hang";

  // Ba bộ dòng khác hẳn nhau. Trước đây phiếu hợp đồng cũng đổ ra bộ của phiếu
  // thanh toán: 7 dòng "— đồng (A)/(B)/(C)/(D)" và một dòng "Đề nghị thanh toán
  // 0 đồng" — vừa vô nghĩa vừa dễ làm người duyệt tưởng phiếu nhập thiếu số.
  // Giấy đề nghị chuyển tiền cũng vậy: người duyệt cần thấy TIỀN ĐI ĐÂU, nên
  // số tài khoản + ngân hàng phải nằm ngay đây chứ không nằm trong file Word.
  const ct = row.chi_tiet || {};
  const rowInfo: [string, string][] = laPhieuYeuCau
    ? [
        ["Bộ phận", row.don_vi || "—"],
        ["Nội dung yêu cầu", row.noi_dung_trinh || row.ve_viec || "—"],
        ["Số dòng vật tư", `${row.vat_tu.length} dòng`],
      ]
    : laDonDatHang
    ? [
        ["Dự án", row.du_an || "—"],
        ["Công trình", ct.congTrinh || row.goi_thau || "—"],
        ["Cấp cho hạng mục", row.hang_muc || "—"],
        ["Số ĐĐH", ct.soDdh || "(chưa cấp số)"],
        ["Yêu cầu lần thứ", row.dot_so != null ? String(row.dot_so) : "—"],
        ["Đơn vị yêu cầu", ct.donViYeuCau || "—"],
        ["Đơn vị nhận nợ từ TNG", ct.donViNhanNo || "—"],
        ["Địa chỉ nhận hàng", ct.diaChiNhan || "—"],
        ["Ngày dự kiến sử dụng", ct.ngayDuKien || "—"],
        ["Người nhận hàng", [ct.nguoiNhanHang, ct.sdtNhanHang].filter(Boolean).join(" · ") || "—"],
        ["Cán bộ kỹ thuật", [ct.canBoKyThuat, ct.sdtKyThuat].filter(Boolean).join(" · ") || "—"],
        ["CĐT có thanh toán", ct.cdtThanhToan
          ? ct.cdtThanhToan + (ct.cdtThanhToan === "Không" && ct.lyDoKhongThanhToan
              ? ` — ${ct.lyDoKhongThanhToan}` : "")
          : "—"],
        ["Nguyên nhân phát sinh", ct.nguyenNhanPhatSinh || "—"],
        ["Số dòng vật tư", `${row.vat_tu.length} dòng`],
      ]
    : laToTrinh
    ? [
        ["Số tờ trình", row.so_to_trinh || "(chưa cấp số)"],
        ["Bộ phận trình", row.don_vi || "—"],
        ["Căn cứ", row.can_cu || "—"],
        ["Nội dung đề nghị", row.noi_dung_trinh || "—"],
        ["Đơn vị báo giá", row.chu_dau_tu || "—"],
        [
          "Chi phí dự kiến",
          row.de_nghi_thanh_toan == null
            ? "— (không kèm chi phí)"
            : `${fmtMoney(row.de_nghi_thanh_toan)} đồng`
              + (row.vat_percent != null ? ` (đã bao gồm VAT ${row.vat_percent}%)` : "")
              + (row.hang_muc ? ` — ${row.hang_muc}` : ""),
        ],
        ["Kiến nghị", row.kien_nghi || "—"],
        ["Dự án", row.du_an || "—"],
      ]
    : laChuyenTien
    ? [
        ["Đơn vị thụ hưởng", row.chu_dau_tu || "—"],
        ["Số tài khoản", row.so_tai_khoan || "—"],
        ["Ngân hàng", row.ngan_hang || "—"],
        ["Dự án", row.du_an || "—"],
        [laTamUng ? "Lý do tạm ứng" : "Nội dung chuyển tiền", row.noi_dung_trinh || row.ve_viec || "—"],
        ...(laTamUng ? [["Thời gian thanh toán", row.hang_muc || "—"] as [string, string]] : []),
      ]
    : laHopDong
    ? [
        ["Dự án", row.du_an || "—"],
        ["Gói thầu", row.goi_thau || "—"],
        ["Hạng mục", row.hang_muc || "—"],
        ["Số hợp đồng", row.hop_dong_so || "—"],
        ["Bên A", row.ben_a || "—"],
        ["Bên B", row.ben_b || "—"],
        [
          "Giá trị hợp đồng",
          `${fmtMoney(row.gia_tri_hd)} đồng${row.vat_percent != null ? ` (bao gồm thuế VAT ${row.vat_percent}%)` : ""}`,
        ],
      ]
    : [
        ["Đơn vị / Đối tác", row.chu_dau_tu || "—"],
        ["Dự án", row.du_an || "—"],
        ["Hợp đồng số", [row.hop_dong_so, row.ngay_ky_hop_dong ? `ký ngày ${row.ngay_ky_hop_dong}` : ""].filter(Boolean).join(" ") || "—"],
        ["Gói thầu", row.goi_thau || "—"],
        ["Giá trị HĐ", `${fmtMoney(row.gia_tri_hd)} đồng`],
        [`Giá trị nghiệm thu đợt ${row.dot_so ?? ""}`, `${fmtMoney(row.gia_tri_nghiem_thu)} đồng (A)`],
        ["Giữ bảo hành", `${fmtMoney(row.giu_bao_hanh)} đồng (B)`],
        ["Giữ lại từng lần", `${fmtMoney(row.giu_lai_tung_lan)} đồng (C)${row.ty_le_giu_lai ? ` (${row.ty_le_giu_lai}%)` : ""}`],
        ["Khấu trừ tạm ứng", `${fmtMoney(row.khau_tru_tam_ung)} đồng (D)${row.ty_le_thu_hoi ? ` (thu hồi ~${row.ty_le_thu_hoi}%)` : ""}`],
        ["Luỹ kế đã thanh toán", `${fmtMoney(row.luy_ke_da_thanh_toan)} đồng`],
        ["Tạm ứng còn lại", `${fmtMoney(row.tam_ung_con_lai)} đồng`],
      ];

  // ─── Tiến trình duyệt — dựng theo ROUTE của chính phiếu (migration 074) ───
  // Phiếu mới đọc route riêng; phiếu cũ (route rỗng) suy từ luồng cũ. Mỗi bước
  // lấy đúng ô vết ký + ý kiến tương ứng. "here" = bước hiện tại (chưa ký).
  const stepInfo = (st: SigningStatus): { name: string; by: string | null; at: string | null; yk: string | null } => {
    switch (st) {
      case "cho_cap1":
        return {
          name: row.cap1_email ? "Trưởng bộ phận" : "Trưởng bộ phận (Admin duyệt thay)",
          by: row.cap1_by, at: row.cap1_at, yk: row.ykien_cap1,
        };
      case "cho_pgd_qlda":
        return { name: "Phó Giám đốc (Dự án)", by: row.qlda_by, at: row.qlda_at, yk: row.ykien_qlda };
      case "cho_pgd_khdt":
        return { name: "Phó Giám đốc (KHĐT)", by: row.khdt_by, at: row.khdt_at, yk: row.ykien_khdt };
      case "cho_phong_qlda":
        return { name: "Phòng QLDA", by: row.pqlda_by, at: row.pqlda_at, yk: row.ykien_pqlda };
      case "cho_phong_vat_tu":
        return { name: "Phòng Vật tư (xác nhận)", by: row.pvt_by, at: row.pvt_at, yk: row.ykien_pvt };
      case "cho_pho_giam_doc": // phiếu cũ — chặng PGĐ gộp
        return {
          name: "Phó Giám đốc",
          by: row.qlda_by || row.khdt_by,
          at: row.qlda_at || row.khdt_at,
          yk: row.qlda_at ? row.ykien_qlda : row.khdt_at ? row.ykien_khdt : null,
        };
      case "cho_giam_doc":
        return { name: "Giám đốc", by: row.giam_doc_by, at: row.giam_doc_at, yk: row.ykien_giam_doc };
      case "cho_ke_toan":
        return { name: "Kế toán", by: row.ke_toan_by, at: row.ke_toan_at, yk: null };
      default:
        return { name: STATUS_META[st]?.label || st, by: null, at: null, yk: null };
    }
  };
  const steps = stepsOfSubmission(row).map((st) => {
    const x = stepInfo(st);
    return { key: st, name: x.name, by: x.by, at: x.at, yk: x.yk, here: row.status === st };
  });

  return createPortal(
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-start justify-center pt-[5vh] p-4">
      <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[88vh] overflow-hidden shadow-2xl border border-slate-100 flex flex-col">
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-200/60 bg-slate-50/70 shrink-0">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-600 to-cyan-500 flex items-center justify-center shadow-sm shrink-0">
            <FileText size={15} className="text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="font-heading font-extrabold text-slate-800 text-xs leading-tight truncate">
              {/* Phiếu hợp đồng không có "đợt" — ghi "Đợt —" chỉ làm người xem
                  tưởng phiếu nhập thiếu. Thay bằng tên loại phiếu. */}
              {row.ma_phieu} · {row.loai === "ho_so"
                ? `Đợt ${row.dot_so ?? "—"}`
                : LOAI_META[row.loai].label}
            </h4>
            <p className="text-[10px] text-slate-400 font-semibold truncate">
              Biểu mẫu {LOAI_META[row.loai].bieuMau} · {row.created_by_name || row.created_by} lập {fmtDateTime(row.created_at)}
            </p>
          </div>
          <span className={`text-[9px] font-extrabold uppercase px-2 py-1 rounded-full shrink-0 ${meta.chip}`}>
            {meta.label}
          </span>
          <button type="button" onClick={onClose} disabled={busy}
            className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-200 rounded-lg transition-all cursor-pointer disabled:opacity-40">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {err && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 text-[11px] font-bold text-rose-700">{err}</div>
          )}

          {row.status === "tra_lai" && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
              <p className="text-[11px] font-extrabold text-rose-800">
                Bị trả lại từ bước {STATUS_META[(row.tra_lai_tu as SigningStatus) || "cho_pho_giam_doc"]?.label || row.tra_lai_tu}
                {row.tra_lai_boi ? ` bởi ${row.tra_lai_boi}` : ""} · {fmtDateTime(row.tra_lai_luc)}
              </p>
              <p className="text-[11px] font-medium text-rose-700 mt-1">{row.tra_lai_ly_do}</p>
            </div>
          )}

          {/* Số liệu */}
          <section className="space-y-2">
            <h5 className={labelCls}>Nội dung trình</h5>
            {row.ve_viec && <p className="text-xs font-semibold text-slate-700">{row.ve_viec}</p>}
            <div className="bg-slate-50/70 border border-slate-200/60 rounded-xl divide-y divide-slate-200">
              {rowInfo.map(([k, v]) => (
                <div key={k} className="flex gap-3 px-3.5 py-2">
                  <span className="text-[11px] font-semibold text-slate-500 w-52 shrink-0">{k}</span>
                  {/* whitespace-pre-line: phần thân tờ trình xuống dòng nhiều lần,
                      gộp hết thành một khối chữ thì người duyệt không đọc nổi. */}
                  <span className="text-[11px] font-bold text-slate-800 flex-1 min-w-0 whitespace-pre-line">{v}</span>
                </div>
              ))}
              {laChuyenTien ? (
                <div className="flex gap-3 px-3.5 py-2.5 bg-emerald-50/70">
                  <span className="text-[11px] font-extrabold text-emerald-900 w-52 shrink-0">
                    Số tiền đề nghị {laTamUng ? "tạm ứng" : "chuyển"}
                  </span>
                  <span className="text-xs font-extrabold text-emerald-900 flex-1">
                    {fmtMoney(row.de_nghi_thanh_toan)} đồng
                  </span>
                </div>
              ) : !laHopDong && !laToTrinh && !laPhieuYeuCau && !laDonDatHang && (
                <div className="flex gap-3 px-3.5 py-2.5 bg-blue-50/70">
                  <span className="text-[11px] font-extrabold text-blue-900 w-52 shrink-0">
                    Đề nghị thanh toán (A−B−C−D)
                  </span>
                  <span className="text-xs font-extrabold text-blue-900 flex-1">
                    {fmtMoney(row.de_nghi_thanh_toan ?? tinhDeNghi(row))} đồng
                  </span>
                </div>
              )}
            </div>
          </section>

          {/* Bảng vật tư — người duyệt cần đọc ngay tại đây, không phải tải
              file về mới biết đang ký cho cái gì. Chỉ hiện những cột CÓ dữ liệu
              để đơn đặt hàng 12 cột không thành một bảng toàn dấu gạch. */}
          {(laPhieuYeuCau || laDonDatHang) && row.vat_tu.length > 0 && (() => {
            const cols: [keyof typeof row.vat_tu[number], string][] = laDonDatHang
              ? [["ten", "Tên vật tư"], ["quyCach", "Quy cách"], ["dvt", "ĐVT"],
                 ["dinhMuc", "Định mức (4)"], ["luyKeTrong", "Đã TH (5a)"],
                 ["luyKeNgoai", "Đã TH (5b)"], ["chenhLech", "Còn lại (6)"],
                 ["dexuatTrong", "Đề xuất (7a)"], ["dexuatNgoai", "Đề xuất (7b)"],
                 ["lyDo", "Lý do"], ["chiPhi", "Chi phí"], ["ghiChu", "Ghi chú"]]
              : [["ten", "Tên vật tư"], ["quyCach", "Quy cách"], ["dvt", "ĐVT"],
                 ["soLuong", "Số lượng"], ["ngayCap", "Ngày cấp"]];
            const dung = cols.filter(([k]) =>
              row.vat_tu.some((r) => String(r[k] || "").trim() !== ""));
            if (!dung.length) return null;
            return (
              <section className="space-y-2">
                <h5 className={labelCls}>Bảng vật tư ({row.vat_tu.length} dòng)</h5>
                <div className="border border-slate-200/60 rounded-xl overflow-x-auto">
                  <div className="min-w-max">
                    <div className="flex gap-2 px-3 py-2 bg-slate-100/70">
                      <span className={`${labelCls} w-8 shrink-0`}>TT</span>
                      {dung.map(([k, lb]) => (
                        <span key={k} className={`${labelCls} w-28 shrink-0`}>{lb}</span>
                      ))}
                    </div>
                    <div className="divide-y divide-slate-200/70">
                      {row.vat_tu.map((r, i) => (
                        <div key={i} className="flex gap-2 px-3 py-2 items-start">
                          <span className="text-[11px] font-bold text-slate-400 w-8 shrink-0">{r.stt || i + 1}</span>
                          {dung.map(([k]) => (
                            <span key={k} className="text-[11px] font-semibold text-slate-700 w-28 shrink-0 break-words">
                              {String(r[k] || "") || "—"}
                            </span>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            );
          })()}

          {/* Bảng so sánh A-B ↔ B-B′ — thứ quan trọng nhất của phiếu hợp đồng,
              người duyệt cần đọc ngay chứ không phải mở file Word ra xem. */}
          {laHopDong && row.so_sanh.length > 0 && (
            <section className="space-y-2">
              <h5 className={labelCls}>Nội dung so sánh ({row.so_sanh.length} dòng)</h5>
              <div className="border border-slate-200/60 rounded-xl overflow-hidden">
                <div className="grid grid-cols-[32px_1fr_1fr_1fr] gap-2 px-3 py-2 bg-slate-100/70">
                  <span className={labelCls}>TT</span>
                  <span className={labelCls}>Nội dung</span>
                  <span className={labelCls}>Hợp đồng A-B</span>
                  <span className={labelCls}>Hợp đồng B-B′</span>
                </div>
                <div className="divide-y divide-slate-200/70">
                  {row.so_sanh.map((r, i) => (
                    <div key={i} className="grid grid-cols-[32px_1fr_1fr_1fr] gap-2 px-3 py-2 items-start">
                      <span className="text-[11px] font-bold text-slate-400">{r.stt || `${String.fromCharCode(97 + i)})`}</span>
                      <span className="text-[11px] font-bold text-slate-700 break-words">{r.muc || "—"}</span>
                      {/* whitespace-pre-line: người lập xuống dòng trong ô thì
                          giữ nguyên, đúng như lúc in ra Word. */}
                      <span className="text-[11px] font-medium text-slate-600 whitespace-pre-line break-words">{r.ab || "—"}</span>
                      <span className="text-[11px] font-medium text-slate-600 whitespace-pre-line break-words">{r.bb || "—"}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {/* Hồ sơ gốc */}
          {row.files.length > 0 && (
            <section className="space-y-2">
              <h5 className={labelCls}>Hồ sơ gốc ({row.files.length})</h5>
              <div className="space-y-1.5">
                {row.files.map((f) => (
                  <button key={f.path} type="button" onClick={() => openFile(f.path, f.name)}
                    className="w-full flex items-center gap-2 bg-slate-50 hover:bg-slate-100 rounded-lg px-2.5 py-1.5 transition-colors cursor-pointer">
                    <FileText size={12} className="text-slate-400 shrink-0" />
                    <span className="flex-1 min-w-0 text-left text-[11px] font-semibold text-slate-700 truncate">{f.name}</span>
                    <ExternalLink size={11} className="text-slate-300 shrink-0" />
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Tiến trình */}
          <section className="space-y-2">
            <h5 className={labelCls}>Tiến trình duyệt</h5>
            <div className="space-y-2">
              {steps.map((s, i) => {
                const done = !!s.at;
                return (
                  <div key={s.key} className={`flex gap-3 rounded-xl px-3.5 py-2.5 border ${
                    done ? "bg-emerald-50/60 border-emerald-200"
                    : s.here ? "bg-amber-50/70 border-amber-200"
                    : "bg-slate-50/50 border-slate-200/60"
                  }`}>
                    <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                      done ? "bg-emerald-500" : s.here ? "bg-amber-500" : "bg-slate-300"
                    }`}>
                      {done ? <Check size={12} className="text-white" />
                        : <span className="text-white text-[9px] font-extrabold">{i + 1}</span>}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-extrabold text-slate-700">
                        {s.name}
                        {done && s.by ? ` · ${s.by}` : s.here ? " · đang chờ" : ""}
                      </p>
                      {s.at && <p className="text-[10px] font-semibold text-slate-400">{fmtDateTime(s.at)}</p>}
                      {s.yk && <p className="text-[11px] font-medium text-slate-600 mt-1 whitespace-pre-wrap">{s.yk}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Ô thao tác của cấp đang giữ phiếu */}
          {actable && (
            <section className="space-y-2.5 pt-1">
              <h5 className={labelCls}>
                {row.status === "cho_ke_toan" ? "Xác nhận đã chi" : "Ý kiến chỉ đạo của bạn"}
              </h5>
              {row.status !== "cho_ke_toan" && (
                <textarea value={ykien} onChange={(e) => setYkien(e.target.value)} rows={3}
                  placeholder="Ý kiến sẽ được in vào phiếu Word ở mục tương ứng. Để trống nếu chỉ duyệt."
                  className={`${inputCls} w-full resize-y leading-relaxed`} />
              )}
              {showReturn && (
                <textarea value={lyDo} onChange={(e) => setLyDo(e.target.value)} rows={2} autoFocus
                  placeholder="Lý do trả lại (bắt buộc) — người lập sẽ đọc để sửa…"
                  className={`${inputCls} w-full resize-y leading-relaxed border-rose-300 focus:ring-rose-500/20`} />
              )}
            </section>
          )}
        </div>

        <div className="border-t border-slate-200/60 bg-slate-50/70 px-5 py-3 flex flex-wrap justify-end gap-2 shrink-0">
          {editable && (
            <button type="button" onClick={onEdit} disabled={busy}
              className="flex items-center gap-1.5 px-3 py-2 text-slate-600 hover:bg-slate-200/60 font-bold rounded-xl text-[11px] transition-all cursor-pointer disabled:opacity-50">
              <Pencil size={13} /> Sửa phiếu
            </button>
          )}
          {/* Xuất bản phiếu ĐÃ CÓ ý kiến 3 cấp — đây mới là bản đem đi lưu hồ sơ.
              mr-auto đẩy cả cụm trái sang mép, tách khỏi nhóm nút hành động. */}
          <button type="button" onClick={exportDocx} disabled={busy || exporting}
            className="mr-auto flex items-center gap-1.5 px-3 py-2 text-slate-600 hover:bg-slate-200/60 font-bold rounded-xl text-[11px] transition-all cursor-pointer disabled:opacity-50">
            {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            Xuất phiếu trình
          </button>
          <button type="button" onClick={onClose} disabled={busy}
            className="px-4 py-2 text-slate-500 hover:bg-slate-200/60 font-bold rounded-xl text-xs transition-all cursor-pointer disabled:opacity-50">
            Đóng
          </button>
          {submittable && (
            <button type="button" onClick={submit} disabled={busy}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-xs font-semibold px-4 py-2 rounded-xl shadow-md shadow-blue-500/10 transition-all cursor-pointer">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
              {row.status === "tra_lai" ? "Trình lại" : "Trình duyệt"}
            </button>
          )}
          {actable && (
            <>
              <button type="button"
                onClick={() => (showReturn ? sendBack() : setShowReturn(true))}
                disabled={busy}
                className="flex items-center gap-1.5 px-4 py-2 bg-white border border-rose-200 text-rose-600 hover:bg-rose-50 text-xs font-bold rounded-xl transition-all cursor-pointer disabled:opacity-50">
                {busy && showReturn ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}
                {showReturn ? "Xác nhận trả lại" : "Trả lại"}
              </button>
              {!showReturn && (
                <button type="button" onClick={approve} disabled={busy}
                  className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-xs font-semibold px-4 py-2 rounded-xl shadow-md shadow-blue-500/10 transition-all cursor-pointer">
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                  {ACTION_LABEL[row.status] || "Duyệt & chuyển tiếp"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
