"use client";

// ============================================================
// Tab "Khấu trừ xử phạt" (migration 139) — thay bảng Excel theo dõi hồ sơ khấu
// trừ / xử phạt vi phạm an toàn. Một dòng = một hồ sơ, hai phòng cùng điền:
//   P.ATLĐ (xanh dương) nhập đầu vào · P.KHĐT (cam) nhập đầu ra ·
//   cột xanh lá tự tính: Còn lại = Phải trừ − Đã trừ, Trạng thái, Số ngày, Cảnh báo.
// Màu dòng: 20–30 ngày cam · trên 30 ngày đỏ · đã khấu trừ xanh lá.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as XLSX from "xlsx";
import {
  Search, Plus, Pencil, Trash2, Loader2, AlertCircle, X, FileDown, FileText, Upload, Link2, ExternalLink,
  ClipboardList, Wallet, CircleCheck, Siren, Eye, Download,
} from "lucide-react";
import {
  type Penalty, type PenaltyInput, type PenaltyOutput, type PenaltyStatus, type PenaltyAlert, type PenaltyDoc,
  DOC_LABEL, docOf,
  KIND_CFG, type PenaltyKind, PENALTY_STATUS_META, fetchPenalties, createPenalty, updatePenalty, deletePenalty,
  uploadPenaltyFile, setPenaltyFile, setPenaltyLink, removePenaltyFile, penaltyFileUrl,
  penaltyStatus, trackingDays, penaltyAlert, todayVN, composeViolations, type ViolationLine, downloadPenaltyDecision,
} from "@/lib/atldPenalties";
import { fetchSharedPartners, type SharedPartner } from "@/lib/atldVouchers";
import { fetchProjectCatalog, type Project } from "@/lib/projectCatalog";
import { formatMoney } from "@/lib/atldStock";
import { foldVi } from "@/lib/financePartners";
import AtldPartnerPicker from "@/components/atld/AtldPartnerPicker";
import AtldPersonPicker from "@/components/atld/AtldPersonPicker";
import AtldViolationLines, { EMPTY_LINE } from "@/components/atld/AtldViolationLines";
import { BTN_OUTLINE, BTN_PRIMARY, CONTROL_BOX, initialParam } from "@/components/atld/ui";
import { useConfirmBox, useNoticeBox } from "@/components/ConfirmDialog";
import { requestDelete, DELETE_REQUEST_SENT } from "@/lib/atldDeleteRequests";
import { normalizeName } from "@/lib/approvers";

type Row = Penalty & { status: PenaltyStatus; days: number | null; alert: PenaltyAlert; haystack: string };
type Filter = "all" | "open" | "qua_han" | "sap_qua_han" | "da";

// Mỗi từ khoá phải KHỞI ĐẦU một từ trong tên (gõ "an" không ra "Thanh", "Phước").
const matchesWords = (hay: string, q: string) => {
  // Tách theo mọi ký tự không phải chữ/số để "001" khớp "HS.XP-2026-001", "026" khớp "52/026/QĐ".
  const h = ` ${hay.replace(/[^a-z0-9]+/g, " ")}`;
  return normalizeName(q).split(/[^a-z0-9]+/).filter(Boolean).every((t) => h.includes(` ${t}`));
};

const fmtDate = (d: string | null) => (d ? d.split("-").reverse().join("/") : "");
const money = (n: number) => `${formatMoney(n)} đ`;

// Chỉ dùng lớp màu ĐÃ có bản dark mode trong globals.css (html.dark …) — lớp lạ như
// bg-rose-50/80 không được map nên dark mode hiện nền hồng nhạt + chữ trắng (lỗi 07/10/2026).
const ROW_BG: Record<Exclude<PenaltyAlert, null>, string> = {
  qua_han: "bg-rose-100 hover:bg-rose-100/70",
  sap_qua_han: "bg-orange-100 hover:bg-orange-100/50",
  da: "bg-emerald-50/50 hover:bg-emerald-50",
};

// canApprove = cờ "Duyệt xuất kho ATLĐ" / Admin: xoá thẳng; không có thì Xoá chỉ gửi yêu cầu (142).
// kind="ppe": tab "Khấu trừ PPE" — cùng bảng/luồng, chỉ đổi nhãn, bỏ chọn Định mức xử phạt + Xuất phiếu QĐ xử phạt.
export default function AtldPenaltyTab({ canInput, canProcess, canApprove, kind = "penalty" }: { canInput: boolean; canProcess: boolean; canApprove: boolean; kind?: PenaltyKind }) {
  const K = KIND_CFG[kind];
  const [items, setItems] = useState<Penalty[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<string | null>(null);
  // Bộ lọc ban đầu có thể đến từ tab Dashboard (?q=&filter=&project=&from=&to=).
  const [query, setQuery] = useState(() => initialParam("q"));
  const [filter, setFilter] = useState<Filter>(() => (initialParam("filter") as Filter) || "all");
  const [project, setProject] = useState(() => initialParam("project"));
  // Lọc theo Ngày ban hành (yyyy-mm-dd, so sánh chuỗi được).
  const [dateFrom, setDateFrom] = useState(() => initialParam("from"));
  const [dateTo, setDateTo] = useState(() => initialParam("to"));
  const [editing, setEditing] = useState<Penalty | "new" | null>(null);
  // Bấm vào dòng -> popup xem toàn bộ thông tin (bảng nhiều cột, màn nhỏ khó đọc).
  const [viewingId, setViewingId] = useState<string | null>(null);
  // Icon mắt ở cột Số QĐ / Số chứng từ -> popup xem tệp.
  const [fileOf, setFileOf] = useState<{ id: string; kind: PenaltyDoc } | null>(null);
  const { ask, confirmNode } = useConfirmBox();
  const { notify, noticeNode } = useNoticeBox();

  const load = useCallback(async () => {
    const r = await fetchPenalties(kind);
    setItems(r.rows);
    setError(r.error);
    setLoading(false);
  }, [kind]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const today = todayVN();
  const rows: Row[] = useMemo(
    () =>
      items.map((p) => {
        const status = penaltyStatus(p);
        const days = trackingDays(p, today);
        return {
          ...p,
          status,
          days,
          alert: penaltyAlert(status, days),
          haystack: normalizeName(
            // Chỉ các trường định danh: gom cả nội dung / người nhập vào thì gõ tên nhà thầu ra thừa dòng.
            [p.contractor_name, p.ma_ho_so, p.so_quyet_dinh, p.so_chung_tu, p.project_code, p.project_name]
              .filter(Boolean)
              .join(" ")
          ),
        };
      }),
    [items, today]
  );

  const projects = useMemo(
    () => Array.from(new Set(rows.map((r) => r.project_name || r.project_code || "").filter(Boolean))).sort((a, b) => a.localeCompare(b, "vi")),
    [rows]
  );

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (project && (r.project_name || r.project_code) !== project) return false;
        if (dateFrom && (!r.ngay_ban_hanh || r.ngay_ban_hanh < dateFrom)) return false;
        if (dateTo && (!r.ngay_ban_hanh || r.ngay_ban_hanh > dateTo)) return false;
        if (filter === "open" && r.status === "da") return false;
        if (filter === "da" && r.status !== "da") return false;
        if ((filter === "qua_han" || filter === "sap_qua_han") && r.alert !== filter) return false;
        return matchesWords(r.haystack, query);
      }),
    [rows, filter, project, dateFrom, dateTo, query]
  );

  const sum = useMemo(() => {
    const s = { phai: 0, da: 0, con: 0, quaHan: 0, sapQuaHan: 0, done: 0, open: 0 };
    for (const r of rows) {
      s.phai += r.gia_tri_phai_tru;
      s.da += r.gia_tri_da_tru;
      s.con += r.gia_tri_con_lai;
      if (r.alert === "qua_han") s.quaHan++;
      if (r.alert === "sap_qua_han") s.sapQuaHan++;
      if (r.status === "da") s.done++;
      else s.open++;
    }
    return s;
  }, [rows]);

  function remove(r: Row) {
    if (!canApprove) {
      return ask({
        title: `Gửi yêu cầu xoá hồ sơ ${r.ma_ho_so}?`,
        message: "Chờ Trưởng/Phó phòng xác nhận xoá.",
        confirmLabel: "Gửi yêu cầu xoá",
        onConfirm: async () => {
          setRowErr(null);
          setViewingId(null);
          const e = await requestDelete("penalty", r.id);
          return e ? setRowErr(`${r.ma_ho_so}: ${e}`) : notify(DELETE_REQUEST_SENT, "success");
        },
      });
    }
    ask({
      title: `Xoá hồ sơ ${r.ma_ho_so}?`,
      message:
        r.gia_tri_da_tru > 0
          ? `Hồ sơ đã có ${money(r.gia_tri_da_tru)} KHĐT ghi khấu trừ. Xoá hẳn cả phần của KHĐT và mọi tệp đính kèm, không hoàn tác được.`
          : "Xoá hẳn hồ sơ và mọi tệp đính kèm (quyết định, chứng từ), không hoàn tác được.",
      confirmLabel: "Xoá hồ sơ",
      onConfirm: async () => {
        setRowErr(null);
        setViewingId(null);
        const e = await deletePenalty(r.id);
        if (e) return setRowErr(`${r.ma_ho_so}: ${e}`);
        // Xoá CSDL xong mới dọn tệp (ghi hỏng thì tệp còn nguyên).
        for (const p of [r.qd_file_path, r.ct_file_path]) if (p) await removePenaltyFile(p);
        load();
      },
    });
  }

  const FILTERS: { key: Filter; label: string; count: number; dot: string }[] = [
    { key: "all", label: "Tất cả", count: rows.length, dot: "bg-slate-400" },
    { key: "open", label: "Chưa xong", count: sum.open, dot: "bg-amber-500" },
    { key: "sap_qua_han", label: "20–30 ngày", count: sum.sapQuaHan, dot: "bg-orange-500" },
    { key: "qua_han", label: "Quá hạn", count: sum.quaHan, dot: "bg-rose-500" },
    { key: "da", label: "Đã khấu trừ", count: sum.done, dot: "bg-emerald-500" },
  ];

  const th = "px-3 py-2.5 text-[10px] font-extrabold uppercase tracking-wider whitespace-nowrap";
  const td = "px-3 py-2.5 align-top";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat icon={ClipboardList} tone="blue" label="Hồ sơ" value={`${rows.length}`} sub={`${sum.open} chưa xong`} />
        <Stat icon={Wallet} tone="slate" label="Phải khấu trừ" value={money(sum.phai)} sub={`Đã trừ ${money(sum.da)}`} />
        <Stat icon={CircleCheck} tone={sum.con > 0 ? "amber" : "emerald"} label="Còn lại phải trừ" value={money(sum.con)} />
        <Stat icon={Siren} tone="rose" label="Quá hạn (> 30 ngày)" value={`${sum.quaHan}`} sub={`${sum.sapQuaHan} hồ sơ 20–30 ngày`} onClick={() => setFilter("qua_han")} />
      </div>

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className={`${CONTROL_BOX} flex-1 min-w-[220px] gap-2 px-3 focus-within:border-[#00AEEF]`}>
            <Search size={14} className="text-slate-400 shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm tên nhà thầu, mã hồ sơ, số QĐ / chứng từ, dự án…"
              className="flex-1 min-w-0 bg-transparent text-xs font-semibold text-slate-700 placeholder:text-slate-400 focus:outline-none"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} className="text-slate-300 hover:text-slate-500 cursor-pointer" aria-label="Xoá tìm kiếm">
                <X size={13} />
              </button>
            )}
          </div>
          <select value={project} onChange={(e) => setProject(e.target.value)} className={`${CONTROL_BOX} px-3 text-xs font-semibold text-slate-600 max-w-[240px]`}>
            <option value="">Tất cả dự án</option>
            {projects.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <div className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-500" title="Lọc theo Ngày ban hành">
            Ngày ban hành
            <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} aria-label="Từ ngày" className={`${CONTROL_BOX} px-2 text-xs font-semibold text-slate-600 tabular-nums`} />
            –
            <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} aria-label="Đến ngày" className={`${CONTROL_BOX} px-2 text-xs font-semibold text-slate-600 tabular-nums`} />
            {(dateFrom || dateTo) && (
              <button type="button" onClick={() => { setDateFrom(""); setDateTo(""); }} className="text-slate-300 hover:text-slate-500 cursor-pointer" aria-label="Xoá lọc ngày">
                <X size={13} />
              </button>
            )}
          </div>
          <button type="button" onClick={() => exportExcel(filtered, kind)} disabled={filtered.length === 0} className={BTN_OUTLINE}>
            <FileDown size={14} /> Tải về
          </button>
          {canInput && (
            <button type="button" onClick={() => setEditing("new")} className={BTN_PRIMARY}>
              <Plus size={14} /> {K.createLabel}
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" className="inline-flex flex-wrap gap-1 p-1 bg-slate-50 border border-slate-100 rounded-xl">
            {FILTERS.map((f) => {
              const active = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setFilter(f.key)}
                  className={`h-7 inline-flex items-center gap-1.5 px-3 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                    active ? "bg-[#005BAC] text-white shadow-sm" : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${active ? "bg-white" : f.dot}`} />
                  {f.label}
                  <span className={`tabular-nums ${active ? "text-white/80" : "text-slate-400"}`}>{f.count}</span>
                </button>
              );
            })}
          </div>
          <span className="ml-auto text-[11px] text-slate-400">
            Đang hiện <b className="text-slate-600">{filtered.length}</b> / {rows.length} hồ sơ
          </span>
        </div>
      </div>

      {(error || rowErr) && (
        <div className="flex items-start gap-2 bg-rose-50 border border-rose-200 text-rose-600 text-xs font-semibold px-4 py-3 rounded-xl">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error || rowErr}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-slate-400 text-xs font-semibold">
            <Loader2 size={16} className="animate-spin" /> Đang tải hồ sơ…
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-16 text-center text-xs font-semibold text-slate-400">
            {rows.length === 0 ? (canInput ? "Chưa có hồ sơ nào — bấm “{K.createLabel}” để bắt đầu." : "Chưa có hồ sơ nào.") : "Không có hồ sơ khớp bộ lọc."}
          </p>
        ) : (
          <table className="w-full text-xs min-w-[1900px]">
            <thead>
              <tr className="text-white text-[10px] font-extrabold uppercase tracking-wider">
                <th colSpan={11} className="px-3 py-3 bg-[#005BAC] text-center">P.ATLĐ nhập — thông tin đầu vào</th>
                <th colSpan={6} className="px-3 py-3 bg-orange-500 text-center">P.KHĐT nhập — thông tin đầu ra</th>
                {/* Dải xanh lá phủ luôn cột Thao tác cho liền mạch tới mép bảng. */}
                <th colSpan={5} className="px-3 py-3 bg-emerald-600 text-center">Tự tính — không sửa tay</th>
              </tr>
              <tr className="text-left">
                {["Mã hồ sơ", "Loại hồ sơ", K.docNo, "Ngày ban hành", "Dự án", K.contractor, K.person, "Nội dung"].map((h) => (
                  <th key={h} className={`${th} bg-blue-50 text-[#005BAC]`}>{h}</th>
                ))}
                <th className={`${th} bg-blue-50 text-[#005BAC] text-right`}>Giá trị phải khấu trừ</th>
                <th className={`${th} bg-blue-50 text-[#005BAC]`}>Người lập</th>
                <th className={`${th} bg-blue-50 text-[#005BAC]`}>Ngày gửi KHĐT</th>
                <th className={`${th} bg-orange-50 text-orange-700`}>Ngày tiếp nhận</th>
                <th className={`${th} bg-orange-50 text-orange-700`}>Đợt thanh toán</th>
                <th className={`${th} bg-orange-50 text-orange-700 text-right`}>Giá trị đã khấu trừ</th>
                <th className={`${th} bg-orange-50 text-orange-700`}>Ngày khấu trừ</th>
                <th className={`${th} bg-orange-50 text-orange-700`}>Số chứng từ</th>
                <th className={`${th} bg-orange-50 text-orange-700`}>Người nhập</th>
                <th className={`${th} bg-emerald-50 text-emerald-700 text-right`}>Giá trị còn lại</th>
                <th className={`${th} bg-emerald-50 text-emerald-700`}>Trạng thái</th>
                <th className={`${th} bg-emerald-50 text-emerald-700 text-right`}>Số ngày theo dõi</th>
                <th className={`${th} bg-emerald-50 text-emerald-700`}>Cảnh báo</th>
                <th className={`${th} bg-emerald-50 text-emerald-700 text-right`}>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setViewingId(r.id)}
                  title="Bấm để xem toàn bộ thông tin hồ sơ"
                  className={`border-b border-slate-100 last:border-0 cursor-pointer ${r.alert ? ROW_BG[r.alert] : "hover:bg-slate-50/60"}`}
                >
                  <td className={`${td} font-mono font-bold text-[#005BAC] whitespace-nowrap`}>{r.ma_ho_so}</td>
                  <td className={`${td} text-slate-600 whitespace-nowrap`}>{r.loai_ho_so}</td>
                  <td className={`${td} whitespace-nowrap`}><DocCell row={r} kind="qd" onView={() => setFileOf({ id: r.id, kind: "qd" })} /></td>
                  <td className={`${td} tabular-nums text-slate-600 whitespace-nowrap`}>{fmtDate(r.ngay_ban_hanh)}</td>
                  <td className={`${td} text-slate-700 min-w-[160px]`}>
                    {r.project_name || "—"}
                    {r.project_code && <span className="block text-[10px] font-mono text-slate-400">{r.project_code}</span>}
                  </td>
                  <td className={`${td} font-semibold text-slate-700 min-w-[200px]`}>{r.contractor_name}</td>
                  <td className={`${td} text-slate-700 min-w-[140px]`}>{r.nguoi_vi_pham || "—"}</td>
                  <td className={`${td} text-slate-600 min-w-[220px] whitespace-pre-line`}>{r.noi_dung || "—"}</td>
                  <td className={`${td} text-right tabular-nums font-bold text-slate-800 whitespace-nowrap`}>{money(r.gia_tri_phai_tru)}</td>
                  <td className={`${td} text-slate-600 whitespace-nowrap`}>{r.nguoi_lap || "—"}</td>
                  <td className={`${td} tabular-nums text-slate-600 whitespace-nowrap`}>{fmtDate(r.ngay_gui_khdt) || "—"}</td>
                  <td className={`${td} tabular-nums text-slate-600 whitespace-nowrap`}>{fmtDate(r.ngay_tiep_nhan)}</td>
                  <td className={`${td} text-slate-600 whitespace-nowrap`}>{r.dot_thanh_toan}</td>
                  <td className={`${td} text-right tabular-nums font-semibold text-slate-700 whitespace-nowrap`}>{r.gia_tri_da_tru ? money(r.gia_tri_da_tru) : ""}</td>
                  <td className={`${td} tabular-nums text-slate-600 whitespace-nowrap`}>{fmtDate(r.ngay_khau_tru)}</td>
                  <td className={`${td} whitespace-nowrap`}><DocCell row={r} kind="ct" onView={() => setFileOf({ id: r.id, kind: "ct" })} /></td>
                  <td className={`${td} text-slate-600 whitespace-nowrap`}>{r.nguoi_nhap}</td>
                  <td className={`${td} text-right tabular-nums font-extrabold whitespace-nowrap ${r.gia_tri_con_lai > 0 ? "text-rose-600" : "text-emerald-600"}`}>{money(r.gia_tri_con_lai)}</td>
                  <td className={`${td} whitespace-nowrap`}>
                    <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${PENALTY_STATUS_META[r.status].cls}`}>{PENALTY_STATUS_META[r.status].label}</span>
                  </td>
                  <td className={`${td} text-right tabular-nums font-bold text-slate-700`}>{r.days ?? ""}</td>
                  <td className={`${td} whitespace-nowrap`}><AlertBadge alert={r.alert} /></td>
                  <td className={`${td} whitespace-nowrap`}>
                    <div className="flex items-center justify-end gap-1">
                      {(canInput || canProcess) && (
                        <IconBtn title="Sửa hồ sơ" onClick={() => setEditing(r)}><Pencil size={13} /></IconBtn>
                      )}
                      {canInput && (
                        <IconBtn title="Xoá hồ sơ" danger onClick={() => remove(r)}><Trash2 size={13} /></IconBtn>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {viewingId && rows.find((r) => r.id === viewingId) && (
        <PenaltyDetail
          row={rows.find((r) => r.id === viewingId)!}
          kind={kind}
          canEdit={canInput || canProcess}
          onDelete={canInput ? remove : undefined}
          onClose={() => setViewingId(null)}
          onEdit={(r) => {
            setViewingId(null);
            setEditing(r);
          }}
          onViewFile={(r, kind) => setFileOf({ id: r.id, kind })}
        />
      )}
      {fileOf && rows.find((r) => r.id === fileOf.id) && (
        <PenaltyFileViewer
          row={rows.find((r) => r.id === fileOf.id)!}
          kind={fileOf.kind}
          canDelete={fileOf.kind === "qd" ? canInput : canProcess}
          onClose={() => setFileOf(null)}
          onChanged={load}
        />
      )}
      {editing && (
        <PenaltyModal
          item={editing === "new" ? null : editing}
          kind={kind}
          canInput={canInput}
          canProcess={canProcess}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
          onChanged={load}
        />
      )}
      {confirmNode}
      {noticeNode}
    </div>
  );
}

function exportExcel(rows: Row[], kind: PenaltyKind) {
  const K = KIND_CFG[kind];
  const header = [
    "Mã Hồ Sơ", "Loại Hồ Sơ", "Số Quyết Định / Phiếu Cấp Phát", "Ngày Ban Hành", "Mã Dự Án", "Dự Án", kind === "ppe" ? "Tên Đối Tượng / Nhà Thầu" : "Nhà Thầu Phụ", "Nội Dung",
    "Giá Trị Phải Khấu Trừ", "Người Lập", "Ngày Gửi Thông Tin Cho KHĐT",
    "Ngày Tiếp Nhận", "Đợt Thanh Toán", "Giá Trị Đã Khấu Trừ", "Ngày Khấu Trừ", "Số Chứng Từ", "Người Nhập",
    "Giá Trị Còn Lại", "Trạng Thái Xử Lý", "Số Ngày Theo Dõi", "Cảnh Báo Quá Hạn", "Ghi Chú (KHĐT)",
  ];
  const alertText: Record<Exclude<PenaltyAlert, null>, string> = { qua_han: "QUÁ HẠN", sap_qua_han: "Sắp quá hạn", da: "" };
  const body = rows.map((r) => [
    r.ma_ho_so, r.loai_ho_so, r.so_quyet_dinh || "", fmtDate(r.ngay_ban_hanh), r.project_code || "", r.project_name || "", r.contractor_name, r.noi_dung || "",
    r.gia_tri_phai_tru, r.nguoi_lap || "", fmtDate(r.ngay_gui_khdt),
    fmtDate(r.ngay_tiep_nhan), r.dot_thanh_toan || "", r.gia_tri_da_tru || "", fmtDate(r.ngay_khau_tru), r.so_chung_tu || "", r.nguoi_nhap || "",
    r.gia_tri_con_lai, PENALTY_STATUS_META[r.status].label, r.days ?? "", r.alert ? alertText[r.alert] : "", r.ghi_chu || "",
  ]);
  const ws = XLSX.utils.aoa_to_sheet([
    [K.sheetTitle],
    [`Xuất lúc ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`],
    [],
    header,
    ...body,
  ]);
  ws["!cols"] = header.map((h) => ({ wch: Math.max(12, Math.min(40, h.length + 4)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, K.sheet);
  XLSX.writeFile(wb, `${K.fileStem}_${todayVN()}.xlsx`);
}

function AlertBadge({ alert }: { alert: PenaltyAlert }) {
  if (alert === "qua_han") return <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-md bg-rose-600 text-white">QUÁ HẠN</span>;
  if (alert === "sap_qua_han") return <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-md bg-orange-500 text-white">Sắp quá hạn</span>;
  return null;
}

function DocCell({ row, kind, onView }: { row: Penalty; kind: PenaltyDoc; onView: () => void }) {
  const d = docOf(row, kind);
  const hasDoc = !!(d.path || d.link);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-slate-700 font-semibold">{d.no || (hasDoc ? "" : kind === "qd" ? "—" : "")}</span>
      {hasDoc && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onView();
          }}
          title={`Xem ${DOC_LABEL[kind].toLowerCase()}`}
          aria-label={`Xem ${DOC_LABEL[kind].toLowerCase()}`}
          className={`p-1 rounded-lg cursor-pointer ${kind === "qd" ? "text-[#005BAC] hover:bg-blue-50" : "text-orange-600 hover:bg-orange-50"}`}
        >
          <Eye size={14} />
        </button>
      )}
    </span>
  );
}

const isPdf = (name: string) => /\.pdf$/i.test(name);
const isImage = (name: string) => /\.(png|jpe?g|webp|gif|heic)$/i.test(name);

// ─── Popup xem tệp quyết định giữa màn hình: xem ngay, Tải về, Xoá ───
function PenaltyFileViewer({
  row, kind, canDelete, onClose, onChanged,
}: {
  row: Penalty;
  kind: PenaltyDoc;
  canDelete: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const doc = docOf(row, kind);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!docOf(row, kind).path);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const name = doc.name || doc.path?.split("/").pop() || "";

  useEffect(() => {
    if (!doc.path) return;
    let alive = true;
    penaltyFileUrl(doc.path).then((u) => {
      if (!alive) return;
      setUrl(u);
      setLoading(false);
      if (!u) setErr("Không mở được tệp — tệp đã bị xoá hoặc tài khoản không có quyền xem.");
    });
    return () => {
      alive = false;
    };
  }, [doc.path]);

  async function download() {
    if (!doc.path) {
      if (doc.link) window.open(doc.link, "_blank", "noopener,noreferrer");
      return;
    }
    setBusy(true);
    const u = await penaltyFileUrl(doc.path, name || (kind === "qd" ? "quyet-dinh" : "chung-tu"));
    setBusy(false);
    if (!u) return setErr("Không tải được tệp.");
    window.location.assign(u);
  }

  // Ghi CSDL trước rồi mới xoá tệp trong kho (ghi hỏng thì tệp còn nguyên).
  async function remove() {
    setBusy(true);
    setErr(null);
    let e: string | null = null;
    if (doc.path) {
      e = await setPenaltyFile(row.id, null, null, kind);
      if (!e) await removePenaltyFile(doc.path);
    } else if (doc.link) {
      e = await setPenaltyLink(row.id, null, kind);
    }
    setBusy(false);
    setConfirmDel(false);
    if (e) return setErr(e);
    onChanged();
    onClose();
  }

  const hasDoc = !!(doc.path || doc.link);
  const what = kind === "qd" ? "quyết định" : "chứng từ";

  return createPortal(
    <div className="fixed inset-0 z-[90] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl flex flex-col max-h-[92vh] animate-in zoom-in-95 duration-150">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-100">
          <FileText size={16} className="text-[#005BAC] shrink-0" />
          <h2 className="font-heading font-extrabold text-sm text-slate-800 flex-1 min-w-0 truncate">
            {DOC_LABEL[kind]} {doc.no || "—"} <span className="font-mono text-slate-400 font-semibold">· {row.ma_ho_so}</span>
          </h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-rose-500 cursor-pointer" aria-label="Đóng">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto bg-slate-50 flex items-center justify-center p-3">
          {doc.path ? (
            loading ? (
              <span className="flex items-center gap-2 text-xs font-semibold text-slate-400 py-20">
                <Loader2 size={16} className="animate-spin" /> Đang mở tệp…
              </span>
            ) : url && isPdf(name) ? (
              <iframe src={url} title={name} className="w-full h-[70vh] rounded-lg bg-white border border-slate-200" />
            ) : url && isImage(name) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={url} alt={name} className="max-w-full max-h-[70vh] object-contain rounded-lg" />
            ) : url ? (
              <p className="text-xs font-semibold text-slate-500 py-20">Không xem trước được loại tệp này — bấm Tải về.</p>
            ) : null
          ) : doc.link ? (
            <div className="text-center space-y-3 py-16">
              <p className="text-xs font-semibold text-slate-500">{kind === "qd" ? "Quyết định" : "Chứng từ"} lưu dạng link ngoài (Drive / OneDrive…)</p>
              <a href={doc.link} target="_blank" rel="noopener noreferrer" className={BTN_PRIMARY}>
                <ExternalLink size={14} /> Mở link
              </a>
              <p className="text-[11px] text-slate-400 break-all max-w-xl">{doc.link}</p>
            </div>
          ) : (
            <p className="text-xs font-semibold text-slate-400 py-20">Hồ sơ chưa có tệp {what}.</p>
          )}
        </div>

        {err && (
          <p className="flex items-start gap-1.5 text-[11px] font-semibold text-rose-500 px-5 pt-3">
            <AlertCircle size={13} className="mt-0.5 shrink-0" /> {err}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-t border-slate-100">
          {name && <span className="text-[11px] text-slate-400 truncate max-w-[50%]">{name}</span>}
          <div className="ml-auto flex items-center gap-2">
            {canDelete && hasDoc &&
              (confirmDel ? (
                <>
                  <span className="text-[11px] font-semibold text-rose-600">Xoá {doc.path ? "tệp" : "link"} {what}?</span>
                  <button type="button" onClick={() => setConfirmDel(false)} disabled={busy} className={BTN_OUTLINE}>
                    Không
                  </button>
                  <button type="button" onClick={remove} disabled={busy} className={`${BTN_OUTLINE} !border-rose-200 !text-rose-600`}>
                    {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Xoá
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirmDel(true)} className={`${BTN_OUTLINE} !text-rose-600`}>
                  <Trash2 size={13} /> Xoá
                </button>
              ))}
            {hasDoc && (
              <button type="button" onClick={download} disabled={busy} className={BTN_PRIMARY}>
                {doc.path ? <Download size={13} /> : <ExternalLink size={13} />} {doc.path ? "Tải về" : "Mở link"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Popup xem toàn bộ thông tin một hồ sơ (bấm vào dòng) ───
function Field({ label, value, wide, strong }: { label: string; value: React.ReactNode; wide?: boolean; strong?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</p>
      <div className={`text-xs mt-0.5 whitespace-pre-line break-words ${strong ? "font-extrabold text-slate-800" : "font-semibold text-slate-700"}`}>
        {value === null || value === undefined || value === "" ? <span className="text-slate-300">—</span> : value}
      </div>
    </div>
  );
}

function PenaltyDetail({
  row, kind, canEdit, onClose, onEdit, onViewFile, onDelete,
}: {
  row: Row;
  kind: PenaltyKind;
  canEdit: boolean;
  onClose: () => void;
  onEdit: (r: Row) => void;
  onDelete?: (r: Row) => void;
  onViewFile: (r: Row, kind: PenaltyDoc) => void;
}) {
  // "Xuất phiếu" Quyết định xử phạt — hạn khắc phục không lưu trong hồ sơ, chọn lúc xuất.
  const K = KIND_CFG[kind];
  const [han, setHan] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  async function exportDecision() {
    setExporting(true);
    setExportErr(null);
    try {
      await downloadPenaltyDecision(row, han);
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : "Lỗi xuất phiếu.");
    } finally {
      setExporting(false);
    }
  }
  const docValue = (kind: PenaltyDoc) => {
    const d = docOf(row, kind);
    const has = !!(d.path || d.link);
    if (!d.no && !has) return null;
    return (
      <span className="inline-flex items-center gap-1.5">
        {d.no}
        {has && (
          <button type="button" onClick={() => onViewFile(row, kind)} className="inline-flex items-center gap-1 text-[#005BAC] hover:underline cursor-pointer">
            <Eye size={13} /> Xem
          </button>
        )}
      </span>
    );
  };
  return createPortal(
    <div className="fixed inset-0 z-[80] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl p-6 space-y-4 animate-in zoom-in-95 duration-150 max-h-[92vh] overflow-y-auto"
      >
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <h2 className="font-heading font-extrabold text-sm text-slate-800">
              Hồ sơ <span className="font-mono text-[#005BAC]">{row.ma_ho_so}</span>
            </h2>
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${PENALTY_STATUS_META[row.status].cls}`}>{PENALTY_STATUS_META[row.status].label}</span>
              <AlertBadge alert={row.alert} />
              {row.days != null && <span className="text-[11px] font-semibold text-slate-500">Theo dõi {row.days} ngày</span>}
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-rose-500 cursor-pointer" aria-label="Đóng">
            <X size={18} />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2">
            <p className="text-[10px] font-bold text-slate-400 uppercase">Phải khấu trừ</p>
            <p className="text-sm font-extrabold text-slate-800 tabular-nums">{money(row.gia_tri_phai_tru)}</p>
          </div>
          <div className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2">
            <p className="text-[10px] font-bold text-slate-400 uppercase">Đã khấu trừ</p>
            <p className="text-sm font-extrabold text-slate-800 tabular-nums">{money(row.gia_tri_da_tru)}</p>
          </div>
          <div className={`rounded-xl border px-3 py-2 ${row.gia_tri_con_lai > 0 ? "bg-rose-50 border-rose-100" : "bg-emerald-50 border-emerald-100"}`}>
            <p className="text-[10px] font-bold text-slate-400 uppercase">Còn lại</p>
            <p className={`text-sm font-extrabold tabular-nums ${row.gia_tri_con_lai > 0 ? "text-rose-600" : "text-emerald-600"}`}>{money(row.gia_tri_con_lai)}</p>
          </div>
        </div>

        <section className="rounded-xl border border-blue-100 bg-blue-50/70 p-4 space-y-3">
          <p className="text-[11px] font-extrabold text-[#005BAC] uppercase tracking-wider">P.ATLĐ — thông tin đầu vào</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Loại hồ sơ" value={row.loai_ho_so} />
            <Field label={K.docNo} value={docValue("qd")} />
            <Field label="Ngày ban hành" value={fmtDate(row.ngay_ban_hanh)} />
            <Field label="Dự án" value={[row.project_code, row.project_name].filter(Boolean).join(" — ")} />
            <Field label={K.contractor} value={row.contractor_name} wide strong />
            <Field label={K.person} value={row.nguoi_vi_pham} wide />
            <Field label="Nội dung" value={row.noi_dung} wide />
            <Field label="Người lập" value={row.nguoi_lap} />
            <Field label="Ngày gửi thông tin cho KHĐT" value={fmtDate(row.ngay_gui_khdt)} />
          </div>
        </section>

        <section className="rounded-xl border border-orange-100 bg-orange-50/40 p-4 space-y-3">
          <p className="text-[11px] font-extrabold text-orange-700 uppercase tracking-wider">P.KHĐT — thông tin đầu ra</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Ngày tiếp nhận" value={fmtDate(row.ngay_tiep_nhan)} />
            <Field label="Đợt thanh toán" value={row.dot_thanh_toan} />
            <Field label="Ngày khấu trừ" value={fmtDate(row.ngay_khau_tru)} />
            <Field label="Số chứng từ" value={docValue("ct")} />
            <Field label="Người nhập" value={row.nguoi_nhap} />
            <Field label="Ghi chú (KHĐT)" value={row.ghi_chu} />
          </div>
        </section>

        {exportErr && (
          <div className="flex items-start gap-2 text-[11px] font-semibold text-rose-600">
            <AlertCircle size={14} className="mt-0.5 shrink-0" /> {exportErr}
          </div>
        )}
        <div className="flex flex-wrap justify-end items-center gap-2">
          {onDelete && (
            <button type="button" onClick={() => onDelete(row)} className={`${BTN_OUTLINE} !text-rose-600 mr-auto`}>
              <Trash2 size={13} /> Xoá hồ sơ
            </button>
          )}
          {kind === "penalty" && (
            <>
              <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500">
                Hạn khắc phục
                <input type="date" value={han} onChange={(e) => setHan(e.target.value)} className="text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 tabular-nums focus:bg-white focus:outline-none focus:border-[#00AEEF]" />
              </label>
              <button type="button" onClick={exportDecision} disabled={exporting} className={BTN_OUTLINE}>
                {exporting ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />} Xuất phiếu
              </button>
            </>
          )}
          <button type="button" onClick={onClose} className="text-[11px] font-bold text-slate-500 px-3 py-2 rounded-lg hover:bg-slate-100 cursor-pointer">
            Đóng
          </button>
          {canEdit && (
            <button type="button" onClick={() => onEdit(row)} className={BTN_PRIMARY}>
              <Pencil size={13} /> Sửa hồ sơ
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function Stat({
  icon: Icon, label, value, sub, tone, onClick,
}: {
  icon: typeof Wallet; label: string; value: string; sub?: string; tone: "blue" | "slate" | "amber" | "emerald" | "rose"; onClick?: () => void;
}) {
  const toneCls = {
    blue: "bg-blue-50 text-[#005BAC]",
    slate: "bg-slate-100 text-slate-600",
    amber: "bg-amber-50 text-amber-500",
    emerald: "bg-emerald-50 text-emerald-600",
    rose: "bg-rose-50 text-rose-500",
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center gap-3 text-left enabled:hover:border-slate-200 enabled:cursor-pointer disabled:cursor-default"
    >
      <span className={`w-9 h-9 rounded-xl hidden sm:flex items-center justify-center shrink-0 ${toneCls}`}>
        <Icon size={17} />
      </span>
      <span className="min-w-0">
        <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider leading-tight">{label}</span>
        <span className="block text-base sm:text-lg font-extrabold text-slate-800 tabular-nums truncate">{value}</span>
        {sub && <span className="block text-[10px] font-semibold text-slate-400 truncate">{sub}</span>}
      </span>
    </button>
  );
}

function IconBtn({ title, danger, onClick, children }: { title: string; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation(); // nút trong dòng: không bật popup xem chi tiết
        onClick();
      }}
      className={`p-1.5 rounded-lg text-slate-400 transition-all cursor-pointer ${danger ? "hover:text-rose-600 hover:bg-rose-50" : "hover:text-[#005BAC] hover:bg-blue-50"}`}
    >
      {children}
    </button>
  );
}

// ─── Form tạo / sửa hồ sơ ───
const parseMoney = (t: string): number => Number(t.replace(/\D/g, "")) || 0;
const moneyText = (n: number) => (n ? formatMoney(n) : "");

function PenaltyModal({
  item, kind, canInput, canProcess, onClose, onSaved, onChanged,
}: {
  item: Penalty | null;
  kind: PenaltyKind;
  canInput: boolean;
  canProcess: boolean;
  onClose: () => void;
  onSaved: () => void;
  onChanged: () => void;
}) {
  const K = KIND_CFG[kind];
  const [inp, setInp] = useState<PenaltyInput>({
    loai_ho_so: item?.loai_ho_so ?? K.types[0],
    so_quyet_dinh: item?.so_quyet_dinh ?? "",
    qd_link: item?.qd_link ?? "",
    ngay_ban_hanh: item?.ngay_ban_hanh ?? "",
    project_code: item?.project_code ?? "",
    project_name: item?.project_name ?? "",
    contractor_id: item?.contractor_id ?? null,
    contractor_name: item?.contractor_name ?? "",
    nguoi_vi_pham: item?.nguoi_vi_pham ?? "",
    noi_dung: item?.noi_dung ?? "",
    gia_tri_phai_tru: item?.gia_tri_phai_tru ?? 0,
    nguoi_lap: item?.nguoi_lap ?? "",
    ngay_gui_khdt: item?.ngay_gui_khdt ?? "",
    vi_pham: item?.vi_pham ?? null,
  });
  // Vi phạm chọn từ Định mức (147). Hồ sơ cũ chưa có danh sách -> 1 dòng gõ tay
  // mang nội dung + số tiền đã lưu, để thêm dòng mới không làm mất nội dung cũ.
  const [lines, setLines] = useState<ViolationLine[]>(() =>
    item?.vi_pham?.length
      ? item.vi_pham
      : item?.noi_dung
        ? [{ ...EMPTY_LINE, noi_dung: item.noi_dung, thanh_tien: item.gia_tri_phai_tru }]
        : [{ ...EMPTY_LINE }]
  );
  // Đổi vi phạm -> ghép lại Nội dung + cộng lại Giá trị phải khấu trừ (vẫn sửa tay ô tổng được).
  const changeLines = (next: ViolationLine[]) => {
    setLines(next);
    const c = composeViolations(next);
    setInp((s) => ({ ...s, noi_dung: c.noi_dung, gia_tri_phai_tru: c.total, vi_pham: c.lines }));
  };
  const [out, setOut] = useState<PenaltyOutput>({
    ngay_tiep_nhan: item?.ngay_tiep_nhan ?? "",
    dot_thanh_toan: item?.dot_thanh_toan ?? "",
    gia_tri_da_tru: item?.gia_tri_da_tru ?? 0,
    ngay_khau_tru: item?.ngay_khau_tru ?? "",
    so_chung_tu: item?.so_chung_tu ?? "",
    nguoi_nhap: item?.nguoi_nhap ?? "",
    ghi_chu: item?.ghi_chu ?? "",
    ct_link: item?.ct_link ?? "",
  });
  // Tệp đã lưu + tệp vừa chọn (tải lên khi bấm Lưu) — riêng cho Số QĐ và Số chứng từ.
  const [files, setFiles] = useState<Record<PenaltyDoc, { path: string | null; name: string | null }>>({
    qd: { path: item?.qd_file_path ?? null, name: item?.qd_file_name ?? null },
    ct: { path: item?.ct_file_path ?? null, name: item?.ct_file_name ?? null },
  });
  const [pending, setPending] = useState<Record<PenaltyDoc, File | null>>({ qd: null, ct: null });
  const [partners, setPartners] = useState<SharedPartner[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const savingRef = useRef(false);

  useEffect(() => {
    let alive = true;
    fetchSharedPartners().then((p) => {
      if (!alive) return;
      // Ưu tiên nhà thầu phụ; danh mục chưa phân loại thì hiện hết.
      const ntp = p.filter((x) => x.party_type === "nha_thau_phu");
      setPartners(ntp.length ? ntp : p);
    });
    fetchProjectCatalog().then((c) => alive && setProjects(c.projects));
    return () => {
      alive = false;
    };
  }, []);

  const setI = <K extends keyof PenaltyInput>(k: K, v: PenaltyInput[K]) => setInp((p) => ({ ...p, [k]: v }));
  const setO = <K extends keyof PenaltyOutput>(k: K, v: PenaltyOutput[K]) => setOut((p) => ({ ...p, [k]: v }));
  const conLai = inp.gia_tri_phai_tru - out.gia_tri_da_tru;
  const status = penaltyStatus({ gia_tri_con_lai: conLai, gia_tri_da_tru: out.gia_tri_da_tru });

  async function save() {
    if (savingRef.current) return;
    if (canInput) {
      if (!inp.contractor_name.trim()) return setErr(`Chọn ${K.contractor}.`);
      if (!(inp.gia_tri_phai_tru > 0)) return setErr("Nhập Giá trị phải khấu trừ.");
      if (inp.qd_link?.trim() && !/^https?:\/\//i.test(inp.qd_link.trim())) return setErr("Link quyết định phải bắt đầu bằng http:// hoặc https://");
    }
    if (canProcess && out.ct_link?.trim() && !/^https?:\/\//i.test(out.ct_link.trim())) return setErr("Link chứng từ phải bắt đầu bằng http:// hoặc https://");
    if (canProcess && out.gia_tri_da_tru > inp.gia_tri_phai_tru) return setErr("Giá trị đã khấu trừ không được lớn hơn giá trị phải khấu trừ.");
    savingRef.current = true;
    setSaving(true);
    setErr("");
    let id = item?.id ?? null;
    let e: string | null;
    if (id) {
      e = await updatePenalty(id, canInput ? inp : null, canProcess ? out : null);
    } else {
      const r = await createPenalty(inp, canProcess ? out : null, kind);
      e = r.error;
      id = r.id;
    }
    // Tệp chọn sẵn: tải lên SAU khi có id hồ sơ -> ghi CSDL -> xoá tệp cũ.
    for (const kind of ["qd", "ct"] as PenaltyDoc[]) {
      const f = pending[kind];
      if (e || !id || !f) continue;
      try {
        const up = await uploadPenaltyFile(id, f, kind);
        const er = await setPenaltyFile(id, up.path, up.name, kind);
        if (er) {
          await removePenaltyFile(up.path);
          e = `Đã lưu hồ sơ nhưng chưa gắn được tệp ${DOC_LABEL[kind]}: ${er}`;
        } else {
          const old = files[kind].path;
          if (old) await removePenaltyFile(old);
          setFiles((s) => ({ ...s, [kind]: { path: up.path, name: up.name } }));
          setPending((s) => ({ ...s, [kind]: null }));
        }
      } catch (x) {
        e = `Đã lưu hồ sơ nhưng chưa tải được tệp ${DOC_LABEL[kind]}: ${x instanceof Error ? x.message : String(x)}`;
      }
    }
    savingRef.current = false;
    setSaving(false);
    if (e) {
      if (id && !item) onChanged();
      return setErr(e);
    }
    onSaved();
  }

  async function removeFile(kind: PenaltyDoc) {
    const path = files[kind].path;
    if (!item || !path || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const e = await setPenaltyFile(item.id, null, null, kind);
    if (!e) {
      await removePenaltyFile(path);
      setFiles((s) => ({ ...s, [kind]: { path: null, name: null } }));
      onChanged();
    } else setErr(e);
    savingRef.current = false;
    setSaving(false);
  }

  const inputCls =
    "w-full text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 focus:bg-white focus:outline-none focus:border-[#00AEEF] disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-not-allowed";
  const lbl = "text-[10px] font-bold text-slate-500";
  const projectValue = inp.project_code || "";
  const projectKnown = projects.some((p) => p.code === projectValue);

  return createPortal(
    <div className="fixed inset-0 z-[80] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl p-6 space-y-4 animate-in zoom-in-95 duration-150 max-h-[92vh] overflow-y-auto"
      >
        <div className="flex items-center gap-2">
          <h2 className="font-heading font-extrabold text-sm text-slate-800 flex-1">
            {item ? <>Hồ sơ <span className="font-mono text-[#005BAC]">{item.ma_ho_so}</span></> : K.modalTitle}
          </h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-rose-500 cursor-pointer" aria-label="Đóng">
            <X size={18} />
          </button>
        </div>

        {/* ── P.ATLĐ ── */}
        <section className="rounded-xl border border-blue-100 bg-blue-50/70 p-4 space-y-3">
          <p className="text-[11px] font-extrabold text-[#005BAC] uppercase tracking-wider">
            P.ATLĐ nhập — thông tin đầu vào {!canInput && <span className="normal-case font-semibold text-slate-400">(chỉ xem)</span>}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block space-y-1">
              <span className={lbl}>Loại hồ sơ</span>
              <select value={inp.loai_ho_so} disabled={!canInput} onChange={(e) => setI("loai_ho_so", e.target.value)} className={inputCls}>
                {K.types.map((t) => <option key={t} value={t}>{t}</option>)}
                {!K.types.includes(inp.loai_ho_so) && <option value={inp.loai_ho_so}>{inp.loai_ho_so}</option>}
              </select>
            </label>
            <label className="block space-y-1">
              <span className={lbl}>{kind === "ppe" ? "Số phiếu cấp phát" : "Số quyết định / Phiếu cấp phát"}</span>
              <input value={inp.so_quyet_dinh ?? ""} disabled={!canInput} onChange={(e) => setI("so_quyet_dinh", e.target.value)} placeholder="VD 52/026/QĐ/Lodeza EOP" className={inputCls} />
            </label>
            <label className="block space-y-1">
              <span className={lbl}>Ngày ban hành</span>
              <input type="date" value={inp.ngay_ban_hanh ?? ""} disabled={!canInput} onChange={(e) => setI("ngay_ban_hanh", e.target.value)} className={`${inputCls} tabular-nums`} />
            </label>

            <DocAttach
              label="Tệp quyết định (ảnh / PDF ≤ 2MB) hoặc link"
              canEdit={canInput}
              saved={files.qd}
              pending={pending.qd}
              link={inp.qd_link ?? ""}
              busy={saving}
              onPick={(f) => {
                setErr("");
                setPending((s) => ({ ...s, qd: f }));
              }}
              onUnpick={() => setPending((s) => ({ ...s, qd: null }))}
              onRemoveSaved={() => removeFile("qd")}
              onLink={(v) => setI("qd_link", v)}
              onError={setErr}
            />

            <label className="block space-y-1 sm:col-span-3">
              <span className={lbl}>Dự án (danh mục dự án — Cài đặt hệ thống)</span>
              <select
                value={projectValue}
                disabled={!canInput}
                onChange={(e) => {
                  const p = projects.find((x) => x.code === e.target.value);
                  setInp((s) => ({ ...s, project_code: p?.code ?? "", project_name: p?.name ?? "" }));
                }}
                className={inputCls}
              >
                <option value="">— Chọn dự án —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.code}>{p.code} — {p.name}</option>
                ))}
                {projectValue && !projectKnown && <option value={projectValue}>{projectValue} — {inp.project_name}</option>}
              </select>
              {projects.length === 0 && <span className="block text-[10px] text-amber-600">Danh mục dự án đang trống — Admin thêm ở Cài đặt › Danh mục công việc.</span>}
            </label>

            <div className="sm:col-span-3 space-y-1">
              <span className={lbl}>{K.contractor} * (danh mục đối tác — Hồ sơ trình ký)</span>
              {canInput ? (
                <AtldPartnerPicker
                  partners={partners}
                  value={inp.contractor_name}
                  onChange={(name) => {
                    const p = partners.find((x) => foldVi(x.name) === foldVi(name));
                    setInp((s) => ({ ...s, contractor_name: name, contractor_id: p?.id ?? null }));
                  }}
                  placeholder={K.contractorPh}
                />
              ) : (
                <div className={inputCls + " bg-slate-100"}>{inp.contractor_name || "—"}</div>
              )}
            </div>

            <label className="sm:col-span-3 block space-y-1">
              <span className={lbl}>{K.person}</span>
              <input
                value={inp.nguoi_vi_pham ?? ""}
                disabled={!canInput}
                onChange={(e) => setI("nguoi_vi_pham", e.target.value)}
                placeholder={K.personPh}
                className={inputCls}
              />
            </label>

            <div className="space-y-1 sm:col-span-3">
              <span className={lbl}>{K.content}</span>
              {kind === "penalty" ? (
                <AtldViolationLines lines={lines} onChange={changeLines} disabled={!canInput} inputCls={inputCls} />
              ) : (
                <textarea rows={4} value={inp.noi_dung ?? ""} disabled={!canInput} onChange={(e) => setI("noi_dung", e.target.value)} className={inputCls} />
              )}
            </div>

            {/* 3 ô cùng hàng cao bằng nhau: ô Người lập đã chọn người cao 2 dòng -> 2 ô kia giãn theo. */}
            <label className="flex flex-col gap-1">
              <span className={lbl}>Giá trị khấu trừ (đ) *</span>
              <input inputMode="numeric" value={moneyText(inp.gia_tri_phai_tru)} disabled={!canInput} onChange={(e) => setI("gia_tri_phai_tru", parseMoney(e.target.value))} placeholder="0" className={`${inputCls} flex-1 tabular-nums text-right`} />
            </label>
            <div className="flex flex-col gap-1">
              <span className={lbl}>Người lập</span>
              {canInput ? (
                <AtldPersonPicker bdh="" value={inp.nguoi_lap ?? ""} onChange={(n) => setI("nguoi_lap", n)} />
              ) : (
                <div className={inputCls + " bg-slate-100"}>{inp.nguoi_lap || "—"}</div>
              )}
            </div>
            <label className="flex flex-col gap-1">
              <span className={lbl}>Ngày gửi thông tin cho KHĐT</span>
              <input type="date" value={inp.ngay_gui_khdt ?? ""} disabled={!canInput} onChange={(e) => setI("ngay_gui_khdt", e.target.value)} className={`${inputCls} flex-1 tabular-nums`} />
            </label>
          </div>
        </section>

        {/* ── P.KHĐT ── */}
        <section className="rounded-xl border border-orange-100 bg-orange-50/40 p-4 space-y-3">
          <p className="text-[11px] font-extrabold text-orange-700 uppercase tracking-wider">
            P.KHĐT nhập — thông tin đầu ra {!canProcess && <span className="normal-case font-semibold text-slate-400">(chỉ xem)</span>}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block space-y-1">
              <span className={lbl}>Ngày tiếp nhận</span>
              <input type="date" value={out.ngay_tiep_nhan ?? ""} disabled={!canProcess} onChange={(e) => setO("ngay_tiep_nhan", e.target.value)} className={`${inputCls} tabular-nums`} />
            </label>
            <label className="block space-y-1">
              <span className={lbl}>Đợt thanh toán</span>
              <input value={out.dot_thanh_toan ?? ""} disabled={!canProcess} onChange={(e) => setO("dot_thanh_toan", e.target.value)} placeholder="VD HSTT Đợt 2" className={inputCls} />
            </label>
            <label className="block space-y-1">
              <span className={lbl}>Giá trị đã khấu trừ (đ)</span>
              <input inputMode="numeric" value={moneyText(out.gia_tri_da_tru)} disabled={!canProcess} onChange={(e) => setO("gia_tri_da_tru", parseMoney(e.target.value))} placeholder="0" className={`${inputCls} tabular-nums text-right`} />
            </label>
            <label className="block space-y-1">
              <span className={lbl}>Ngày khấu trừ</span>
              <input type="date" value={out.ngay_khau_tru ?? ""} disabled={!canProcess} onChange={(e) => setO("ngay_khau_tru", e.target.value)} className={`${inputCls} tabular-nums`} />
            </label>
            <label className="block space-y-1">
              <span className={lbl}>Số chứng từ</span>
              <input value={out.so_chung_tu ?? ""} disabled={!canProcess} onChange={(e) => setO("so_chung_tu", e.target.value)} className={inputCls} />
            </label>
            <div className="space-y-1">
              <span className={lbl}>Người nhập</span>
              {canProcess ? (
                <AtldPersonPicker bdh="" value={out.nguoi_nhap ?? ""} onChange={(n) => setO("nguoi_nhap", n)} />
              ) : (
                <div className={inputCls + " bg-slate-100"}>{out.nguoi_nhap || "—"}</div>
              )}
            </div>
            <DocAttach
              label="Tệp chứng từ (ảnh / PDF ≤ 2MB) hoặc link"
              canEdit={canProcess}
              saved={files.ct}
              pending={pending.ct}
              link={out.ct_link ?? ""}
              busy={saving}
              onPick={(f) => {
                setErr("");
                setPending((s) => ({ ...s, ct: f }));
              }}
              onUnpick={() => setPending((s) => ({ ...s, ct: null }))}
              onRemoveSaved={() => removeFile("ct")}
              onLink={(v) => setO("ct_link", v)}
              onError={setErr}
            />
            <label className="block space-y-1 sm:col-span-3">
              <span className={lbl}>Ghi chú (KHĐT)</span>
              <input value={out.ghi_chu ?? ""} disabled={!canProcess} onChange={(e) => setO("ghi_chu", e.target.value)} className={inputCls} />
            </label>
          </div>
        </section>

        {/* ── Tự tính ── */}
        <section className="rounded-xl border border-emerald-100 bg-emerald-50/40 px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
          <span className="text-[11px] font-extrabold text-emerald-700 uppercase tracking-wider">Tự tính</span>
          <span>
            Giá trị còn lại: <b className={`tabular-nums ${conLai > 0 ? "text-rose-600" : "text-emerald-600"}`}>{money(Math.max(0, conLai))}</b>
          </span>
          <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${PENALTY_STATUS_META[status].cls}`}>{PENALTY_STATUS_META[status].label}</span>
        </section>

        {err && (
          <p className="flex items-start gap-1.5 text-[11px] font-semibold text-rose-500">
            <AlertCircle size={13} className="mt-0.5 shrink-0" /> {err}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="text-[11px] font-bold text-slate-500 px-3 py-2 rounded-lg hover:bg-slate-100 cursor-pointer">
            Huỷ
          </button>
          {(canInput || canProcess) && (
            <button type="button" onClick={save} disabled={saving} className={BTN_PRIMARY}>
              {saving && <Loader2 size={13} className="animate-spin" />} {item ? "Lưu" : "Tạo hồ sơ"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// Khối đính kèm dùng chung cho Số QĐ (P.ATLĐ) và Số chứng từ (P.KHĐT): tệp đã lưu
// (gỡ được), tệp vừa chọn (tải lên khi bấm Lưu), ô dán link.
function DocAttach({
  label, canEdit, saved, pending, link, busy, onPick, onUnpick, onRemoveSaved, onLink, onError,
}: {
  label: string;
  canEdit: boolean;
  saved: { path: string | null; name: string | null };
  pending: File | null;
  link: string;
  busy: boolean;
  onPick: (f: File) => void;
  onUnpick: () => void;
  onRemoveSaved: () => void;
  onLink: (v: string) => void;
  onError: (m: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="sm:col-span-3 space-y-1">
      <span className="text-[10px] font-bold text-slate-500">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        {saved.path && (
          <span className="inline-flex items-center gap-1.5 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-[#005BAC] max-w-[260px]">
            <FileText size={12} className="shrink-0" /> <span className="truncate">{saved.name || "Tệp đính kèm"}</span>
            {canEdit && (
              <button type="button" onClick={onRemoveSaved} disabled={busy} className="text-slate-300 hover:text-rose-500 cursor-pointer" aria-label="Gỡ tệp">
                <X size={12} />
              </button>
            )}
          </span>
        )}
        {pending && (
          <span className="inline-flex items-center gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-amber-700 max-w-[260px]">
            <Upload size={12} className="shrink-0" /> <span className="truncate">{pending.name}</span> (lưu mới tải lên)
            <button type="button" onClick={onUnpick} className="text-amber-400 hover:text-rose-500 cursor-pointer" aria-label="Bỏ tệp">
              <X size={12} />
            </button>
          </span>
        )}
        {canEdit && (
          <>
            <input
              ref={ref}
              type="file"
              accept="application/pdf,image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                if (f.size > 2 * 1024 * 1024) return onError(`"${f.name}" vượt 2MB — tải lên Drive rồi dán link.`);
                onPick(f);
              }}
            />
            <button type="button" onClick={() => ref.current?.click()} className={BTN_OUTLINE}>
              <Upload size={13} /> {saved.path ? "Thay tệp" : "Chọn tệp"}
            </button>
          </>
        )}
        <div className="flex-1 min-w-[220px] flex items-center gap-2 px-3 h-9 rounded-xl bg-white border border-slate-200 focus-within:border-[#00AEEF]">
          <Link2 size={13} className="text-slate-400 shrink-0" />
          <input
            value={link}
            disabled={!canEdit}
            onChange={(e) => onLink(e.target.value)}
            placeholder="https://drive.google.com/…"
            className="flex-1 min-w-0 bg-transparent text-xs font-semibold text-slate-700 placeholder:text-slate-400 focus:outline-none disabled:text-slate-500"
          />
          {link && /^https?:\/\//i.test(link) && (
            <a href={link} target="_blank" rel="noopener noreferrer" className="text-[#005BAC]" title="Mở link">
              <ExternalLink size={13} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
