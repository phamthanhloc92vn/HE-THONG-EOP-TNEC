// ============================================================
// projectDailyReport — phiếu BÁO CÁO NGÀY theo mẫu công ty (migration 105).
// 1 phiếu / dự án / ngày, lưu phần tính theo cả ngày (thời tiết, nhân sự & máy
// theo từng đơn vị, việc ngày mai, vướng mắc…). Khối lượng "hôm nay" KHÔNG nhập
// ở đây mà lấy từ nhật ký sản lượng ĐÃ DUYỆT của ngày đó.
// Dùng chung cho: form nhập (DailyReportModal), bản xem/in (DailyReportView) và
// tệp Excel xuất ra (exportDailyReportXlsx) — cả ba cùng dựng từ buildDailyModel.
// ============================================================

import {
  daysBetween,
  formatDate,
  formatKm,
  type LogPhoto,
  type PcContract,
  type PcProject,
  type PcScope,
  type PcSegment,
  type PcSegmentWbs,
  type PcWbsItem,
} from "./projectControl";
import { resolveLogPhotoUrl } from "./projectLogPhotos";
import { supabase } from "./supabase";

export const DAILY_WEATHER = ["Nắng", "Âm u", "Mưa", "Mưa nhỏ", "Mưa lớn"];

// Chức danh / loại máy theo đúng thứ tự trong mẫu công ty.
export const MANPOWER_ROLES = ["CHT", "CBKT", "QS", "Trắc đạc", "CBVT, kho", "ATLĐ", "Hành chính", "Lái máy", "CN"];
export const EQUIPMENT_TYPES = ["Máy đào", "Xe ủi", "Xe lu", "Xe ben", "Xe cẩu", "Máy san"];

export type UnitGroup = "TNEC" | "NOMINAL" | "NON_NOMINAL";
export const UNIT_GROUP_LABEL: Record<UnitGroup, string> = {
  TNEC: "Lodeza EOP",
  NOMINAL: "Thầu phụ chính danh",
  NON_NOMINAL: "Thầu phụ Lodeza EOP",
};

export type DailyUnit = {
  key: string; // "TNEC" | contract_id | "u-xxxx" (đơn vị thêm tay)
  name: string;
  group: UnitGroup;
  scope: string;
  manpower: Record<string, number>;
  equipment: Record<string, number>;
  today: string; // ghi thêm ngoài phần tự lấy từ nhật ký, mỗi dòng 1 việc
  tomorrow: string;
  photos: LogPhoto[];
};

export type PcDailyReport = {
  id: string;
  project_id: string;
  report_date: string;
  weather_am: string | null;
  weather_pm: string | null;
  method: string | null;
  units: DailyUnit[];
  issues: string | null;
  proposals: string | null;
  reporter_name: string | null;
  reporter_title: string | null;
  created_by: string | null;
  updated_by: string | null;
  updated_at: string;
};

// Dòng nhật ký ngày đã duyệt (đủ để dựng câu "công việc hôm nay").
export type DailyLogLine = {
  segment_wbs_id: string;
  contract_id: string | null;
  qty: number;
  note: string | null;
};

export type DailyCtx = {
  segments: PcSegment[];
  wbs: PcSegmentWbs[];
  catalog: PcWbsItem[];
  contracts: PcContract[];
  scopes: PcScope[];
};

const ORDER: Record<UnitGroup, number> = { TNEC: 0, NOMINAL: 1, NON_NOMINAL: 2 };

export function emptyUnit(key: string, name: string, group: UnitGroup, scope = ""): DailyUnit {
  return { key, name, group, scope, manpower: {}, equipment: {}, today: "", tomorrow: "", photos: [] };
}

// Phạm vi công việc mặc định của 1 HĐ B-B' = các lý trình trong phạm vi HĐ.
function contractScopeText(contractId: string, ctx: DailyCtx): string {
  const segById = new Map(ctx.segments.map((s) => [s.id, s]));
  const itemById = new Map(ctx.catalog.map((c) => [c.id, c]));
  const parts: string[] = [];
  ctx.scopes
    .filter((s) => s.contract_id === contractId)
    .forEach((s) => {
      const seg = segById.get(s.segment_id);
      if (!seg) return;
      const km = `${formatKm(seg.km_start_m)} ÷ ${formatKm(seg.km_end_m)}`;
      const what = s.scope_desc || (s.wbs_item_id ? itemById.get(s.wbs_item_id)?.name : "") || "";
      const txt = what ? `${what} ${km}` : km;
      if (!parts.includes(txt)) parts.push(txt);
    });
  return parts.join("; ");
}

// Đơn vị mặc định: Lodeza EOP + mọi HĐ B-B' của dự án (chính danh trước).
export function defaultUnits(ctx: DailyCtx): DailyUnit[] {
  const units = [emptyUnit("TNEC", "Lodeza EOP", "TNEC")];
  ctx.contracts
    .filter((c) => c.contract_type === "B_B1")
    .forEach((c) =>
      units.push(
        emptyUnit(c.id, c.partner_name || c.contract_no || "Nhà thầu", c.legal_status === "NOMINAL" ? "NOMINAL" : "NON_NOMINAL", contractScopeText(c.id, ctx))
      )
    );
  return sortUnits(units);
}

export function sortUnits(units: DailyUnit[]): DailyUnit[] {
  return units.map((u, i) => ({ u, i })).sort((a, b) => ORDER[a.u.group] - ORDER[b.u.group] || a.i - b.i).map((x) => x.u);
}

// Giữ nguyên các đơn vị đã có (tên, phạm vi, số liệu người sửa tay), bổ sung HĐ mới.
export function mergeUnits(saved: DailyUnit[], defaults: DailyUnit[]): DailyUnit[] {
  const have = new Set(saved.map((u) => u.key));
  return sortUnits([...saved.map(normalizeUnit), ...defaults.filter((d) => !have.has(d.key))]);
}

// Phiếu ngày mới: chép đơn vị / phạm vi / nhân sự / máy từ phiếu gần nhất (thường ít
// thay đổi), bỏ việc & ảnh. Việc "ngày mai" của hôm trước KHÔNG tự thành việc hôm nay.
export function carryOverUnits(prev: DailyUnit[]): DailyUnit[] {
  return prev.map((u) => ({ ...normalizeUnit(u), today: "", tomorrow: "", photos: [] }));
}

function normalizeUnit(u: Partial<DailyUnit>): DailyUnit {
  return {
    key: String(u.key || ""),
    name: String(u.name || ""),
    group: u.group === "NOMINAL" || u.group === "NON_NOMINAL" || u.group === "TNEC" ? u.group : "NON_NOMINAL",
    scope: String(u.scope || ""),
    manpower: { ...(u.manpower || {}) },
    equipment: { ...(u.equipment || {}) },
    today: String(u.today || ""),
    tomorrow: String(u.tomorrow || ""),
    photos: Array.isArray(u.photos) ? u.photos : [],
  };
}

// Câu "công việc hôm nay" tự lấy từ nhật ký đã duyệt, gom theo đơn vị (contract_id,
// không có HĐ = TNEC) và theo hạng mục – lý trình.
export function autoWorkLines(logs: DailyLogLine[], ctx: DailyCtx): Map<string, string[]> {
  const swById = new Map(ctx.wbs.map((w) => [w.id, w]));
  const segById = new Map(ctx.segments.map((s) => [s.id, s]));
  const itemById = new Map(ctx.catalog.map((c) => [c.id, c]));
  const agg = new Map<string, { unitKey: string; swId: string; qty: number; notes: string[] }>();
  logs.forEach((l) => {
    const unitKey = l.contract_id || "TNEC";
    const k = `${unitKey}|${l.segment_wbs_id}`;
    const cur = agg.get(k) || { unitKey, swId: l.segment_wbs_id, qty: 0, notes: [] };
    cur.qty += Number(l.qty || 0);
    if (l.note && !cur.notes.includes(l.note)) cur.notes.push(l.note);
    agg.set(k, cur);
  });
  const out = new Map<string, string[]>();
  agg.forEach((a) => {
    const sw = swById.get(a.swId);
    const seg = sw ? segById.get(sw.segment_id) : null;
    const it = sw ? itemById.get(sw.wbs_item_id) : null;
    const qty = a.qty.toLocaleString("vi-VN", { maximumFractionDigits: 3 });
    let line = `${it?.name || "Hạng mục"}${seg ? ` (${seg.code})` : ""}: ${qty} ${sw?.unit || ""}`.trim();
    if (a.notes.length) line += ` — ${a.notes.join("; ")}`;
    out.set(a.unitKey, [...(out.get(a.unitKey) || []), line]);
  });
  return out;
}

export function splitLines(s: string | null | undefined): string[] {
  return (s || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (/^[-–•+*]/.test(x) ? `- ${x.replace(/^[-–•+*]\s*/, "")}` : `- ${x}`));
}

// Thời gian thi công theo mẫu: đếm cả ngày khởi công và ngày báo cáo.
export function scheduleStats(project: PcProject, date: string) {
  if (!project.start_date || !project.finish_date) return null;
  const total = daysBetween(project.start_date, project.finish_date) + 1;
  if (total <= 0) return null;
  const elapsed = Math.max(0, Math.min(total, daysBetween(project.start_date, date) + 1));
  return { total, elapsed, remaining: total - elapsed, ratio: elapsed / total };
}

// Nạp đủ dữ liệu của 1 ngày: danh mục, phiếu ngày đó, phiếu gần nhất trước đó (để
// chép đơn vị), nhật ký NGÀY đã duyệt và số dòng còn chờ QS duyệt.
export type DailyData = {
  ctx: DailyCtx;
  report: PcDailyReport | null;
  prevUnits: DailyUnit[] | null;
  prevMeta: { method: string | null; reporter_name: string | null; reporter_title: string | null } | null;
  logs: DailyLogLine[];
  pending: number;
  error: { message?: string; code?: string } | null;
};

export async function loadDailyData(projectId: string, date: string): Promise<DailyData> {
  const [s, c, co, rep, prev, lg] = await Promise.all([
    supabase.from("pc_segments").select("*").eq("project_id", projectId).order("km_start_m"),
    supabase.from("pc_wbs_items").select("*").order("sort_order"),
    supabase.from("pc_contracts").select("*").eq("project_id", projectId).order("created_at"),
    supabase.from("pc_daily_reports").select("*").eq("project_id", projectId).eq("report_date", date).maybeSingle(),
    supabase
      .from("pc_daily_reports")
      .select("units, method, reporter_name, reporter_title")
      .eq("project_id", projectId)
      .lt("report_date", date)
      .order("report_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("pc_progress_logs")
      .select("segment_wbs_id, contract_id, qty, note, status")
      .eq("project_id", projectId)
      .eq("log_date", date)
      .eq("entry_type", "DAY")
      .in("status", ["APPROVED", "SUBMITTED"]),
  ]);
  const segments = (s.data as PcSegment[]) || [];
  const contracts = (co.data as PcContract[]) || [];
  const [w, sc] = await Promise.all([
    segments.length ? supabase.from("pc_segment_wbs").select("*").in("segment_id", segments.map((x) => x.id)) : Promise.resolve({ data: [] }),
    contracts.length ? supabase.from("pc_contract_scopes").select("*").in("contract_id", contracts.map((x) => x.id)) : Promise.resolve({ data: [] }),
  ]);
  const logRows = (lg.data as (DailyLogLine & { status: string })[]) || [];
  const report = rep.data ? ({ ...(rep.data as PcDailyReport), units: Array.isArray(rep.data.units) ? rep.data.units : [] } as PcDailyReport) : null;
  return {
    ctx: {
      segments,
      wbs: (w.data as PcSegmentWbs[]) || [],
      catalog: (c.data as PcWbsItem[]) || [],
      contracts,
      scopes: (sc.data as PcScope[]) || [],
    },
    report,
    prevUnits: prev.data && Array.isArray(prev.data.units) ? (prev.data.units as DailyUnit[]) : null,
    prevMeta: prev.data
      ? { method: prev.data.method ?? null, reporter_name: prev.data.reporter_name ?? null, reporter_title: prev.data.reporter_title ?? null }
      : null,
    logs: logRows.filter((l) => l.status === "APPROVED"),
    pending: logRows.filter((l) => l.status === "SUBMITTED").length,
    error:
      rep.error && /pc_daily_reports/.test(rep.error.message || "")
        ? { message: "Chưa có bảng báo cáo ngày — chạy migrations/105_project_daily_report.sql trong Supabase > SQL Editor." }
        : [s, co, rep, lg].find((x) => x.error)?.error || null,
  };
}

export const sumRecord =(r: Record<string, number>) => Object.values(r || {}).reduce((a, v) => a + (Number(v) || 0), 0);

// ─── Mô hình dùng chung cho bản xem và Excel ───
export type DailyModel = {
  project: PcProject;
  date: string;
  tomorrow: string;
  report: PcDailyReport | null;
  units: DailyUnit[]; // Lodeza EOP + thầu phụ
  subs: DailyUnit[]; // chỉ thầu phụ (mục I)
  todayLines: Map<string, string[]>; // key đơn vị -> dòng "- …" (tự động + ghi thêm)
  tomorrowLines: Map<string, string[]>;
  stats: ReturnType<typeof scheduleStats>;
  manpowerTotal: number;
  equipmentTotal: number;
};

export function buildDailyModel(
  project: PcProject,
  date: string,
  report: PcDailyReport | null,
  prevUnits: DailyUnit[] | null,
  logs: DailyLogLine[],
  ctx: DailyCtx
): DailyModel {
  const defs = defaultUnits(ctx);
  const units = report ? mergeUnits(report.units, defs) : mergeUnits(prevUnits ? carryOverUnits(prevUnits) : [], defs);
  const auto = autoWorkLines(logs, ctx);
  // Nhật ký gắn HĐ không còn trong danh sách đơn vị -> vẫn phải hiện.
  auto.forEach((_, k) => {
    if (!units.some((u) => u.key === k)) units.push(emptyUnit(k, "Đơn vị khác", "NON_NOMINAL"));
  });
  const todayLines = new Map<string, string[]>();
  const tomorrowLines = new Map<string, string[]>();
  units.forEach((u) => {
    todayLines.set(u.key, [...(auto.get(u.key) || []).map((x) => `- ${x}`), ...splitLines(u.today)]);
    tomorrowLines.set(u.key, splitLines(u.tomorrow));
  });
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return {
    project,
    date,
    tomorrow: d.toISOString().slice(0, 10),
    report,
    units,
    subs: units.filter((u) => u.group !== "TNEC"),
    todayLines,
    tomorrowLines,
    stats: scheduleStats(project, date),
    manpowerTotal: units.reduce((a, u) => a + sumRecord(u.manpower), 0),
    equipmentTotal: units.reduce((a, u) => a + sumRecord(u.equipment), 0),
  };
}

export function bdhTitle(project: PcProject): string {
  const n = (project.bdh_name || "").trim();
  return /^(bđh|ban điều hành)/i.test(n)
    ? n.replace(/^(bđh|ban điều hành( dự án)?)\s*/i, "BAN ĐIỀU HÀNH DỰ ÁN ").toUpperCase()
    : `BAN ĐIỀU HÀNH DỰ ÁN ${n}`.toUpperCase();
}

export const COMPANY_NAME = "Lodeza EOP";

// ─── XUẤT EXCEL THEO MẪU ───
// Bố cục cột: A = nhãn, B.. = K cột đơn vị (K chẵn, tối thiểu 8 như mẫu).
// Mục III / Vướng mắc chia đôi K cột: nửa trái "Hôm nay", nửa phải "Ngày mai".

async function imageToJpeg(url: string, maxSide = 1000): Promise<{ base64: string; w: number; h: number } | null> {
  try {
    const blob = await (await fetch(url)).blob();
    const obj = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((ok, fail) => {
        const i = new Image();
        i.onload = () => ok(i);
        i.onerror = fail;
        i.src = obj;
      });
      const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * s));
      const h = Math.max(1, Math.round(img.naturalHeight * s));
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      const g = cv.getContext("2d");
      if (!g) return null;
      g.fillStyle = "#fff";
      g.fillRect(0, 0, w, h);
      g.drawImage(img, 0, 0, w, h);
      return { base64: cv.toDataURL("image/jpeg", 0.82).split(",")[1], w, h };
    } finally {
      URL.revokeObjectURL(obj);
    }
  } catch {
    return null;
  }
}

export async function exportDailyReportXlsx(m: DailyModel): Promise<void> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("BaoCaoNgay", {
    pageSetup: {
      paperSize: 9,
      orientation: "portrait",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
      printTitlesRow: "1:6",
    },
    views: [{ showGridLines: false }],
  });

  const K = Math.max(8, m.units.length + ((m.units.length % 2) ? 1 : 0));
  const C = 1 + K; // cột cuối
  const half = K / 2;
  const L1 = 2, L2 = 1 + half, R1 = 2 + half, R2 = C; // hai nửa của mục III
  const COLW_A = 13, COLW = 11.5;
  ws.getColumn(1).width = COLW_A;
  for (let c = 2; c <= C; c++) ws.getColumn(c).width = COLW;

  const GREEN = "FF92D050";
  const thin = { style: "thin" as const, color: { argb: "FF000000" } };
  const font = (o: Partial<{ bold: boolean; italic: boolean; size: number; color: string }> = {}) => ({
    name: "Arial",
    size: o.size ?? 10,
    bold: !!o.bold,
    italic: !!o.italic,
    color: { argb: o.color ?? "FF000000" },
  });
  type Style = {
    bold?: boolean;
    italic?: boolean;
    size?: number;
    color?: string;
    h?: "left" | "center" | "right";
    v?: "top" | "middle";
    fill?: string;
    border?: boolean;
    numFmt?: string;
  };
  const style = (r: number, c: number, s: Style) => {
    const cell = ws.getCell(r, c);
    cell.font = font(s);
    cell.alignment = { horizontal: s.h ?? "left", vertical: s.v ?? "middle", wrapText: true };
    if (s.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: s.fill } };
    if (s.numFmt) cell.numFmt = s.numFmt;
  };
  const border = (r1: number, c1: number, r2: number, c2: number) => {
    for (let r = r1; r <= r2; r++)
      for (let c = c1; c <= c2; c++) ws.getCell(r, c).border = { top: thin, left: thin, bottom: thin, right: thin };
  };
  // Ghi 1 ô (gộp nếu cần) + kẻ khung.
  const put = (r1: number, c1: number, r2: number, c2: number, value: string | number | null, s: Style = {}) => {
    if (r2 > r1 || c2 > c1) ws.mergeCells(r1, c1, r2, c2);
    const cell = ws.getCell(r1, c1);
    cell.value = value === null || value === "" ? null : value;
    style(r1, c1, s);
    if (s.fill) for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) style(r, c, s);
    if (s.border !== false) border(r1, c1, r2, c2);
  };
  // Chiều cao dòng ước theo số ký tự / bề rộng ô gộp.
  const fitHeight = (r: number, texts: { text: string; cols: number }[], min = 15) => {
    let lines = 1;
    texts.forEach(({ text, cols }) => {
      const w = Math.max(6, cols * COLW * 1.05);
      const n = String(text || "")
        .split("\n")
        .reduce((a, seg) => a + Math.max(1, Math.ceil(seg.length / w)), 0);
      lines = Math.max(lines, n);
    });
    ws.getRow(r).height = Math.max(min, lines * 13 + 3);
  };

  const p = m.project;
  const rep = m.report;

  // ─── Đầu trang (dòng 1–3) ───
  put(1, 1, 3, 1, null, {});
  put(1, 2, 3, 4, COMPANY_NAME, { bold: true, h: "center", color: "FF1F3864" });
  put(1, 5, 1, C - 2, "BÁO CÁO NGÀY", { bold: true, size: 16, h: "center" });
  put(2, 5, 3, C - 2, formatDate(m.date), { bold: true, size: 14, h: "center" });
  put(1, C - 1, 1, C, "THỜI TIẾT", { bold: true, h: "center" });
  put(2, C - 1, 2, C - 1, "Sáng:", { bold: true });
  put(2, C, 2, C, rep?.weather_am || "", { h: "center" });
  put(3, C - 1, 3, C - 1, "Chiều:", { bold: true });
  put(3, C, 3, C, rep?.weather_pm || "", { h: "center" });
  ws.getRow(1).height = 22;
  ws.getRow(2).height = 18;
  ws.getRow(3).height = 18;
  try {
    const logo = await imageToJpeg("/logo-tnec.png", 300);
    if (logo) {
      const id = wb.addImage({ base64: logo.base64, extension: "jpeg" });
      ws.addImage(id, { tl: { col: 0.15, row: 0.15 }, ext: { width: 70, height: 70 * (logo.h / logo.w) } });
    }
  } catch {
    /* thiếu logo không chặn xuất */
  }

  let r = 4;
  const infoRow = (label: string, value: string) => {
    put(r, 1, r, 2, label, { bold: true });
    put(r, 3, r, C, value || "....", { bold: true });
    fitHeight(r, [{ text: value, cols: C - 2 }], 18);
    r++;
  };
  infoRow("Dự án :", p.name);
  infoRow("Gói thầu :", p.package_name || "");
  infoRow("Địa điểm :", p.location || "");
  infoRow("Hình thức thi công/Quản lý", rep?.method || "");

  const section = (title: string) => {
    put(r, 1, r, C, title, { bold: true, h: "center", fill: GREEN });
    ws.getRow(r).height = 18;
    r++;
  };

  // ─── I. NHÀ THẦU PHỤ ───
  section("I. NHÀ THẦU PHỤ");
  const subs = m.subs;
  put(r, 1, r + 1, 1, "Tên đơn vị", { bold: true, h: "center" });
  const nom = subs.filter((u) => u.group === "NOMINAL").length;
  const non = subs.length - nom;
  let c = 2;
  if (nom) {
    put(r, c, r, c + nom - 1, "THẦU PHỤ CHÍNH DANH", { bold: true, h: "center" });
    c += nom;
  }
  if (non) {
    put(r, c, r, c + non - 1, "THẦU PHỤ Lodeza EOP", { bold: true, h: "center" });
    c += non;
  }
  if (c <= C) put(r, c, r, C, subs.length ? "" : "Chưa có hợp đồng B-B'", { italic: true, h: "center" });
  subs.forEach((u, i) => put(r + 1, 2 + i, r + 1, 2 + i, u.name, { bold: true, h: "center" }));
  for (let x = 2 + subs.length; x <= C; x++) put(r + 1, x, r + 1, x, "…", { bold: true, h: "center" });
  fitHeight(r + 1, subs.map((u) => ({ text: u.name, cols: 1 })), 30);
  r += 2;
  put(r, 1, r, 1, "Phạm vi công việc", { bold: true, h: "center" });
  subs.forEach((u, i) => put(r, 2 + i, r, 2 + i, u.scope, { v: "middle" }));
  for (let x = 2 + subs.length; x <= C; x++) put(r, x, r, x, "", {});
  fitHeight(r, subs.map((u) => ({ text: u.scope, cols: 1 })), 30);
  r++;
  // Thời gian thi công
  const st = m.stats;
  put(r, 1, r, 2, "Thời gian thi công", { bold: true, h: "center" });
  put(r, 3, r, 3, p.start_date && p.finish_date ? `Từ ${formatDate(p.start_date)}\nĐến ${formatDate(p.finish_date)}` : "Chưa có ngày KC/HT", { bold: true, h: "center" });
  put(r, 4, r, 4, "Thời gian còn lại:", { bold: true });
  put(r, 5, r, 5, st ? st.remaining : null, { bold: true, h: "center" });
  put(r, 6, r, 6, "Thời gian thực hiện :", { bold: true });
  put(r, 7, r, 7, st ? st.elapsed : null, { bold: true, h: "center" });
  put(r, 8, r, 8, "Tỷ lệ thời gian thực hiện :", { bold: true });
  put(r, 9, r, C, st ? st.ratio : null, { bold: true, h: "center", numFmt: "0.00%" });
  ws.getRow(r).height = 58;
  r++;

  // ─── II. NHÂN LỰC, THIẾT BỊ/MÁY MÓC ───
  section("II. NHÂN LỰC, THIẾT BỊ/MÁY MÓC");
  const units = m.units;
  put(r, 1, r, 1, "Nội dung", { bold: true, h: "center" });
  units.forEach((u, i) => put(r, 2 + i, r, 2 + i, u.name, { bold: true, h: "center" }));
  for (let x = 2 + units.length; x <= C; x++) put(r, x, r, x, "…", { bold: true, h: "center" });
  fitHeight(r, units.map((u) => ({ text: u.name, cols: 1 })), 30);
  r++;
  const matrix = (title: string, keys: string[], pick: (u: DailyUnit) => Record<string, number>, grand: number) => {
    put(r, 1, r, C - 1, title, { bold: true, h: "center" });
    put(r, C, r, C, grand, { bold: true, italic: true, h: "center" });
    r++;
    // Chức danh / loại máy ngoài danh sách chuẩn (nếu có) nối vào cuối.
    const extra = new Set<string>();
    units.forEach((u) => Object.keys(pick(u) || {}).forEach((k) => !keys.includes(k) && Number(pick(u)[k]) && extra.add(k)));
    [...keys, ...extra].forEach((k) => {
      put(r, 1, r, 1, k, { h: "center" });
      units.forEach((u, i) => {
        const v = Number(pick(u)?.[k] || 0);
        put(r, 2 + i, r, 2 + i, v || null, { h: "center" });
      });
      for (let x = 2 + units.length; x <= C; x++) put(r, x, r, x, null, {});
      r++;
    });
    put(r, 1, r, 1, "Tổng", { bold: true, italic: true, h: "center" });
    units.forEach((u, i) => put(r, 2 + i, r, 2 + i, sumRecord(pick(u)), { bold: true, italic: true, h: "center" }));
    for (let x = 2 + units.length; x <= C; x++) put(r, x, r, x, 0, { bold: true, italic: true, h: "center" });
    ws.getRow(r).height = 18;
    r++;
  };
  matrix("1. Nhân sự", MANPOWER_ROLES, (u) => u.manpower, m.manpowerTotal);
  matrix("2. Máy móc / thiết bị", EQUIPMENT_TYPES, (u) => u.equipment, m.equipmentTotal);

  // ─── III. CÔNG VIỆC THỰC HIỆN ───
  section("III. CÔNG VIỆC THỰC HIỆN");
  const hl = Math.floor(half / 2);
  put(r, 1, r, 1, "Đơn vị", { bold: true, fill: GREEN });
  put(r, L1, r, L1 + hl - 1, "Hôm nay:", { bold: true, fill: GREEN });
  put(r, L1 + hl, r, L2, formatDate(m.date), { bold: true, h: "center", fill: GREEN });
  put(r, R1, r, R1 + hl - 1, "Ngày mai:", { bold: true, fill: GREEN });
  put(r, R1 + hl, r, R2, formatDate(m.tomorrow), { bold: true, h: "center", fill: GREEN });
  r++;

  // Ảnh: tải trước để biết tỉ lệ.
  const colPx = (w: number) => Math.round(w * 7 + 5);
  const halfPx = colPx(COLW) * half;
  const PHOTO_ROW_PT = 150;
  const photoPx = Math.round((PHOTO_ROW_PT * 4) / 3);

  for (const u of units) {
    const tl = m.todayLines.get(u.key) || [];
    const tm = m.tomorrowLines.get(u.key) || [];
    const n = Math.max(1, tl.length, tm.length);
    const photos: { base64: string; w: number; h: number }[] = [];
    for (const ph of u.photos) {
      const url = await resolveLogPhotoUrl(ph.path);
      const img = url ? await imageToJpeg(url) : null;
      if (img) photos.push(img);
    }
    const photoRows = Math.ceil(photos.length / 2);
    const start = r;
    for (let i = 0; i < n; i++) {
      const a = tl[i] ?? (i === 0 && !tl.length ? "…" : "");
      const b = tm[i] ?? (i === 0 && !tm.length ? "…" : "");
      put(r, L1, r, L2, a, { h: a === "…" ? "center" : "left" });
      put(r, R1, r, R2, b, { h: b === "…" ? "center" : "left" });
      fitHeight(r, [{ text: a, cols: half }, { text: b, cols: half }], 18);
      r++;
    }
    for (let i = 0; i < photoRows; i++) {
      put(r, L1, r, L2, null, {});
      put(r, R1, r, R2, null, {});
      ws.getRow(r).height = PHOTO_ROW_PT;
      [photos[i * 2], photos[i * 2 + 1]].forEach((img, j) => {
        if (!img) return;
        const s = Math.min((halfPx - 10) / img.w, (photoPx - 8) / img.h);
        const w = Math.round(img.w * s);
        const h = Math.round(img.h * s);
        const id = wb.addImage({ base64: img.base64, extension: "jpeg" });
        // Canh giữa trong nửa ô: lệch theo phần cột.
        const offCols = (halfPx - w) / 2 / colPx(COLW);
        ws.addImage(id, {
          tl: { col: (j === 0 ? L1 : R1) - 1 + offCols, row: r - 1 + 0.03 },
          ext: { width: w, height: h },
        });
      });
      r++;
    }
    put(start, 1, r - 1, 1, u.name, { bold: true, h: "center", color: "FF1F3864" });
  }

  // ─── Vướng mắc / Kiến nghị ───
  put(r, 1, r, L2, "VƯỚNG MẮC", { bold: true, h: "center", fill: GREEN });
  put(r, R1, r, R2, "KIẾN NGHỊ", { bold: true, h: "center", fill: GREEN });
  r++;
  const iss = splitLines(rep?.issues);
  const pro = splitLines(rep?.proposals);
  const nIP = Math.max(1, iss.length, pro.length);
  for (let i = 0; i < nIP; i++) {
    put(r, 1, r, L2, iss[i] || "", {});
    put(r, R1, r, R2, pro[i] || "", {});
    fitHeight(r, [{ text: iss[i] || "", cols: half + 1 }, { text: pro[i] || "", cols: half }], 18);
    r++;
  }

  // ─── Chữ ký ───
  const fs = r;
  put(r, 1, r, C, null, { border: false });
  r++;
  put(r, R1 - 1, r, C, bdhTitle(p), { italic: true, h: "center", border: false });
  r++;
  put(r, R1 - 1, r, C, "Người lập báo cáo", { italic: true, h: "center", border: false });
  r++;
  for (let i = 0; i < 3; i++) ws.getRow(r++).height = 18;
  const signer = [rep?.reporter_name, rep?.reporter_title ? `(${rep.reporter_title})` : ""].filter(Boolean).join(" ");
  put(r, R1 - 1, r, C, signer, { italic: true, h: "center", border: false });
  // Khung ngoài vùng chữ ký.
  for (let x = 1; x <= C; x++) {
    ws.getCell(fs, x).border = { ...ws.getCell(fs, x).border, top: thin };
    ws.getCell(r, x).border = { ...ws.getCell(r, x).border, bottom: thin };
  }
  for (let y = fs; y <= r; y++) {
    ws.getCell(y, 1).border = { ...ws.getCell(y, 1).border, left: thin };
    ws.getCell(y, C).border = { ...ws.getCell(y, C).border, right: thin };
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const safe = (p.code || p.bdh_name || "DuAn").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").replace(/[^a-zA-Z0-9_-]+/g, "_");
  a.download = `BaoCaoNgay_${safe}_${m.date}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
