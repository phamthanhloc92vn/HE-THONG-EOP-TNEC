"use client";

// ============================================================
// TaskKpiPanel — khối "KPI" trong modal Sửa task (app/tasks/page.tsx).
//   * Mốc nộp duyệt (do trigger migration 164 ghi — chỉ hiển thị).
//   * Task con: báo thuộc task tổng nào, trọng số bao nhiêu.
//   * Task tổng: danh sách đầu mục (task con) + tiến độ có trọng số; cấp quản
//     lý thêm đầu mục, trọng số BẮT BUỘC, tổng không quá 100%.
//   * Cấp quản lý: cờ "Tạm hoãn / huỷ — không tính KPI".
// Nằm NGOÀI <form> của modal (giống TaskCommentPanel) để nút ở đây không submit
// nhầm "Lưu thay đổi". Tự ghi DB rồi gọi onChanged() để Kanban tải lại.
// ============================================================

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { groupProgress, vnDayKey } from "@/lib/taskKpi";
import { Layers, PauseCircle, Plus, Loader2, CheckCircle2, Search } from "lucide-react";

export interface KpiPanelTask {
  id: string;
  title: string;
  assignee: string;
  priority: string;
  status: string;
  progress: number;
  due_date: string;
  project_code?: string | null;
  project_name?: string | null;
  work_group?: string | null;
  work_source?: string | null;
  submitted_at?: string | null;
  parent_id?: string | null;
  kpi_weight?: number | null;
  kpi_hold?: boolean;
  kpi_hold_reason?: string | null;
  is_group?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  planning: "Lập kế hoạch", in_progress: "Đang thực hiện", pending_approval: "Chờ phê duyệt",
  need_revision: "Cần chỉnh sửa", tracking: "Update thông tin", completed: "Đã hoàn thành",
};

// Màu nhãn trạng thái — cùng tông với màu cột Kanban (COLUMNS ở app/tasks/page.tsx).
const STATUS_BADGE: Record<string, string> = {
  planning: "bg-slate-500/15 text-slate-600 border-slate-400/30",
  in_progress: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  pending_approval: "bg-purple-500/15 text-purple-600 border-purple-500/30",
  need_revision: "bg-rose-500/15 text-rose-600 border-rose-500/30",
  tracking: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  completed: "bg-emerald-500/15 text-emerald-600 border-emerald-500/40",
};

const fmt = (iso?: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");

type Props = {
  task: KpiPanelTask;
  allTasks: KpiPanelTask[];
  employees: { name: string; department?: string | null; role?: string | null }[];
  canManage: boolean;
  onChanged: () => void;
  /** notifyAssignee của app/tasks/page.tsx — cùng luật gửi email giao việc. Trả "" nếu ổn, ngược lại là lý do lỗi. */
  notifyAssignee: (t: {
    title: string; assignee: string; priority: string;
    due_date?: string; start_date?: string; description?: string;
  }) => Promise<string>;
};

export default function TaskKpiPanel({ task, allTasks, employees, canManage, onChanged, notifyAssignee }: Props) {
  const [hold, setHold] = useState(!!task.kpi_hold);
  const [holdReason, setHoldReason] = useState(task.kpi_hold_reason || "");
  // Giá trị đã lưu — `task` là bản chụp lúc mở modal, lưu xong không tự cập nhật.
  const [savedHold, setSavedHold] = useState({ hold: !!task.kpi_hold, reason: task.kpi_hold_reason || "" });
  const [savingHold, setSavingHold] = useState(false);

  const [isGroup, setIsGroup] = useState(!!task.is_group);
  const [subTitle, setSubTitle] = useState("");
  const [subAssignee, setSubAssignee] = useState("");
  const [subDue, setSubDue] = useState(task.due_date || "");
  const [subWeight, setSubWeight] = useState("");
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState("");

  // Dropdown người làm: lọc theo tên HOẶC phòng ban, tối đa 30 dòng; bấm ra ngoài thì đóng.
  const [showPicker, setShowPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showPicker) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setShowPicker(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showPicker]);
  const q = subAssignee.trim().toLowerCase();
  const pickerList = employees
    .filter(e => !q || e.name.toLowerCase().includes(q) || (e.department || "").toLowerCase().includes(q))
    .slice(0, 30);

  const parent = task.parent_id ? allTasks.find(t => t.id === task.parent_id) : undefined;
  const children = allTasks.filter(t => t.parent_id === task.id);
  const totalWeight = children.reduce((s, c) => s + (Number(c.kpi_weight) || 0), 0);

  const saveHold = async () => {
    setSavingHold(true);
    setErr("");
    const { error } = await supabase.from("tasks")
      .update({ kpi_hold: hold, kpi_hold_reason: hold ? holdReason.trim() || null : null })
      .eq("id", task.id);
    setSavingHold(false);
    if (error) return setErr(error.message);
    setSavedHold({ hold, reason: hold ? holdReason.trim() : "" });
    onChanged();
  };

  const addSubtask = async () => {
    setErr("");
    const w = Number(subWeight);
    if (!subTitle.trim()) return setErr("Nhập tên đầu mục.");
    if (!employees.some(e => e.name === subAssignee)) return setErr("Chọn người làm từ danh sách gợi ý.");
    if (!subDue) return setErr("Đầu mục phải có deadline.");
    if (!(w > 0 && w <= 100)) return setErr("Trọng số bắt buộc, từ 1 đến 100%.");
    if (totalWeight + w > 100) return setErr(`Tổng trọng số vượt 100% (đã có ${totalWeight}%, còn ${100 - totalWeight}%).`);

    setAdding(true);
    try {
      const today = vnDayKey(new Date());
      const { error } = await supabase.from("tasks").insert({
        title: subTitle.trim(),
        assignee: subAssignee,
        // Ưu tiên theo task tổng: cả task tổng tính như MỘT task, chia theo trọng số.
        priority: task.priority,
        due_date: subDue,
        start_date: today,
        status: "planning",
        progress: 0,
        project_code: task.project_code || null,
        project_name: task.project_name || null,
        work_group: task.work_group || null,
        work_source: task.work_source || null,
        parent_id: task.id,
        kpi_weight: w,
      });
      if (error) throw error;
      if (!isGroup) {
        const { error: gErr } = await supabase.from("tasks").update({ is_group: true }).eq("id", task.id);
        if (gErr) throw gErr;
        setIsGroup(true);
      }
      // Báo email như giao việc thường. Không await: đầu mục đã nằm trong DB,
      // thư chỉ là báo kèm; lỗi gửi thư hiện ngay dưới khung.
      const mail = {
        title: subTitle.trim(), assignee: subAssignee, priority: task.priority,
        due_date: subDue, start_date: today,
        description: `Đầu mục (trọng số ${w}%) của task tổng: ${task.title}`,
      };
      void notifyAssignee(mail).then(problem => {
        if (problem) setErr(`Đã thêm đầu mục, nhưng KHÔNG gửi được email báo: ${problem}`);
      });
      setSubTitle(""); setSubAssignee(""); setSubWeight("");
      onChanged();
    } catch (e) {
      setErr((e as { message?: string })?.message || String(e));
    } finally {
      setAdding(false);
    }
  };

  const showGroupBlock = !task.parent_id && (isGroup || canManage);

  return (
    <div className="px-6 pb-4 space-y-3">
      <div className="p-3 rounded-xl border border-slate-200 bg-slate-50/60 space-y-3 text-xs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-600">
          <span className="font-bold text-slate-800">KPI</span>
          <span>Mốc nộp duyệt: <b>{task.submitted_at ? new Date(task.submitted_at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "chưa nộp"}</b></span>
          {isGroup && <span className="text-blue-700 font-semibold">Task tổng — không chấm KPI, chấm theo từng đầu mục</span>}
          {savedHold.hold && <span className="text-amber-700 font-semibold">Đang tạm hoãn — không tính KPI</span>}
        </div>

        {task.parent_id && (
          <div className="text-slate-600">
            ↳ Đầu mục của task tổng <b>{parent?.title || "(không xem được)"}</b> · trọng số <b>{task.kpi_weight ?? 0}%</b>
          </div>
        )}

        {showGroupBlock && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 font-semibold text-slate-700">
              <Layers size={13} /> Đầu mục (task con)
              {children.length > 0 && (
                <span className="text-slate-500 font-normal">
                  · {children.length} đầu mục · tiến độ{" "}
                  <span className={groupProgress(children) >= 100 ? "text-emerald-600 font-bold" : ""}>{groupProgress(children)}%</span> ·
                  <span className={totalWeight === 100 ? "" : " text-rose-600 font-semibold"}> tổng trọng số {totalWeight}%</span>
                  {totalWeight !== 100 && " (phải đủ 100%)"}
                </span>
              )}
            </div>
            {children.length > 0 && (
              <table className="w-full">
                <thead className="text-left text-[10px] text-slate-500">
                  <tr><th className="py-1">Đầu mục</th><th>Người làm</th><th>Deadline</th><th className="text-right">Trọng số</th><th className="pl-3">Trạng thái</th><th className="text-right">Tiến độ</th></tr>
                </thead>
                <tbody>
                  {children.map(c => {
                    const done = c.status === "completed";
                    const p = done ? 100 : Number(c.progress) || 0;
                    return (
                      <tr key={c.id} className={`border-t border-slate-200/70 ${done ? "bg-emerald-500/5" : ""}`}>
                        <td className={`py-1.5 font-medium ${done ? "text-emerald-600" : "text-slate-800"}`}>
                          {done && <CheckCircle2 size={12} className="inline mr-1 -mt-0.5" />}{c.title}
                        </td>
                        <td>{c.assignee}</td>
                        <td className="tabular-nums">{fmt(c.due_date)}</td>
                        <td className="text-right tabular-nums">{c.kpi_weight ?? 0}%</td>
                        <td className="pl-3">
                          <span className={`inline-block px-2 py-0.5 rounded-full border text-[10px] font-bold ${STATUS_BADGE[c.status] || STATUS_BADGE.planning}`}>
                            {STATUS_LABEL[c.status] || c.status}
                          </span>
                        </td>
                        <td className="pl-3">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-16 h-1.5 rounded-full bg-slate-200/70 overflow-hidden">
                              <div className={`h-full rounded-full ${p >= 100 ? "bg-emerald-500" : "bg-blue-500"}`} style={{ width: `${Math.min(100, p)}%` }} />
                            </div>
                            <span className={`tabular-nums font-bold ${p >= 100 ? "text-emerald-600" : ""}`}>{p}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {canManage && totalWeight < 100 && (
              <div className="grid grid-cols-[1fr_160px_130px_80px_auto] gap-2 items-center">
                <input value={subTitle} onChange={e => setSubTitle(e.target.value)} placeholder="Tên đầu mục"
                  className="px-2 py-1.5 bg-white border border-slate-200 rounded-lg outline-none" />
                {/* Ô chọn người làm — dựng y ô "Người nhận" ở form Tạo task (app/tasks/page.tsx). */}
                <div className="relative" ref={pickerRef}>
                  <div className="flex items-center gap-1.5 px-2 py-1.5 bg-white border border-slate-200 rounded-lg focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500/40">
                    <Search size={12} className="text-slate-400 shrink-0" />
                    <input value={subAssignee}
                      onChange={e => { setSubAssignee(e.target.value); setShowPicker(true); }}
                      onFocus={() => setShowPicker(true)}
                      placeholder="Người làm"
                      className="flex-1 min-w-0 outline-none bg-transparent font-semibold placeholder:font-normal" />
                  </div>
                  {showPicker && (
                    <div className="absolute left-0 top-full mt-1 w-72 bg-white border border-slate-200 rounded-xl shadow-premium z-20 max-h-56 overflow-y-auto">
                      {pickerList.length === 0 ? (
                        <p className="text-center text-slate-400 text-[11px] italic py-4">Không tìm thấy nhân viên phù hợp.</p>
                      ) : pickerList.map((emp, i) => (
                        <button key={`${emp.name}-${i}`} type="button"
                          onClick={() => { setSubAssignee(emp.name); setShowPicker(false); }}
                          className="w-full flex items-center gap-2.5 px-4 py-2 hover:bg-slate-50 transition-colors text-left cursor-pointer">
                          <span className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-cyan-400 text-white text-[9px] font-bold flex items-center justify-center shrink-0">
                            {emp.name.split(" ").filter(Boolean).map(n => n[0]).join("").slice(0, 2).toUpperCase()}
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="block text-xs font-bold text-slate-700 truncate">{emp.name}</span>
                            <span className="block text-[10px] text-slate-400 font-semibold truncate">{emp.department || "Chưa xếp phòng"}{emp.role ? ` • ${emp.role}` : ""}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <input type="date" value={subDue} onChange={e => setSubDue(e.target.value)}
                  className="px-2 py-1.5 bg-white border border-slate-200 rounded-lg outline-none" />
                <input type="number" min={1} max={100 - totalWeight} value={subWeight} onChange={e => setSubWeight(e.target.value)}
                  placeholder={`% (≤${100 - totalWeight})`} className="px-2 py-1.5 bg-white border border-slate-200 rounded-lg outline-none" />
                <button type="button" onClick={addSubtask} disabled={adding}
                  className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-bold rounded-lg">
                  {adding ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Thêm
                </button>
              </div>
            )}
          </div>
        )}

        {canManage && (
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-200/70">
            <label className="flex items-center gap-1.5 font-semibold text-slate-700 cursor-pointer">
              <input type="checkbox" checked={hold} onChange={e => setHold(e.target.checked)} />
              <PauseCircle size={13} /> Tạm hoãn / huỷ — không tính KPI
            </label>
            {hold && (
              <input value={holdReason} onChange={e => setHoldReason(e.target.value)} placeholder="Lý do (VD: chờ CĐT phản hồi)"
                className="flex-1 min-w-[200px] px-2 py-1.5 bg-white border border-slate-200 rounded-lg outline-none" />
            )}
            {(hold !== savedHold.hold || (hold && holdReason.trim() !== savedHold.reason)) && (
              <button type="button" onClick={saveHold} disabled={savingHold}
                className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white font-bold rounded-lg">
                {savingHold ? "Đang lưu…" : "Lưu cờ KPI"}
              </button>
            )}
          </div>
        )}

        {err && <div className="text-rose-600 font-semibold">{err}</div>}
      </div>
    </div>
  );
}
