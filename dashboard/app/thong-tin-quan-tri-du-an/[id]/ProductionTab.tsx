"use client";

// Tab C. Sản lượng (M6, P3) — nhật ký là NGUỒN GỐC mọi lũy kế:
// • CHT nhập nhật ký NGÀY (lý trình → hạng mục → nhà thầu → KL, thời tiết, nhân
//   lực, máy, ảnh ≤ 2MB). Văn phòng BĐH nhập 1 dòng TỔNG TUẦN, ghi vào Chủ Nhật.
// • Luồng: Nháp → Chờ QS duyệt → Đã duyệt / Trả lại. Chỉ dòng ĐÃ DUYỆT vào lũy kế.
// • % hoàn thành theo tỷ trọng hạng mục (8.3) — không cần quyền tiền.
// • Sản lượng theo kỳ ngày / tuần / tháng: số tiền chỉ hiện với người có quyền
//   tài chính (view pc_v_progress_value trả NULL cho người khác).

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useConfirmBox } from "@/components/ConfirmDialog";
import TaskFilePreviewModal from "@/components/TaskFilePreviewModal";
import { uploadLogPhoto, resolveLogPhotoUrl, removeLogPhotos } from "@/lib/projectLogPhotos";
import {
  LOG_STATUS,
  formatDate,
  formatKm,
  formatMoneyShort,
  heatCls,
  pct,
  pcDelete,
  pcErrorMessage,
  pcUpdate,
  periodKey,
  periodLabel,
  todayVN,
  weekEnd,
  weekStart,
  weightedCompletion,
  type LogPhoto,
  type PcAccess,
  type PcContract,
  type PcProgressLog,
  type PcScope,
  type PcSegment,
  type PcSegmentWbs,
  type PcValueRow,
  type PcWbsItem,
  type Period,
  fetchAllRows,
} from "@/lib/projectControl";
import { Card, Field, TextInput, Select, PrimaryButton, ErrorLine, Modal } from "./ui";
import DailyReportModal from "./DailyReportModal";
import { Pencil, Trash2, Loader2, Check, Undo2, Send, Camera, ImageIcon, X, CalendarDays, CalendarRange, ClipboardList } from "lucide-react";

const WEATHER = ["Nắng", "Âm u", "Mưa nhỏ", "Mưa lớn"];

type Ctx = {
  segments: PcSegment[];
  catalog: PcWbsItem[];
  wbs: PcSegmentWbs[];
  contracts: PcContract[];
  scopes: PcScope[];
};

export default function ProductionTab({ projectId, email, access }: { projectId: string; email: string; access: PcAccess }) {
  const { ask, confirmNode } = useConfirmBox();
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [ctx, setCtx] = useState<Ctx>({ segments: [], catalog: [], wbs: [], contracts: [], scopes: [] });
  const [logs, setLogs] = useState<PcProgressLog[]>([]);
  const [values, setValues] = useState<PcValueRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [period, setPeriod] = useState<Period>("week");
  const [editing, setEditing] = useState<PcProgressLog | { type: "DAY" | "WEEK" } | null>(null);
  const [rejecting, setRejecting] = useState<PcProgressLog | null>(null);
  const [preview, setPreview] = useState<{ name: string; url: string } | null>(null);
  const [dailyOpen, setDailyOpen] = useState(false);

  const load = useCallback(async () => {
    const [s, c, co, l, v] = await Promise.all([
      supabase.from("pc_segments").select("*").eq("project_id", projectId).order("km_start_m"),
      supabase.from("pc_wbs_items").select("*").order("sort_order"),
      supabase.from("pc_contracts").select("*").eq("project_id", projectId),
      supabase.from("pc_progress_logs").select("*").eq("project_id", projectId).order("log_date", { ascending: false }).limit(500),
      fetchAllRows<PcValueRow>((a, b) => supabase.from("pc_v_progress_value").select("*").eq("project_id", projectId).order("id").range(a, b)),
    ]);
    const firstErr = [s, l, v].find((r) => r.error)?.error;
    setErr(firstErr ? pcErrorMessage(firstErr) : null);
    const segments = (s.data as PcSegment[]) || [];
    const contracts = (co.data as PcContract[]) || [];
    const [w, sc] = await Promise.all([
      segments.length ? supabase.from("pc_segment_wbs").select("*").in("segment_id", segments.map((x) => x.id)) : Promise.resolve({ data: [] }),
      contracts.length ? supabase.from("pc_contract_scopes").select("*").in("contract_id", contracts.map((x) => x.id)) : Promise.resolve({ data: [] }),
    ]);
    setCtx({
      segments,
      catalog: (c.data as PcWbsItem[]) || [],
      wbs: (w.data as PcSegmentWbs[]) || [],
      contracts,
      scopes: (sc.data as PcScope[]) || [],
    });
    setLogs(((l.data as PcProgressLog[]) || []).map((x) => ({ ...x, photos: Array.isArray(x.photos) ? x.photos : [] })));
    setValues((v.data as PcValueRow[]) || []);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const swById = useMemo(() => new Map(ctx.wbs.map((w) => [w.id, w])), [ctx.wbs]);
  const segById = useMemo(() => new Map(ctx.segments.map((s) => [s.id, s])), [ctx.segments]);
  const itemById = useMemo(() => new Map(ctx.catalog.map((c) => [c.id, c])), [ctx.catalog]);
  const conById = useMemo(() => new Map(ctx.contracts.map((c) => [c.id, c])), [ctx.contracts]);

  // KL lũy kế đã duyệt theo từng hạng mục-lý trình.
  const qtyBySw = useMemo(() => {
    const m = new Map<string, number>();
    values.forEach((r) => m.set(r.segment_wbs_id, (m.get(r.segment_wbs_id) || 0) + Number(r.qty)));
    return m;
  }, [values]);

  const segCompletion = (segId: string) => weightedCompletion(ctx.wbs.filter((w) => w.segment_id === segId), qtyBySw);

  // %HT dự án = trung bình %HT lý trình, trọng số theo chiều dài.
  const projectCompletion = useMemo(() => {
    let wsum = 0;
    let acc = 0;
    ctx.segments.forEach((s) => {
      const v = weightedCompletion(ctx.wbs.filter((w) => w.segment_id === s.id), qtyBySw);
      if (v === null) return;
      const len = Number(s.km_end_m) - Number(s.km_start_m);
      wsum += len;
      acc += v * len;
    });
    return wsum > 0 ? acc / wsum : null;
  }, [ctx, qtyBySw]);

  const canFin = access.can_view_finance;
  const pending = logs.filter((l) => l.status === "SUBMITTED");
  const shown = statusFilter === "ALL" ? logs : logs.filter((l) => l.status === statusFilter);

  // Sản lượng theo kỳ (chỉ nhật ký đã duyệt).
  const byPeriod = useMemo(() => {
    const m = new Map<string, { n: number; a: number; b: number }>();
    values.forEach((r) => {
      const k = periodKey(r.log_date, period);
      const cur = m.get(k) || { n: 0, a: 0, b: 0 };
      cur.n += 1;
      cur.a += Number(r.value_a || 0);
      cur.b += Number(r.value_b || 0);
      m.set(k, cur);
    });
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 24);
  }, [values, period]);

  const isMine = (l: PcProgressLog) => (l.created_by || "").toLowerCase() === email.toLowerCase();
  const canEditLog = (l: PcProgressLog) =>
    (access.can_approve_log || (access.can_log && isMine(l))) && (l.status !== "APPROVED" || access.can_approve_log);

  async function setStatus(l: PcProgressLog, status: string, extra: Record<string, unknown> = {}) {
    const e = await pcUpdate("pc_progress_logs", { id: l.id }, { status, ...extra });
    if (e) setErr(e);
    load();
  }

  function removeLog(l: PcProgressLog) {
    ask({
      title: "Xoá nhật ký này?",
      message: l.photos.length ? `Kèm ${l.photos.length} ảnh hiện trường.` : undefined,
      onConfirm: async () => {
        const e = await pcDelete("pc_progress_logs", { id: l.id });
        if (e) return setErr(e);
        removeLogPhotos(l.photos.map((p) => p.path)); // CSDL đã xoá xong mới xoá ảnh
        load();
      },
    });
  }

  async function openPhoto(p: LogPhoto) {
    const url = await resolveLogPhotoUrl(p.path);
    if (url) setPreview({ name: p.name, url });
    else setErr("Không mở được ảnh — có thể đã bị xoá.");
  }

  if (loading)
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="animate-spin text-[#005BAC]" size={26} />
      </div>
    );

  return (
    <div className="space-y-4">
      <ErrorLine msg={err} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat
          label="% hoàn thành toàn dự án"
          value={pct(projectCompletion)}
          cls={heatCls(projectCompletion)}
          hint="Bình quân các lý trình theo chiều dài"
        />
        <Stat label="Chờ QS duyệt" value={String(pending.length)} cls={pending.length ? "bg-amber-100 text-amber-800" : ""} />
        <Stat label="Nhật ký đã duyệt" value={String(values.length)} cls="" />
        <Stat
          label="Sản lượng lũy kế (A-B)"
          value={canFin ? formatMoneyShort(values.reduce((a, r) => a + Number(r.value_a || 0), 0)) : "🔒"}
          cls=""
        />
      </div>

      {/* ─── Nhật ký ─── */}
      <Card
        title="Nhật ký sản lượng"
        action={
          access.can_log ? (
            <div className="flex gap-2">
              <PrimaryButton onClick={() => setEditing({ type: "DAY" })}>
                <CalendarDays size={13} /> Nhập nhật ký ngày
              </PrimaryButton>
              <PrimaryButton onClick={() => setEditing({ type: "WEEK" })}>
                <CalendarRange size={13} /> Nhập tổng tuần
              </PrimaryButton>
              {/* Phiếu báo cáo ngày theo mẫu công ty (thời tiết sáng/chiều, nhân sự & máy theo đơn vị…). */}
              <PrimaryButton onClick={() => setDailyOpen(true)}>
                <ClipboardList size={13} /> Báo cáo ngày
              </PrimaryButton>
            </div>
          ) : null
        }
      >
        <div className="flex flex-wrap gap-1.5 mb-3">
          {[["ALL", "Tất cả"], ["SUBMITTED", `Chờ duyệt (${pending.length})`], ["DRAFT", "Nháp"], ["APPROVED", "Đã duyệt"], ["REJECTED", "Trả lại"]].map(
            ([k, label]) => (
              <button
                key={k}
                onClick={() => setStatusFilter(k)}
                className={`text-[11px] font-bold px-3 py-1.5 rounded-full border ${
                  statusFilter === k ? "bg-[#005BAC] text-white border-transparent" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                }`}
              >
                {label}
              </button>
            )
          )}
        </div>
        {shown.length === 0 ? (
          <p className="text-xs italic text-slate-400 text-center py-6">Chưa có nhật ký.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] table-fixed text-[11px]">
              <colgroup>
                <col className="w-[150px]" />
                <col className="w-[70px]" />
                <col />
                <col className="w-[300px]" />
                <col className="w-[120px]" />
                <col className="w-[60px]" />
                <col className="w-[120px]" />
                <col className="w-[110px]" />
                <col className="w-[190px]" />
              </colgroup>
              <thead>
                <tr className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 text-left">
                  <th className="py-1.5 pr-2">Ngày</th>
                  <th className="px-2">Lý trình</th>
                  <th className="px-2">Hạng mục</th>
                  <th className="px-2">Nhà thầu</th>
                  <th className="px-2 text-right">Khối lượng</th>
                  <th className="px-2 text-center">Ảnh</th>
                  <th className="px-2">Người lập</th>
                  <th className="px-2">Trạng thái</th>
                  <th className="px-2" />
                </tr>
              </thead>
              <tbody>
                {shown.map((l) => {
                  const sw = swById.get(l.segment_wbs_id);
                  const seg = sw ? segById.get(sw.segment_id) : null;
                  const it = sw ? itemById.get(sw.wbs_item_id) : null;
                  const con = l.contract_id ? conById.get(l.contract_id) : null;
                  const st = LOG_STATUS[l.status];
                  return (
                    <tr key={l.id} className="border-t border-slate-100 align-top">
                      <td className="py-2 pr-2">
                        <span className="font-semibold text-slate-700">
                          {l.entry_type === "WEEK" ? `Tuần ${formatDate(weekStart(l.log_date))}–${formatDate(l.log_date).slice(0, 5)}` : formatDate(l.log_date)}
                        </span>
                        {(l.weather || l.manpower != null || l.equipment_count != null) && (
                          <span className="block text-[10px] text-slate-400">
                            {[l.weather, l.manpower != null ? `${l.manpower} người` : "", l.equipment_count != null ? `${l.equipment_count} máy` : ""]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 font-bold text-slate-700">{seg?.code || "?"}</td>
                      <td className="px-2 py-2 text-slate-600 truncate" title={it ? `${it.code} ${it.name}` : ""}>
                        {it ? `${it.code} ${it.name}` : "?"}
                        {l.note && <span className="block text-[10px] text-slate-400 truncate">{l.note}</span>}
                        {l.status === "REJECTED" && l.reject_reason && (
                          <span className="block text-[10px] text-rose-500 truncate">Lý do trả: {l.reject_reason}</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-slate-600" title={con?.partner_name || ""}>
                        <span className="line-clamp-2 break-words">{con?.partner_name || "—"}</span>
                      </td>
                      <td className="px-2 py-2 text-right font-mono font-semibold text-slate-700">
                        {Number(l.qty).toLocaleString("vi-VN")} {sw?.unit || ""}
                      </td>
                      <td className="px-2 py-2 text-center">
                        {l.photos.length > 0 && (
                          <button onClick={() => openPhoto(l.photos[0])} className="inline-flex items-center gap-0.5 text-[#005BAC] font-bold" title="Xem ảnh">
                            <ImageIcon size={12} /> {l.photos.length}
                          </button>
                        )}
                      </td>
                      <td className="px-2 py-2 text-slate-500 truncate" title={l.created_by || ""}>
                        {(l.created_by || "").split("@")[0]}
                      </td>
                      <td className="px-2 py-2">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center justify-end gap-1.5 flex-wrap">
                          {access.can_approve_log && l.status === "SUBMITTED" && (
                            <>
                              <button
                                onClick={() => setStatus(l, "APPROVED", { reject_reason: null })}
                                className="flex items-center gap-1 text-[10px] font-bold text-white bg-emerald-500 hover:bg-emerald-600 px-2 py-1 rounded-md"
                              >
                                <Check size={11} /> Duyệt
                              </button>
                              <button
                                onClick={() => setRejecting(l)}
                                className="flex items-center gap-1 text-[10px] font-bold text-rose-600 bg-rose-50 hover:bg-rose-100 px-2 py-1 rounded-md"
                              >
                                <Undo2 size={11} /> Trả lại
                              </button>
                            </>
                          )}
                          {isMine(l) && (l.status === "DRAFT" || l.status === "REJECTED") && (
                            <button
                              onClick={() => setStatus(l, "SUBMITTED")}
                              className="flex items-center gap-1 text-[10px] font-bold text-[#005BAC] bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded-md"
                            >
                              <Send size={11} /> Gửi duyệt
                            </button>
                          )}
                          {canEditLog(l) && (
                            <button onClick={() => setEditing(l)} className="text-slate-300 hover:text-[#005BAC]" title="Sửa">
                              <Pencil size={12} />
                            </button>
                          )}
                          {canEditLog(l) && (
                            <button onClick={() => removeLog(l)} className="text-slate-300 hover:text-rose-500" title="Xoá">
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ─── Lũy kế theo lý trình ─── */}
      <Card title="Lũy kế khối lượng theo lý trình (nhật ký đã duyệt)">
        {ctx.segments.length === 0 ? (
          <p className="text-xs italic text-slate-400">Chưa có lý trình.</p>
        ) : (
          <div className="space-y-2.5">
            {ctx.segments.map((s) => {
              const v = segCompletion(s.id);
              const rows = ctx.wbs.filter((w) => w.segment_id === s.id && w.applicable);
              return (
                <div key={s.id} className="flex items-start gap-3">
                  <span className="text-xs font-extrabold text-slate-800 w-14 shrink-0 pt-0.5">{s.code}</span>
                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded w-16 text-center shrink-0 ${heatCls(v)}`}>{pct(v)}</span>
                  <div className="flex flex-wrap gap-1.5 flex-1">
                    {rows.map((w) => {
                      const it = itemById.get(w.wbs_item_id);
                      const done = qtyBySw.get(w.id) || 0;
                      const b = Number(w.budget_qty || 0);
                      const r = b > 0 ? Math.min(1, done / b) : null;
                      return (
                        <span key={w.id} className={`text-[10px] font-semibold px-2 py-0.5 rounded ${heatCls(r)}`} title={it?.name}>
                          {it?.code}: {done.toLocaleString("vi-VN")}/{b ? b.toLocaleString("vi-VN") : "?"} {w.unit || ""}
                        </span>
                      );
                    })}
                    {rows.length === 0 && <span className="text-[11px] italic text-slate-400">Chưa gán hạng mục</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ─── Sản lượng theo kỳ ─── */}
      <Card
        title="Sản lượng theo kỳ"
        action={
          <div className="flex gap-1">
            {(["day", "week", "month"] as Period[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`text-[11px] font-bold px-3 py-1 rounded-full border ${
                  period === p ? "bg-[#005BAC] text-white border-transparent" : "bg-white text-slate-600 border-slate-200"
                }`}
              >
                {p === "day" ? "Ngày" : p === "week" ? "Tuần" : "Tháng"}
              </button>
            ))}
          </div>
        }
      >
        {byPeriod.length === 0 ? (
          <p className="text-xs italic text-slate-400">Chưa có nhật ký đã duyệt.</p>
        ) : (
          <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full min-w-[520px] text-[11px]">
            <thead>
              <tr className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 text-left">
                <th className="py-1.5">Kỳ</th>
                <th className="px-2 text-right">Số nhật ký</th>
                {canFin && <th className="px-2 text-right">Sản lượng A-B</th>}
                {canFin && <th className="px-2 text-right">Sản lượng B-B&apos;</th>}
              </tr>
            </thead>
            <tbody>
              {byPeriod.map(([k, v]) => (
                <tr key={k} className="border-t border-slate-100">
                  <td className="py-1.5 font-semibold text-slate-700">{periodLabel(k, period)}</td>
                  <td className="px-2 text-right text-slate-600">{v.n}</td>
                  {canFin && <td className="px-2 text-right font-mono text-slate-700">{formatMoneyShort(v.a)}</td>}
                  {canFin && <td className="px-2 text-right font-mono text-slate-700">{formatMoneyShort(v.b)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {!canFin && <p className="text-[10px] text-slate-400 mt-2">Giá trị sản lượng chỉ hiện với Ban lãnh đạo / GĐDA / TC-KT.</p>}
      </Card>

      {editing && (
        <LogModal
          projectId={projectId}
          ctx={ctx}
          row={"id" in editing ? editing : null}
          type={"id" in editing ? editing.entry_type : editing.type}
          canApprove={access.can_approve_log}
          qtyBySw={qtyBySw}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {dailyOpen && <DailyReportModal projectId={projectId} onClose={() => setDailyOpen(false)} onSaved={() => setDailyOpen(false)} />}
      {rejecting && (
        <RejectModal
          onClose={() => setRejecting(null)}
          onConfirm={async (reason) => {
            const l = rejecting;
            setRejecting(null);
            await setStatus(l, "REJECTED", { reject_reason: reason || null });
          }}
        />
      )}
      {preview && (
        <TaskFilePreviewModal
          file={{ path: preview.name, name: preview.name }}
          url={preview.url}
          onClose={() => setPreview(null)}
          zClass="z-[1000]"
        />
      )}
      {confirmNode}
    </div>
  );
}

function Stat({ label, value, cls, hint }: { label: string; value: string; cls: string; hint?: string }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm px-4 py-3">
      <p className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400">{label}</p>
      <p className={`inline-block text-base font-extrabold font-mono mt-1 px-1.5 rounded ${cls || "text-slate-800"}`}>{value}</p>
      {hint && <p className="text-[10px] text-slate-400 mt-0.5">{hint}</p>}
    </div>
  );
}

function RejectModal({ onClose, onConfirm }: { onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Modal title="Trả lại nhật ký" onClose={onClose}>
      <Field label="Lý do (người lập sẽ thấy)">
        <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Khối lượng chưa khớp biên bản…" autoFocus />
      </Field>
      <div className="flex justify-end">
        <PrimaryButton onClick={() => onConfirm(reason.trim())}>Trả lại</PrimaryButton>
      </div>
    </Modal>
  );
}

function LogModal({
  projectId,
  ctx,
  row,
  type,
  canApprove,
  qtyBySw,
  onClose,
  onSaved,
}: {
  projectId: string;
  ctx: Ctx;
  row: PcProgressLog | null;
  type: "DAY" | "WEEK";
  canApprove: boolean;
  qtyBySw: Map<string, number>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initSw = row ? ctx.wbs.find((w) => w.id === row.segment_wbs_id) : null;
  const [date, setDate] = useState(row?.log_date || todayVN());
  const [segId, setSegId] = useState(initSw?.segment_id || "");
  const [swId, setSwId] = useState(row?.segment_wbs_id || "");
  const [conId, setConId] = useState(row?.contract_id || "");
  const [qty, setQty] = useState(row ? String(Number(row.qty)) : "");
  const [weather, setWeather] = useState(row?.weather || "");
  const [manpower, setManpower] = useState(row?.manpower != null ? String(row.manpower) : "");
  const [equip, setEquip] = useState(row?.equipment_count != null ? String(row.equipment_count) : "");
  const [note, setNote] = useState(row?.note || "");
  const [photos, setPhotos] = useState<LogPhoto[]>(row?.photos || []);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const itemById = new Map(ctx.catalog.map((c) => [c.id, c]));
  const swOptions = ctx.wbs
    .filter((w) => w.segment_id === segId && w.applicable)
    .sort((a, b) => (itemById.get(a.wbs_item_id)?.sort_order ?? 0) - (itemById.get(b.wbs_item_id)?.sort_order ?? 0));
  const sw = ctx.wbs.find((w) => w.id === swId);

  // Nhà thầu B-B' có phạm vi trên lý trình (đúng hạng mục hoặc cả lý trình); không có thì liệt kê mọi HĐ B-B'.
  const bb = ctx.contracts.filter((c) => c.contract_type === "B_B1");
  const scoped = bb.filter((c) =>
    ctx.scopes.some((s) => s.contract_id === c.id && s.segment_id === segId && (!s.wbs_item_id || s.wbs_item_id === sw?.wbs_item_id))
  );
  const conOptions = scoped.length ? scoped : bb;

  const effectiveDate = type === "WEEK" ? weekEnd(date) : date;
  const done = sw ? qtyBySw.get(sw.id) || 0 : 0;
  const budget = Number(sw?.budget_qty || 0);

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setErr(null);
    try {
      const added: LogPhoto[] = [];
      for (const f of Array.from(files)) added.push(await uploadLogPhoto(projectId, f));
      setPhotos((p) => [...p, ...added]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Không tải được ảnh.");
    }
    setUploading(false);
  }

  async function save(status: "DRAFT" | "SUBMITTED" | "APPROVED") {
    if (!swId) return setErr("Chọn lý trình và hạng mục.");
    const q = parseFloat(qty.replace(",", "."));
    if (!Number.isFinite(q) || q < 0) return setErr("Khối lượng không hợp lệ.");
    if (effectiveDate > todayVN() && type === "DAY") return setErr("Không nhập nhật ký cho ngày tương lai.");
    const int = (s: string) => (s.trim() ? parseInt(s, 10) : null);
    setSaving(true);
    setErr(null);
    const payload = {
      segment_wbs_id: swId,
      contract_id: conId || null,
      log_date: effectiveDate,
      entry_type: type,
      qty: q,
      weather: weather || null,
      manpower: int(manpower),
      equipment_count: int(equip),
      note: note.trim() || null,
      photos,
      status,
      reject_reason: status === "SUBMITTED" ? null : row?.reject_reason ?? null,
    };
    let e: string | null = null;
    if (row) e = await pcUpdate("pc_progress_logs", { id: row.id }, payload);
    else {
      const { error } = await supabase.from("pc_progress_logs").insert({ ...payload, project_id: projectId });
      if (error) e = pcErrorMessage(error);
    }
    setSaving(false);
    if (e) return setErr(e);
    // Ảnh đã gỡ khỏi dòng: CSDL đã thôi trỏ tới -> giờ mới xoá khỏi kho.
    if (row) {
      const kept = new Set(photos.map((p) => p.path));
      removeLogPhotos(row.photos.filter((p) => !kept.has(p.path)).map((p) => p.path));
    }
    onSaved();
  }

  return (
    <Modal title={`${row ? "Sửa" : "Nhập"} nhật ký ${type === "WEEK" ? "tổng tuần" : "ngày"}`} onClose={onClose} wide>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label={type === "WEEK" ? "Một ngày bất kỳ trong tuần" : "Ngày"}>
          <TextInput type="date" value={date} max={type === "DAY" ? todayVN() : undefined} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <div className="space-y-1">
          <span className="block text-[10px] font-bold text-slate-500">{type === "WEEK" ? "Ghi vào" : "Loại"}</span>
          <div className="text-xs font-semibold text-slate-600 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
            {type === "WEEK"
              ? `Tuần ${formatDate(weekStart(date))} – ${formatDate(weekEnd(date))} (ghi vào Chủ Nhật)`
              : "Nhật ký ngày"}
          </div>
        </div>
        <Field label="Lý trình">
          <Select
            value={segId}
            onChange={(e) => {
              setSegId(e.target.value);
              setSwId("");
              setConId("");
            }}
          >
            <option value="">— Chọn lý trình —</option>
            {ctx.segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} ({formatKm(s.km_start_m)} – {formatKm(s.km_end_m)})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Hạng mục">
          <Select value={swId} onChange={(e) => setSwId(e.target.value)} disabled={!segId}>
            <option value="">{segId && swOptions.length === 0 ? "Lý trình chưa gán hạng mục" : "— Chọn hạng mục —"}</option>
            {swOptions.map((w) => {
              const it = itemById.get(w.wbs_item_id);
              return (
                <option key={w.id} value={w.id}>
                  {it?.code} {it?.name}
                </option>
              );
            })}
          </Select>
        </Field>
        <Field label="Nhà thầu thực hiện (HĐ B-B')">
          <Select value={conId} onChange={(e) => setConId(e.target.value)}>
            <option value="">— Lodeza EOP tự làm / chưa rõ —</option>
            {conOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.partner_name} {c.contract_no ? `(${c.contract_no})` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <div className="space-y-1">
          <span className="block text-[10px] font-bold text-slate-500">Khối lượng {type === "WEEK" ? "cả tuần" : "trong ngày"}</span>
          <div className="relative">
            <TextInput value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" className="pr-14 text-right font-mono" />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold text-slate-400">{sw?.unit || ""}</span>
          </div>
          {sw && (
            <span className="block text-[10px] text-slate-400">
              Đã duyệt lũy kế {done.toLocaleString("vi-VN")} / KL HĐ {budget ? budget.toLocaleString("vi-VN") : "?"} {sw.unit || ""}
            </span>
          )}
        </div>
        <Field label="Thời tiết">
          <Select value={weather} onChange={(e) => setWeather(e.target.value)}>
            <option value="">—</option>
            {WEATHER.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nhân lực (người)">
            <TextInput value={manpower} onChange={(e) => setManpower(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Máy thi công">
            <TextInput value={equip} onChange={(e) => setEquip(e.target.value)} inputMode="numeric" />
          </Field>
        </div>
        <Field label="Ghi chú" className="md:col-span-2">
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="md:col-span-2 space-y-1.5">
          <span className="block text-[10px] font-bold text-slate-500">Ảnh hiện trường (mỗi ảnh ≤ 2MB)</span>
          <div className="flex flex-wrap items-center gap-2">
            {photos.map((p) => (
              <span key={p.path} className="flex items-center gap-1 text-[11px] font-semibold text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1">
                <ImageIcon size={11} /> <span className="max-w-[160px] truncate">{p.name}</span>
                <button onClick={() => setPhotos((xs) => xs.filter((x) => x.path !== p.path))} className="text-slate-400 hover:text-rose-500">
                  <X size={11} />
                </button>
              </span>
            ))}
            <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 bg-white hover:bg-slate-50 border border-dashed border-slate-300 rounded-lg px-2.5 py-1.5 cursor-pointer">
              {uploading ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />} Thêm ảnh
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  addPhotos(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </div>
      </div>
      <ErrorLine msg={err} />
      <div className="flex justify-end gap-2">
        <button onClick={() => save("DRAFT")} disabled={saving || uploading} className="text-[11px] font-bold text-slate-600 px-3.5 py-2 rounded-lg border border-slate-200 hover:bg-slate-50">
          Lưu nháp
        </button>
        <PrimaryButton onClick={() => save("SUBMITTED")} busy={saving} disabled={uploading}>
          <Send size={12} /> Gửi QS duyệt
        </PrimaryButton>
        {canApprove && (
          <button
            onClick={() => save("APPROVED")}
            disabled={saving || uploading}
            className="flex items-center gap-1.5 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 text-white text-[11px] font-bold px-3.5 py-2 rounded-lg"
          >
            <Check size={12} /> Lưu & duyệt
          </button>
        )}
      </div>
      <p className="text-[10px] text-slate-400 text-right">
        {type === "WEEK" && effectiveDate !== date ? `Sẽ ghi vào ngày ${formatDate(effectiveDate)}.` : ""}
      </p>
    </Modal>
  );
}

