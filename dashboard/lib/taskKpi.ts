// ============================================================
// taskKpi — luật chấm KPI công việc (user chốt 11/11/2026). Logic THUẦN: không
// gọi mạng, không React -> kiểm được bằng scripts/taskKpi.test.ts.
//
// Một task được chấm theo số NGÀY LÀM VIỆC trễ so với deadline:
//   nộp ≤ deadline       -> 100%   (on_time)
//   trễ 1–3 ngày làm việc -> 70%    (late_minor)
//   trễ > 3 ngày          -> 30%    (late_major)
//   quá hạn chưa nộp      -> 0%     (overdue)
// Mốc nộp = tasks.submitted_at (trigger migration 164 ghi lần đầu vào Chờ phê
// duyệt / Update thông tin / Đã hoàn thành).
//
// Không tính: task tổng (is_group), cờ hoãn (kpi_hold), không có deadline, chưa
// tới hạn, đơn nghỉ phép / công tác / phiếu VPP, task cũ xong trước khi có mốc.
//
// Trọng số khi gộp điểm một người:
//   task thường : hệ số ưu tiên (Cao 1.5 / Trung bình 1 / Thấp 0.7)
//   task con    : hệ số ưu tiên × kpi_weight/100 — cả task tổng tính như MỘT
//                 task, chia cho các task con theo trọng số.
// ============================================================

export interface KpiTask {
  id: string;
  title: string;
  assignee: string;
  priority?: string | null;
  due_date?: string | null;
  status: string;
  progress?: number | null;
  submitted_at?: string | null;
  parent_id?: string | null;
  kpi_weight?: number | null;
  kpi_hold?: boolean | null;
  is_group?: boolean | null;
}

export type KpiOutcome =
  | "on_time" | "late_minor" | "late_major" | "overdue" // được chấm
  | "not_due"    // chưa tới hạn, chưa nộp
  | "no_stamp"   // task cũ đã xong nhưng không có mốc nộp
  | "excluded";  // task tổng / hoãn / không deadline / không phải task Kanban

export const SCORED_OUTCOMES = ["on_time", "late_minor", "late_major", "overdue"] as const;
export type ScoredOutcome = (typeof SCORED_OUTCOMES)[number];

export const OUTCOME_SCORE: Record<ScoredOutcome, number> = {
  on_time: 1, late_minor: 0.7, late_major: 0.3, overdue: 0,
};

export const OUTCOME_LABEL: Record<KpiOutcome, string> = {
  on_time: "Đúng hạn",
  late_minor: "Trễ ≤ 3 ngày",
  late_major: "Trễ > 3 ngày",
  overdue: "Quá hạn chưa nộp",
  not_due: "Chưa tới hạn",
  no_stamp: "Chưa có mốc nộp",
  excluded: "Không tính",
};

export const MINOR_LATE_MAX_DAYS = 3;

export function priorityCoef(priority?: string | null): number {
  if (priority === "Cao") return 1.5;
  if (priority === "Thấp") return 0.7;
  return 1; // "Trung bình" và task cũ chưa có ưu tiên
}

/** Ngày "YYYY-MM-DD" theo giờ Việt Nam của một timestamp. */
export function vnDayKey(ts: string | Date): string {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}

const addDay = (key: string, n: number) => {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
};

export function isWorkday(key: string, holidays: Set<string>): boolean {
  const [y, m, d] = key.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.has(key);
}

/** Số ngày làm việc trong khoảng (due, done]. done ≤ due -> 0. */
export function workdaysLate(due: string, done: string, holidays: Set<string>): number {
  let n = 0;
  for (let k = addDay(due, 1); k <= done; k = addDay(k, 1)) {
    if (isWorkday(k, holidays)) n++;
  }
  return n;
}

/** Đơn nghỉ phép / công tác / phiếu VPP dùng chung bảng `tasks` — không phải việc Kanban. */
export function isNonKanbanTask(title: string): boolean {
  const t = (title || "").toLowerCase();
  return t.startsWith("nghỉ phép") || t.includes("nghi phep")
      || t.startsWith("công tác") || t.includes("cong tac")
      || t.startsWith("vpp:") || t.includes("vpp");
}

export function classifyTask(
  t: KpiTask, todayKey: string, holidays: Set<string>
): { outcome: KpiOutcome; lateDays: number } {
  const due = (t.due_date || "").slice(0, 10);
  if (t.is_group || t.kpi_hold || !due || isNonKanbanTask(t.title)) {
    return { outcome: "excluded", lateDays: 0 };
  }
  if (t.submitted_at) {
    const late = workdaysLate(due, vnDayKey(t.submitted_at), holidays);
    if (late === 0) return { outcome: "on_time", lateDays: 0 };
    return { outcome: late <= MINOR_LATE_MAX_DAYS ? "late_minor" : "late_major", lateDays: late };
  }
  if (t.status === "completed" || t.status === "pending_approval" || t.status === "tracking") {
    return { outcome: "no_stamp", lateDays: 0 };
  }
  if (todayKey <= due) return { outcome: "not_due", lateDays: 0 };
  return { outcome: "overdue", lateDays: workdaysLate(due, todayKey, holidays) };
}

/** Trọng số của task trong điểm KPI của người làm. */
export function kpiTaskWeight(t: KpiTask): number {
  const share = t.parent_id ? (Number(t.kpi_weight) || 0) / 100 : 1;
  return priorityCoef(t.priority) * share;
}

// ─── Kỳ đánh giá: gán theo deadline ───
export type KpiPeriod = { label: string; from: string; to: string };

export function quarterPeriod(year: number, q: 1 | 2 | 3 | 4): KpiPeriod {
  const m1 = (q - 1) * 3 + 1;
  const lastDay = new Date(Date.UTC(year, m1 + 2, 0)).getUTCDate();
  return {
    label: `Quý ${q}/${year}`,
    from: `${year}-${String(m1).padStart(2, "0")}-01`,
    to: `${year}-${String(m1 + 2).padStart(2, "0")}-${lastDay}`,
  };
}

export function yearPeriod(year: number): KpiPeriod {
  return { label: `Năm ${year}`, from: `${year}-01-01`, to: `${year}-12-31` };
}

export function inPeriod(t: KpiTask, p: KpiPeriod): boolean {
  const due = (t.due_date || "").slice(0, 10);
  return !!due && due >= p.from && due <= p.to;
}

// ─── Gộp điểm một người ───
export interface ScoredTask {
  task: KpiTask;
  outcome: KpiOutcome;
  lateDays: number;
  weight: number;
}

export interface KpiSummary {
  counts: Record<KpiOutcome, number>;
  scoredCount: number;       // số task được chấm (4 nhóm đầu)
  score: number | null;      // 0..100, null = chưa có task nào được chấm
  items: ScoredTask[];
}

export function summarize(tasks: KpiTask[], todayKey: string, holidays: Set<string>): KpiSummary {
  const counts: Record<KpiOutcome, number> = {
    on_time: 0, late_minor: 0, late_major: 0, overdue: 0, not_due: 0, no_stamp: 0, excluded: 0,
  };
  let wSum = 0, wScore = 0;
  const items: ScoredTask[] = tasks.map(task => {
    const { outcome, lateDays } = classifyTask(task, todayKey, holidays);
    const weight = kpiTaskWeight(task);
    counts[outcome]++;
    if (outcome in OUTCOME_SCORE) {
      wSum += weight;
      wScore += weight * OUTCOME_SCORE[outcome as ScoredOutcome];
    }
    return { task, outcome, lateDays, weight };
  });
  const scoredCount = SCORED_OUTCOMES.reduce((s, o) => s + counts[o], 0);
  return {
    counts,
    scoredCount,
    score: wSum > 0 ? Math.round((wScore / wSum) * 1000) / 10 : null,
    items,
  };
}

/** Tiến độ task tổng = Σ trọng số × tiến độ task con. Task con đã xong tính 100%. */
export function groupProgress(children: KpiTask[]): number {
  const total = children.reduce((s, c) => {
    const p = c.status === "completed" ? 100 : Number(c.progress) || 0;
    return s + (Number(c.kpi_weight) || 0) * p / 100;
  }, 0);
  return Math.round(total);
}

export function kpiGrade(score: number | null): string {
  if (score === null) return "—";
  if (score >= 90) return "Xuất sắc";
  if (score >= 75) return "Tốt";
  if (score >= 60) return "Đạt";
  return "Cần cải thiện";
}
