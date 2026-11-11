"use client";

// ============================================================
// KPI Công việc — dashboard điểm đúng hạn theo người làm, theo quý / năm.
// Luật chấm nằm ở lib/taskKpi.ts (đã có ca kiểm scripts/taskKpi.test.ts).
//
// Phạm vi xem KHỚP bảng Kanban (app/tasks/page.tsx, filteredTasks):
//   Admin / Giám đốc / cờ can_view_all_tasks -> toàn công ty
//   Trưởng/Phó phòng, Tổ trưởng, Chỉ huy trưởng/phó -> người cùng phòng
//   supervises_name -> người được giám sát
//   còn lại -> chỉ chính mình
// RLS (migration 045) cho cấp quản lý đọc mọi dòng `tasks`, nên phải lọc lại ở
// đây đúng như Kanban đang lọc.
// ============================================================

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Sidebar from "@/components/Sidebar";
import Header from "@/components/Header";
import { supabase } from "@/lib/supabase";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { isDirectorRole } from "@/lib/access";
import { normalizeName } from "@/lib/approvers";
import { useDepartments } from "@/lib/departments";
import {
  summarize, quarterPeriod, yearPeriod, inPeriod, vnDayKey, kpiGrade,
  OUTCOME_LABEL, SCORED_OUTCOMES,
  type KpiTask, type KpiPeriod, type KpiSummary, type ScoredOutcome,
} from "@/lib/taskKpi";
import { ArrowLeft, Loader2, Target, AlertTriangle, CheckCircle2, Clock, XCircle, AlertCircle } from "lucide-react";

interface EmployeeRef { name: string; department?: string | null }

// Bản sao isDeptManagerRole ở app/tasks/page.tsx — file page không export được hàm.
const isDeptManagerRole = (role?: string | null) => {
  const r = normalizeName(role || "");
  return (
    r.includes("truong phong") || r.includes("pho phong") ||
    r.includes("pho truong phong") || r.includes("quyen truong phong") ||
    r.includes("chi huy truong") || r.includes("chi huy pho") ||
    r.includes("to truong")
  );
};

const overlap = (a: string, b: string) => {
  const x = a.toLowerCase().trim(), y = b.toLowerCase().trim();
  return !!x && !!y && (x.includes(y) || y.includes(x));
};

// Màu TRẠNG THÁI (tốt / cảnh báo / nghiêm trọng / nguy cấp) — luôn đi kèm biểu tượng + nhãn.
const OUTCOME_STYLE: Record<ScoredOutcome, { bar: string; text: string; Icon: typeof CheckCircle2 }> = {
  on_time:    { bar: "bg-emerald-500", text: "text-emerald-600", Icon: CheckCircle2 },
  late_minor: { bar: "bg-amber-400",   text: "text-amber-600",   Icon: Clock },
  late_major: { bar: "bg-orange-500",  text: "text-orange-600",  Icon: AlertCircle },
  overdue:    { bar: "bg-rose-500",    text: "text-rose-600",    Icon: XCircle },
};

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
const fmtDay = (iso?: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");

export default function TaskKpiPage() {
  const user = useCurrentUser();
  const { phongBan, bdh } = useDepartments();
  const todayKey = vnDayKey(new Date());
  const thisYear = Number(todayKey.slice(0, 4));
  const thisQuarter = (Math.floor((Number(todayKey.slice(5, 7)) - 1) / 3) + 1) as 1 | 2 | 3 | 4;

  const [year, setYear] = useState(thisYear);
  const [quarter, setQuarter] = useState<"year" | 1 | 2 | 3 | 4>(thisQuarter);
  const [filterDept, setFilterDept] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);

  const [tasks, setTasks] = useState<KpiTask[]>([]);
  const [holidays, setHolidays] = useState<Set<string>>(new Set());
  const [employees, setEmployees] = useState<EmployeeRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [migrationMissing, setMigrationMissing] = useState(false);

  useEffect(() => {
    if (!user.authenticated) return;
    let alive = true;
    (async () => {
      setLoading(true);
      setError("");
      const [t, h, e] = await Promise.all([
        supabase.from("tasks").select("*")
          .gte("due_date", `${year}-01-01`).lte("due_date", `${year}-12-31`),
        supabase.from("kpi_holidays").select("day"),
        supabase.from("employees_directory").select("name, department"),
      ]);
      if (!alive) return;
      if (t.error) setError(t.error.message);
      // select("*") để trang vẫn chạy khi chưa chạy migration 164 (thiếu cột -> undefined).
      const rows = (t.data || []) as Partial<KpiTask>[];
      setMigrationMissing(rows.length > 0 && !("submitted_at" in rows[0]));
      setTasks(rows.map(r => ({
        id: String(r.id), title: r.title || "", assignee: r.assignee || "", priority: r.priority,
        due_date: r.due_date, status: r.status || "planning", progress: r.progress,
        submitted_at: r.submitted_at, parent_id: r.parent_id, kpi_weight: r.kpi_weight,
        kpi_hold: r.kpi_hold, is_group: r.is_group,
      })));
      setHolidays(new Set(((h.data || []) as { day: string }[]).map(x => String(x.day).slice(0, 10))));
      setEmployees((e.data || []) as EmployeeRef[]);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [user.authenticated, year]);

  const findEmp = (name: string): EmployeeRef | null => {
    const key = normalizeName(name || "");
    if (!key) return null;
    return employees.find(e => normalizeName(e.name) === key)
      || employees.find(e => { const n = normalizeName(e.name); return !!n && (n.includes(key) || key.includes(n)); })
      || null;
  };

  const seesAll = user.isAdmin || user.role.toLowerCase() === "admin" || user.isDirector
    || isDirectorRole(user.department) || user.perms.canViewAllTasks;
  const myDeptKey = normalizeName(user.department || "");
  const amMgr = isDeptManagerRole(user.role);
  const seesOthers = seesAll || (amMgr && !!myDeptKey) || !!user.perms.supervisesName;

  const isMine = (assignee: string) => overlap(assignee, user.name) || assignee.toLowerCase().trim() === user.email.toLowerCase().trim();
  const canSee = (assignee: string) => {
    if (seesAll) return true;
    if (amMgr && myDeptKey && normalizeName(findEmp(assignee)?.department || "") === myDeptKey) return true;
    if (user.perms.supervisesName && overlap(assignee, user.perms.supervisesName)) return true;
    return isMine(assignee);
  };

  const period: KpiPeriod = quarter === "year" ? yearPeriod(year) : quarterPeriod(year, quarter);

  // Gom task theo NGƯỜI LÀM (tên chuẩn trong Danh sách nhân viên nếu tra được).
  const byPerson = useMemo(() => {
    const map = new Map<string, { name: string; dept: string; tasks: KpiTask[] }>();
    for (const t of tasks) {
      if (!t.assignee || t.assignee === "Chưa phân công" || !canSee(t.assignee)) continue;
      const emp = findEmp(t.assignee);
      const name = emp?.name || t.assignee;
      const dept = emp?.department || "";
      if (filterDept !== "all" && normalizeName(dept) !== normalizeName(filterDept)) continue;
      if (!map.has(name)) map.set(name, { name, dept, tasks: [] });
      map.get(name)!.tasks.push(t);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, employees, filterDept, user.name, user.role, user.department, seesAll]);

  const ranking = useMemo(() => {
    return [...byPerson.values()]
      .map(p => ({ ...p, s: summarize(p.tasks.filter(t => inPeriod(t, period)), todayKey, holidays) }))
      .filter(p => p.s.items.some(i => i.outcome !== "excluded"))
      .sort((a, b) => (b.s.score ?? -1) - (a.s.score ?? -1) || a.name.localeCompare(b.name, "vi"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byPerson, period.from, period.to, holidays, todayKey]);

  // Nhân viên thường: vào thẳng dashboard của mình.
  const myName = findEmp(user.name)?.name || user.name;
  const personName = seesOthers ? selected : myName;
  const person = personName ? byPerson.get(personName) : undefined;

  const subtitle = seesAll ? "Toàn công ty" : amMgr && user.department ? user.department : "KPI của bạn";

  return (
    <div className="flex min-h-screen bg-[#F7F9FC]">
      <Sidebar />
      <div className="ml-60 flex-1 flex flex-col min-w-0">
        <Header title="KPI Công việc" subtitle={`Điểm đúng hạn theo người làm — ${subtitle}`} />

        <main className="flex-1 p-8 space-y-6 overflow-y-auto">
          {/* Bộ lọc: một hàng */}
          <div className="flex flex-wrap items-center gap-3">
            <select value={year} onChange={e => setYear(Number(e.target.value))}
              className="px-3 py-2 text-xs font-semibold bg-white border border-slate-200 rounded-xl shadow-sm">
              {[thisYear - 1, thisYear, thisYear + 1].map(y => <option key={y} value={y}>Năm {y}</option>)}
            </select>
            <div className="flex bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
              {([1, 2, 3, 4, "year"] as const).map(q => (
                <button key={q} onClick={() => setQuarter(q)}
                  className={`px-3 py-2 text-xs font-semibold ${quarter === q ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                  {q === "year" ? "Cả năm" : `Quý ${q}`}
                </button>
              ))}
            </div>
            {seesAll && (
              <select value={filterDept} onChange={e => { setFilterDept(e.target.value); setSelected(null); }}
                className="px-3 py-2 text-xs font-semibold bg-white border border-slate-200 rounded-xl shadow-sm">
                <option value="all">Tất cả phòng ban / BĐH</option>
                {[...phongBan, ...bdh].map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            )}
            <Link href="/tasks" className="ml-auto text-xs font-semibold text-blue-600 hover:underline">← Bảng công việc</Link>
          </div>

          {migrationMissing && (
            <Banner>Chưa chạy migration 164 (mốc nộp duyệt). Điểm KPI chưa chính xác cho tới khi Admin chạy file migrations/164_task_kpi.sql.</Banner>
          )}
          {error && <Banner>Không tải được dữ liệu: {error}</Banner>}

          {loading || user.loading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="animate-spin" size={16} /> Đang tính KPI…</div>
          ) : personName ? (
            <PersonDetail
              name={personName} dept={person?.dept || findEmp(personName)?.department || ""}
              tasks={person?.tasks || []} period={period} year={year}
              todayKey={todayKey} holidays={holidays}
              onBack={seesOthers ? () => setSelected(null) : undefined}
            />
          ) : (
            <RankingTable rows={ranking} periodLabel={period.label} onPick={setSelected} />
          )}

          <p className="text-[11px] text-slate-500 leading-relaxed">
            Cách tính: nộp duyệt ≤ deadline = 100%, trễ 1–3 ngày làm việc = 70%, trễ &gt; 3 ngày = 30%, quá hạn chưa nộp = 0%.
            Hệ số ưu tiên Cao 1.5 · Trung bình 1 · Thấp 0.7; task con nhân thêm trọng số % trong task tổng.
            Gán kỳ theo deadline. Không tính: task tổng, task tạm hoãn/huỷ, task chưa tới hạn.
          </p>
        </main>
      </div>
    </div>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 p-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span>{children}</span>
    </div>
  );
}

function OutcomeBar({ s }: { s: KpiSummary }) {
  if (s.scoredCount === 0) return <div className="h-2.5 rounded-full bg-slate-100" />;
  return (
    <div className="flex h-2.5 gap-[2px] rounded-full overflow-hidden">
      {SCORED_OUTCOMES.filter(o => s.counts[o] > 0).map(o => (
        <div key={o} className={OUTCOME_STYLE[o].bar}
          style={{ width: `${(s.counts[o] / s.scoredCount) * 100}%` }}
          title={`${OUTCOME_LABEL[o]}: ${s.counts[o]} task (${pct(s.counts[o], s.scoredCount)}%)`} />
      ))}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-4 text-[11px] text-slate-600">
      {SCORED_OUTCOMES.map(o => {
        const { bar, Icon, text } = OUTCOME_STYLE[o];
        return (
          <span key={o} className="flex items-center gap-1.5">
            <span className={`w-2.5 h-2.5 rounded-sm ${bar}`} />
            <Icon size={12} className={text} /> {OUTCOME_LABEL[o]}
          </span>
        );
      })}
    </div>
  );
}

function RankingTable({ rows, periodLabel, onPick }: {
  rows: { name: string; dept: string; s: KpiSummary }[];
  periodLabel: string;
  onPick: (name: string) => void;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-slate-100">
        <h2 className="text-sm font-bold text-slate-800">Bảng KPI — {periodLabel}</h2>
        <Legend />
      </div>
      {rows.length === 0 ? (
        <p className="p-6 text-sm text-slate-500">Chưa có task nào có deadline trong kỳ này.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-500 text-left">
              <tr>
                <th className="px-4 py-2 font-semibold">#</th>
                <th className="px-4 py-2 font-semibold">Người làm</th>
                <th className="px-4 py-2 font-semibold w-48">Kết quả</th>
                <th className="px-4 py-2 font-semibold text-right">Task chấm</th>
                {SCORED_OUTCOMES.map(o => <th key={o} className="px-4 py-2 font-semibold text-right">{OUTCOME_LABEL[o]}</th>)}
                <th className="px-4 py-2 font-semibold text-right">Điểm KPI</th>
                <th className="px-4 py-2 font-semibold">Xếp loại</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.name} onClick={() => onPick(r.name)}
                  className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer">
                  <td className="px-4 py-2.5 text-slate-400">{i + 1}</td>
                  <td className="px-4 py-2.5">
                    <div className="font-semibold text-slate-800">{r.name}</div>
                    {r.dept && <div className="text-[11px] text-slate-500">{r.dept}</div>}
                  </td>
                  <td className="px-4 py-2.5"><OutcomeBar s={r.s} /></td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{r.s.scoredCount}</td>
                  {SCORED_OUTCOMES.map(o => (
                    <td key={o} className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                      {r.s.scoredCount ? `${pct(r.s.counts[o], r.s.scoredCount)}%` : "—"}
                    </td>
                  ))}
                  <td className="px-4 py-2.5 text-right font-bold tabular-nums text-slate-800">{r.s.score ?? "—"}</td>
                  <td className="px-4 py-2.5 text-slate-600">{kpiGrade(r.s.score)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PersonDetail({ name, dept, tasks, period, year, todayKey, holidays, onBack }: {
  name: string; dept: string; tasks: KpiTask[]; period: KpiPeriod; year: number;
  todayKey: string; holidays: Set<string>; onBack?: () => void;
}) {
  const s = summarize(tasks.filter(t => inPeriod(t, period)), todayKey, holidays);
  const quarters = ([1, 2, 3, 4] as const).map(q => {
    const p = quarterPeriod(year, q);
    return { q, s: summarize(tasks.filter(t => inPeriod(t, p)), todayKey, holidays) };
  });
  const problemItems = s.items
    .filter(i => i.outcome === "late_minor" || i.outcome === "late_major" || i.outcome === "overdue")
    .sort((a, b) => b.lateDays - a.lateDays);

  return (
    <div className="space-y-5">
      {onBack && (
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900">
          <ArrowLeft size={14} /> Về bảng KPI
        </button>
      )}

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* Điểm chính */}
        <div className="p-5 bg-white border border-slate-200 rounded-2xl shadow-sm">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-500"><Target size={14} /> {period.label}</div>
          <div className="mt-1 text-sm font-bold text-slate-800">{name}</div>
          {dept && <div className="text-[11px] text-slate-500">{dept}</div>}
          <div className="mt-4 text-5xl font-extrabold tabular-nums text-slate-900">
            {s.score ?? "—"}{s.score !== null && <span className="text-2xl text-slate-400">%</span>}
          </div>
          <div className="mt-1 text-sm font-semibold text-slate-600">{kpiGrade(s.score)}</div>
          <div className="mt-3 text-[11px] text-slate-500">{s.scoredCount} task được chấm</div>
        </div>

        {/* Phân bố + 4 ô số */}
        <div className="p-5 bg-white border border-slate-200 rounded-2xl shadow-sm space-y-4">
          <OutcomeBar s={s} />
          <Legend />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {SCORED_OUTCOMES.map(o => {
              const { Icon, text } = OUTCOME_STYLE[o];
              return (
                <div key={o} className="p-3 border border-slate-100 rounded-xl">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
                    <Icon size={13} className={text} /> {OUTCOME_LABEL[o]}
                  </div>
                  <div className="mt-1 text-2xl font-bold tabular-nums text-slate-800">{pct(s.counts[o], s.scoredCount)}%</div>
                  <div className="text-[11px] text-slate-500">{s.counts[o]} task</div>
                </div>
              );
            })}
          </div>
          <div className="text-[11px] text-slate-500">
            Chưa tới hạn: {s.counts.not_due} · Không tính (task tổng / tạm hoãn): {s.counts.excluded}
            {s.counts.no_stamp > 0 && <> · Task cũ chưa có mốc nộp: {s.counts.no_stamp}</>}
          </div>
        </div>
      </div>

      {/* Điểm 4 quý trong năm */}
      <div className="p-5 bg-white border border-slate-200 rounded-2xl shadow-sm">
        <h3 className="text-sm font-bold text-slate-800 mb-4">Điểm KPI theo quý — {year}</h3>
        <div className="grid grid-cols-4 gap-4 items-end h-40">
          {quarters.map(({ q, s: qs }) => (
            <div key={q} className="flex flex-col items-center justify-end h-full gap-1.5"
              title={`Quý ${q}: ${qs.score ?? "chưa có"}${qs.score !== null ? "%" : ""} · ${qs.scoredCount} task`}>
              <span className="text-xs font-bold tabular-nums text-slate-700">{qs.score ?? "—"}</span>
              <div className="w-10 bg-blue-500 rounded-t" style={{ height: `${qs.score ?? 0}%`, minHeight: qs.score === null ? 0 : 2 }} />
              <span className="text-[11px] text-slate-500">Quý {q}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Task trễ / quá hạn */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm">
        <h3 className="p-4 text-sm font-bold text-slate-800 border-b border-slate-100">Task trễ / quá hạn — {period.label}</h3>
        {problemItems.length === 0 ? (
          <p className="p-4 text-xs text-slate-500">Không có task trễ hạn trong kỳ.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="px-4 py-2 font-semibold">Công việc</th>
                <th className="px-4 py-2 font-semibold">Ưu tiên</th>
                <th className="px-4 py-2 font-semibold">Deadline</th>
                <th className="px-4 py-2 font-semibold">Nộp duyệt</th>
                <th className="px-4 py-2 font-semibold text-right">Ngày trễ</th>
                <th className="px-4 py-2 font-semibold">Kết quả</th>
              </tr>
            </thead>
            <tbody>
              {problemItems.map(({ task, outcome, lateDays }) => {
                const st = OUTCOME_STYLE[outcome as ScoredOutcome];
                return (
                  <tr key={task.id} className="border-t border-slate-100">
                    <td className="px-4 py-2.5 text-slate-800">
                      {task.title}
                      {task.parent_id && <span className="ml-1.5 text-[10px] text-slate-500">(task con · {task.kpi_weight ?? 0}%)</span>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">{task.priority || "Trung bình"}</td>
                    <td className="px-4 py-2.5 tabular-nums">{fmtDay(task.due_date)}</td>
                    <td className="px-4 py-2.5 tabular-nums">{task.submitted_at ? fmtDay(vnDayKey(task.submitted_at)) : "—"}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{lateDays}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex items-center gap-1 font-semibold ${st.text}`}>
                        <st.Icon size={12} /> {OUTCOME_LABEL[outcome]}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
