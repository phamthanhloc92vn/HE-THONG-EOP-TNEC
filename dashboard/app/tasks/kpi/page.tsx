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
import {
  ArrowLeft, Loader2, Target, AlertTriangle, CheckCircle2, Clock, XCircle, AlertCircle,
  Trophy, ListChecks, TrendingDown, Users,
} from "lucide-react";

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

  return (
    <div className="flex min-h-screen bg-[#F7F9FC]">
      <Sidebar />
      <div className="ml-60 flex-1 flex flex-col min-w-0">
        <Header title="KPI Công việc" />

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
            <>
              <Overview rows={ranking} byDept={seesAll && filterDept === "all"}
                todayKey={todayKey} holidays={holidays} onPick={setSelected} />
              <RankingTable rows={ranking} periodLabel={period.label} onPick={setSelected} />
            </>
          )}

          {/* Dòng cách tính: chỉ Admin thấy (user chốt). Cùng điều kiện Admin với Kanban. */}
          {(user.isAdmin || user.role.toLowerCase() === "admin") && (
          <p className="text-[11px] text-slate-500 leading-relaxed">
            Cách tính: nộp duyệt ≤ deadline = 100%, trễ 1–3 ngày làm việc = 70%, trễ &gt; 3 ngày = 30%, quá hạn chưa nộp = 0%.
            Hệ số ưu tiên Cao 1.5 · Trung bình 1 · Thấp 0.7; task con nhân thêm trọng số % trong task tổng.
            Gán kỳ theo deadline. Không tính: task tổng, task tạm hoãn/huỷ, task chưa tới hạn.
          </p>
          )}
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

// Tông màu ô số. Nền là màu pha trong suốt (không dùng bg-white — globals.css ép
// bg-white thành nền tối), nên tự hợp cả giao diện sáng lẫn tối.
type Tone = "emerald" | "blue" | "amber" | "rose" | "teal" | "sky" | "slate";
const TONE: Record<Tone, { box: string; label: string; chip: string }> = {
  emerald: { box: "bg-emerald-500/10 border-emerald-500/30", label: "text-emerald-600", chip: "bg-emerald-500" },
  blue:    { box: "bg-blue-500/10 border-blue-500/30",       label: "text-blue-600",    chip: "bg-blue-500" },
  amber:   { box: "bg-amber-500/10 border-amber-500/30",     label: "text-amber-600",   chip: "bg-amber-500" },
  rose:    { box: "bg-rose-500/10 border-rose-500/30",       label: "text-rose-600",    chip: "bg-rose-500" },
  teal:    { box: "bg-teal-500/10 border-teal-500/30",       label: "text-teal-600",    chip: "bg-teal-500" },
  sky:     { box: "bg-sky-500/10 border-sky-500/30",         label: "text-sky-600",     chip: "bg-sky-500" },
  slate:   { box: "bg-slate-500/10 border-slate-500/25",     label: "text-slate-500",   chip: "bg-slate-500" },
};

// ─── Tổng quan: 4 ô số + biểu đồ tròn phân bố + thanh điểm theo người / phòng ───
type RankRow = { name: string; dept: string; s: KpiSummary };

function Overview({ rows, byDept, todayKey, holidays, onPick }: {
  rows: RankRow[]; byDept: boolean; todayKey: string; holidays: Set<string>;
  onPick: (name: string) => void;
}) {
  if (rows.length === 0) return null;
  // Điểm chung = gộp mọi task của mọi người (có trọng số), không lấy trung bình điểm từng người.
  const all = summarize(rows.flatMap(r => r.s.items.map(i => i.task)), todayKey, holidays);
  const scored = rows.filter(r => r.s.score !== null);
  const weak = scored.filter(r => (r.s.score as number) < 60).length;

  // Thanh điểm: theo phòng (toàn công ty, chưa lọc phòng) hoặc theo người.
  const bars: { key: string; label: string; sub?: string; score: number; n: number; pick?: () => void }[] = byDept
    ? [...rows.reduce((m, r) => {
        const k = r.dept || "Chưa xếp phòng";
        m.set(k, [...(m.get(k) || []), r]);
        return m;
      }, new Map<string, RankRow[]>())]
        .map(([dept, rs]) => {
          const s = summarize(rs.flatMap(r => r.s.items.map(i => i.task)), todayKey, holidays);
          return { key: dept, label: dept, sub: `${rs.length} người`, score: s.score ?? -1, n: s.scoredCount };
        })
        .filter(b => b.score >= 0)
        .sort((a, b) => b.score - a.score)
    : scored.map(r => ({ key: r.name, label: r.name, sub: r.dept, score: r.s.score as number, n: r.s.scoredCount, pick: () => onPick(r.name) }));

  // Màu ô theo Ý NGHĨA con số, không trang trí: điểm chung đổi màu theo xếp loại,
  // ô "Cần cải thiện" chỉ đỏ khi thật sự có người dưới 60.
  const onTimePct = pct(all.counts.on_time, all.scoredCount);
  const gradeTone: Tone = all.score === null ? "slate" : all.score >= 90 ? "emerald" : all.score >= 75 ? "blue" : all.score >= 60 ? "amber" : "rose";
  const tiles: { label: string; value: string; note: string; tone: Tone; Icon: typeof Target; bar?: number }[] = [
    { label: "Điểm KPI chung", value: all.score === null ? "—" : `${all.score}`, note: kpiGrade(all.score), tone: gradeTone, Icon: Trophy, bar: all.score ?? 0 },
    { label: "Tỷ lệ đúng hạn", value: `${onTimePct}%`, note: `${all.counts.on_time}/${all.scoredCount} task`, tone: "teal", Icon: CheckCircle2, bar: onTimePct },
    { label: "Task được chấm", value: `${all.scoredCount}`, note: `${rows.length} người · ${all.counts.not_due} chưa tới hạn`, tone: "sky", Icon: ListChecks },
    { label: "Cần cải thiện (< 60)", value: `${weak}`, note: weak ? "người cần kèm thêm" : "Không có ai", tone: weak ? "rose" : "slate", Icon: weak ? TrendingDown : Users },
  ];

  return (
    <div className="space-y-4">
      {/* HAI HÀNG DÙNG CHUNG MỘT LƯỚI 4 CỘT (xl) để mép các thẻ thẳng hàng:
          hàng dưới = biểu đồ tròn 1 cột + biểu đồ thanh 3 cột.
          Dưới xl (laptop nhỏ / tablet): ô số 2 cột, biểu đồ xếp chồng toàn bề ngang.
          Điện thoại: ô số 1 cột. Mốc xl vì nội dung còn lại sau Sidebar 240px —
          ở lg (1024px) mỗi cột chỉ còn ~165px, không đủ chỗ cho biểu đồ tròn. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {tiles.map(t => {
          const c = TONE[t.tone];
          return (
            <div key={t.label} className={`relative p-4 rounded-2xl border ${c.box}`}>
              <div className="flex items-start justify-between gap-2">
                <div className={`text-[11px] font-bold uppercase tracking-wide ${c.label}`}>{t.label}</div>
                <span className={`w-8 h-8 rounded-xl flex items-center justify-center text-white ${c.chip}`}>
                  <t.Icon size={16} />
                </span>
              </div>
              <div className="mt-1 text-3xl font-extrabold tabular-nums text-slate-900">{t.value}</div>
              <div className="text-[11px] font-medium text-slate-500">{t.note}</div>
              {t.bar !== undefined && (
                <div className="mt-3 h-1.5 rounded-full bg-slate-500/15 overflow-hidden">
                  <div className={`h-full rounded-full ${c.chip}`} style={{ width: `${Math.min(100, t.bar)}%` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        <div className="p-5 bg-white border border-slate-200 rounded-2xl shadow-sm min-w-0">
          <h3 className="text-sm font-bold text-slate-800 mb-4">Phân bố kết quả</h3>
          <Donut s={all} />
        </div>
        <div className="p-5 bg-white border border-slate-200 rounded-2xl shadow-sm min-w-0 xl:col-span-3">
          <h3 className="text-sm font-bold text-slate-800 mb-4">
            {byDept ? "Điểm KPI theo phòng ban" : "Điểm KPI theo người"}
          </h3>
          <ScoreBars bars={bars} />
        </div>
      </div>
    </div>
  );
}

const DONUT_COLOR: Record<ScoredOutcome, string> = {
  on_time: "#10b981", late_minor: "#fbbf24", late_major: "#f97316", overdue: "#f43f5e",
};

function Donut({ s }: { s: KpiSummary }) {
  const R = 58, C = 2 * Math.PI * R, GAP = 3;
  const present = SCORED_OUTCOMES.filter(o => s.counts[o] > 0);
  // Tính sẵn độ dài + điểm bắt đầu của từng cung (cộng dồn), không đổi biến trong lúc render.
  const parts = present.map((o, i) => {
    const len = (s.counts[o] / s.scoredCount) * C;
    const start = present.slice(0, i).reduce((acc, p) => acc + (s.counts[p] / s.scoredCount) * C, 0);
    return { o, len, start };
  });
  return (
    // flex-wrap: thẻ hẹp (cột xl ~230px) thì chú thích tự xuống dưới vòng tròn.
    <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-4">
      <svg viewBox="0 0 160 160" className="w-32 h-32 shrink-0" role="img"
        aria-label={`Đúng hạn ${pct(s.counts.on_time, s.scoredCount)}%`}>
        {/* Xoay -90° để cung đầu tiên bắt đầu từ đỉnh 12 giờ. */}
        <g transform="rotate(-90 80 80)">
          {/* currentColor + opacity: ở chế độ tối globals.css chỉ đổi lớp text và bg, không đổi lớp fill / stroke. */}
          <circle cx="80" cy="80" r={R} fill="none" strokeWidth="18" stroke="currentColor" strokeOpacity={0.15} className="text-slate-500" />
          {parts.map(({ o, len, start }) => (
            <circle key={o} cx="80" cy="80" r={R} fill="none" strokeWidth="18" stroke={DONUT_COLOR[o]}
              strokeDasharray={`${Math.max(len - (parts.length > 1 ? GAP : 0), 0.5)} ${C}`}
              strokeDashoffset={-start}>
              <title>{`${OUTCOME_LABEL[o]}: ${s.counts[o]} task (${pct(s.counts[o], s.scoredCount)}%)`}</title>
            </circle>
          ))}
        </g>
        <text x="80" y="82" textAnchor="middle" fill="currentColor" fontSize="26" fontWeight="800" className="text-slate-900">
          {s.scoredCount ? `${pct(s.counts.on_time, s.scoredCount)}%` : "—"}
        </text>
        <text x="80" y="102" textAnchor="middle" fill="currentColor" fontSize="11" fontWeight="600" className="text-slate-500">đúng hạn</text>
      </svg>
      <ul className="space-y-2 text-xs">
        {SCORED_OUTCOMES.map(o => {
          const { Icon, text } = OUTCOME_STYLE[o];
          return (
            <li key={o} className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: DONUT_COLOR[o] }} />
              <Icon size={12} className={text} />
              <span className="text-slate-600 whitespace-nowrap">{OUTCOME_LABEL[o]}</span>
              <span className="ml-auto pl-3 font-bold tabular-nums text-slate-800">{s.counts[o]}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const MAX_BARS = 15;

function ScoreBars({ bars }: { bars: { key: string; label: string; sub?: string; score: number; n: number; pick?: () => void }[] }) {
  if (bars.length === 0) return <p className="text-xs text-slate-500">Chưa có điểm trong kỳ này.</p>;
  const shown = bars.slice(0, MAX_BARS);
  return (
    <div>
      <div className="relative">
        {/* Vạch mốc xếp loại: Đạt 60 · Tốt 75 · Xuất sắc 90. left/right PHẢI khớp bề
            rộng cột nhãn (110px điện thoại / 180px từ sm) và cột số (w-12) bên dưới. */}
        <div className="absolute inset-y-0 left-[110px] sm:left-[180px] right-12 pointer-events-none">
          {[60, 75, 90].map(m => (
            <div key={m} className="absolute inset-y-0 border-l border-dashed border-slate-300" style={{ left: `${m}%` }}>
              <span className="absolute -top-4 -translate-x-1/2 text-[9px] text-slate-400">{m}</span>
            </div>
          ))}
        </div>
        <ul className="space-y-1.5 pt-3">
          {shown.map(b => (
            <li key={b.key}>
              <button type="button" onClick={b.pick} disabled={!b.pick}
                title={`${b.label}: ${b.score} điểm · ${b.n} task được chấm · ${kpiGrade(b.score)}`}
                className="w-full flex items-center gap-0 text-left rounded-lg hover:bg-slate-50 disabled:hover:bg-transparent disabled:cursor-default py-1">
                <span className="w-[110px] sm:w-[180px] shrink-0 pr-3 min-w-0">
                  <span className="block text-xs font-semibold text-slate-800 truncate">{b.label}</span>
                  {b.sub && <span className="block text-[10px] text-slate-500 truncate">{b.sub}</span>}
                </span>
                <span className="flex-1 h-3 rounded-r bg-slate-100">
                  <span className="block h-full rounded-r bg-blue-500" style={{ width: `${Math.max(b.score, 1)}%` }} />
                </span>
                <span className="w-12 shrink-0 text-right text-xs font-bold tabular-nums text-slate-800">{b.score}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {bars.length > MAX_BARS && (
        <p className="mt-2 text-[11px] text-slate-500">Hiện {MAX_BARS}/{bars.length} — xem đủ ở bảng bên dưới.</p>
      )}
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
          {/* 4 cột chỉ từ xl: ở lg cột phải còn ~440px, chia 4 thì nhãn "Quá hạn chưa nộp" bị bẻ dòng. */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
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
          // Cuộn ngang trong khung trên điện thoại, không đẩy cả trang tràn ra ngoài.
          <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
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
          </div>
        )}
      </div>
    </div>
  );
}
