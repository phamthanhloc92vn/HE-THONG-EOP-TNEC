// Kiểm luật chấm KPI: node scripts/taskKpi.test.mjs  (Node ≥ 22.18 tự bỏ kiểu TS)
// Viết .mjs chứ không .ts: tsconfig gom mọi *.ts, mà import "../lib/taskKpi.ts"
// có đuôi .ts thì tsc báo lỗi TS5097 và làm hỏng type-check của cả dự án.
import assert from "node:assert/strict";
import {
  classifyTask, workdaysLate, summarize, groupProgress, quarterPeriod, kpiTaskWeight,
} from "../lib/taskKpi.ts";

const H = new Set(["2026-09-01", "2026-09-02"]); // lễ Quốc khánh
const base = { id: "x", title: "Lập hồ sơ", assignee: "A", status: "in_progress", due_date: "2026-10-09" };
// 2026-10-09 là thứ Sáu. submitted_at dùng giờ VN (+07).
const at = (day, hh = "10") => `${day}T${hh}:00:00+07:00`;
const cls = (t, today = "2026-11-11") => classifyTask({ ...base, ...t }, today, H).outcome;

// Ngày làm việc
assert.equal(workdaysLate("2026-10-09", "2026-10-11", H), 0, "T7+CN không tính");
assert.equal(workdaysLate("2026-10-09", "2026-10-12", H), 1, "thứ Hai = trễ 1");
assert.equal(workdaysLate("2026-08-31", "2026-09-03", H), 1, "bỏ 2 ngày lễ");
assert.equal(workdaysLate("2026-10-09", "2026-10-08", H), 0, "nộp sớm");

// Phân loại
assert.equal(cls({ submitted_at: at("2026-10-09", "23") }), "on_time", "23h ngày deadline vẫn đúng hạn");
assert.equal(cls({ submitted_at: at("2026-10-11") }), "on_time", "nộp chủ nhật sau deadline thứ Sáu");
assert.equal(cls({ submitted_at: at("2026-10-14") }), "late_minor", "trễ 3 ngày làm việc");
assert.equal(cls({ submitted_at: at("2026-10-15") }), "late_major", "trễ 4 ngày làm việc");
assert.equal(cls({}), "overdue", "quá hạn chưa nộp");
assert.equal(cls({}, "2026-10-09"), "not_due", "đúng ngày deadline chưa nộp = chưa tới hạn");
assert.equal(cls({ status: "completed" }), "no_stamp", "task cũ không có mốc");
assert.equal(cls({ kpi_hold: true }), "excluded");
assert.equal(cls({ is_group: true }), "excluded");
assert.equal(cls({ due_date: null }), "excluded");
assert.equal(cls({ title: "Nghỉ phép - A" }), "excluded");
// UTC 18:00 ngày 9 = 01:00 ngày 10 giờ VN -> thứ Bảy, vẫn đúng hạn; UTC 18:00 ngày 12 = thứ Ba VN -> trễ 2
assert.equal(cls({ submitted_at: "2026-10-12T18:00:00Z" }), "late_minor");

// Trọng số
assert.equal(kpiTaskWeight({ ...base, priority: "Cao" }), 1.5);
assert.ok(Math.abs(kpiTaskWeight({ ...base, priority: "Cao", parent_id: "p", kpi_weight: 20 }) - 0.3) < 1e-9);

// Gộp điểm: Cao đúng hạn (1.5×1) + Thấp quá hạn (0.7×0) + TB trễ nhẹ (1×0.7) = 2.2/3.2 = 68.75%
const s = summarize([
  { ...base, id: "1", priority: "Cao", submitted_at: at("2026-10-08") },
  { ...base, id: "2", priority: "Thấp" },
  { ...base, id: "3", submitted_at: at("2026-10-12") },
  { ...base, id: "4", due_date: "2026-12-01" },       // chưa tới hạn -> không vào mẫu
  { ...base, id: "5", kpi_hold: true },
], "2026-11-11", H);
assert.equal(s.scoredCount, 3);
assert.equal(s.score, 68.8);
assert.equal(s.counts.not_due, 1);
assert.equal(s.counts.excluded, 1);
assert.equal(summarize([], "2026-11-11", H).score, null);

// Tiến độ task tổng
assert.equal(groupProgress([
  { ...base, kpi_weight: 40, status: "completed", progress: 0 },
  { ...base, kpi_weight: 60, progress: 50 },
]), 70);

// Kỳ
assert.deepEqual(quarterPeriod(2026, 4), { label: "Quý 4/2026", from: "2026-10-01", to: "2026-12-31" });
assert.equal(quarterPeriod(2026, 1).to, "2026-03-31");

console.log("taskKpi: tất cả ca kiểm đều đạt");
