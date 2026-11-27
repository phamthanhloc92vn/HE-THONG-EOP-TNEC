"use client";

// ============================================================
// CARD HR — "Danh sách nhân viên chấm công GPS" (trong C&B > Chấm công).
//
// Đọc toàn bộ lượt chấm hợp lệ (gps_checkins), dựng cây thư mục theo tháng như
// bảng công Văn phòng. 2 chế độ: Tổng hợp ngày công (Tổng công/Trễ/Sớm/Tăng ca
// theo ca chuẩn từng BĐH) và Chi tiết lượt chấm (vào/ra/khoảng cách/ảnh). Gửi
// email báo cáo dùng chung API /api/send-attendance-email với bảng Văn phòng.
//
// Quyền xem/sửa/xoá do RLS quyết (migration 067): Admin hoặc cờ
// can_view_attendance_imports. Card này render bên trong khối đã gate HR.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { apiFetch } from "@/lib/apiClient";
import { useDepartments, OFFICE_LOCATION_NAME } from "@/lib/departments";
import { useConfirmBox, useNoticeBox } from "@/components/ConfirmDialog";
import {
  Fingerprint, Folder, FolderOpen, Eye, Download, Trash2, Search, Send,
  Loader2, X, MapPin, Users, CheckCircle2, ChevronDown, ChevronRight, ImageIcon, FileText, AlertCircle, AlertTriangle,
} from "lucide-react";

type SmtpConfig = { user: string; pass: string; host?: string; port?: number; secure?: boolean };

type Checkin = {
  id: string;
  user_email: string;
  employee_code: string | null;
  employee_name: string | null;
  bdh_name: string;
  kind: "in" | "out";
  captured_at: string;
  lat: number;
  lng: number;
  distance_m: number | null;
  accuracy_m: number | null;
  photo_path: string | null;
};

type DayDetail = {
  dateKey: string;      // yyyy-mm-dd
  date: string;         // dd/mm/yyyy
  dayOfWeek: string;    // Thứ Hai...
  checkin: string;      // HH:MM
  checkout: string;
  hours: number;
  late: number;         // phút
  early: number;        // phút
  overtime: number;     // giờ
  workday: number;      // công: đủ vào + ra = 1, chỉ 1 lượt = 0.5
  distanceIn: number | null;
  distanceOut: number | null;
  photoIn: string | null;
  photoOut: string | null;
  status: string;
};

type EmpSummary = {
  email: string;
  name: string;
  employeeCode: string;
  bdh: string;
  reportEmail: string;  // email nhận báo cáo theo danh bạ nhân sự (đủ email công ty + cá nhân)
  totalDays: number;
  totalLate: number;
  totalEarly: number;
  totalOvertime: number;
  details: DayDetail[];
};

const fmtDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }); // yyyy-mm-dd
const fmtMonth = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", timeZone: "Asia/Ho_Chi_Minh" });
const fmtHM = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Ho_Chi_Minh" });
const fmtWeekday = new Intl.DateTimeFormat("vi-VN", { weekday: "long", timeZone: "Asia/Ho_Chi_Minh" });

const monthKeyOf = (iso: string) => fmtMonth.format(new Date(iso)).slice(0, 7); // yyyy-mm
const dayKeyOf = (iso: string) => fmtDay.format(new Date(iso));
const hmOf = (iso: string) => fmtHM.format(new Date(iso));
const minutesOf = (iso: string) => { const s = hmOf(iso); return +s.slice(0, 2) * 60 + +s.slice(3, 5); };
const ddmmyyyy = (dayKey: string) => { const [y, m, d] = dayKey.split("-"); return `${d}/${m}/${y}`; };
const shiftMin = (s: string | null | undefined, def: number) => {
  if (!s || !/^\d{1,2}:\d{2}/.test(s)) return def;
  return +s.slice(0, 2) * 60 + +s.slice(3, 5);
};

// Dữ liệu gửi sang bảng tổng hợp ngày công của trang C&B (department = tên BĐH).
export type GpsTimesheetEmployee = {
  employeeCode: string;
  name: string;
  department: string;
  details: { date: string; dayOfWeek: string; checkin: string; checkout: string; hours: number; late: number; early: number; status: string; workday: number }[];
};

// Khớp danh bạ giống khối Văn phòng: mã NV (bỏ số 0 đầu) hoặc họ tên không dấu.
const cleanCode = (c: string | null | undefined) => String(c || "").replace(/^0+/, "").trim();
const normName = (t: string | null | undefined) => String(t || "")
  .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d")
  .replace(/[^a-z0-9\s]/g, "").trim();

const WEEKDAY_SHORT = ["CN", "Hai", "Ba", "Tư", "Năm", "Sáu", "Bảy"];
const hmToMin = (s: string) => (/^\d{1,2}:\d{2}/.test(s) ? +s.split(":")[0] * 60 + +s.split(":")[1] : null);

export default function GpsCheckinList({
  smtpConfig,
  onNeedSmtp,
  onOpenTimesheet,
}: {
  smtpConfig: SmtpConfig;
  onNeedSmtp: () => void;
  /** month dạng "MM/YYYY". Không truyền = không có quyền xem bảng tổng hợp. */
  onOpenTimesheet?: (month: string, employees: GpsTimesheetEmployee[]) => void;
}) {
  const deps = useDepartments();
  const { ask, confirmNode } = useConfirmBox();
  const { notify, noticeNode } = useNoticeBox();

  const [rows, setRows] = useState<Checkin[]>([]);
  const [shiftMap, setShiftMap] = useState<Record<string, { in: number; out: number }>>({});
  const [directory, setDirectory] = useState<{ employee_code: string | null; name: string | null; email: string | null }[]>([]);
  const [loading, setLoading] = useState(true);

  const [month, setMonth] = useState<string>("");       // yyyy-mm đang xem
  const [bdhFilter, setBdhFilter] = useState("");
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"summary" | "detail">("summary");
  const [openYears, setOpenYears] = useState<Record<string, boolean>>({});

  const [emailOverride, setEmailOverride] = useState<Record<string, string>>({});
  const [sendStatus, setSendStatus] = useState<Record<string, "sending" | "success" | "error">>({});
  const [sendMsg, setSendMsg] = useState<Record<string, string>>({});
  const [sendingAll, setSendingAll] = useState(false);
  const [detailEmp, setDetailEmp] = useState<EmpSummary | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const busyRef = useRef(false);

  // ─── Tải dữ liệu ───
  const load = useCallback(async () => {
    setLoading(true);
    const [ckRes, plRes, dirRes] = await Promise.all([
      supabase
        .from("gps_checkins")
        .select("id,user_email,employee_code,employee_name,bdh_name,kind,captured_at,lat,lng,distance_m,accuracy_m,photo_path")
        .eq("is_valid", true)
        .order("captured_at", { ascending: false })
        .limit(10000),
      supabase.from("project_locations").select("bdh_name, shift_in, shift_out"),
      supabase.from("employees_directory").select("employee_code, name, email"),
    ]);
    setDirectory((dirRes.data as { employee_code: string | null; name: string | null; email: string | null }[]) || []);
    const ck = (ckRes.data as Checkin[]) || [];
    setRows(ck);
    const sm: Record<string, { in: number; out: number }> = {};
    ((plRes.data as { bdh_name: string; shift_in: string | null; shift_out: string | null }[]) || []).forEach((p) => {
      sm[p.bdh_name] = { in: shiftMin(p.shift_in, 480), out: shiftMin(p.shift_out, 1020) };
    });
    setShiftMap(sm);
    // Mặc định mở tháng gần nhất
    if (ck.length && !month) setMonth(monthKeyOf(ck[0].captured_at));
    setLoading(false);
  }, [month]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []); // tải 1 lần khi mở card

  // Ca chuẩn: phòng ban dùng ca của "Văn phòng công ty", BĐH dùng ca của chính BĐH.
  const shiftOf = useCallback((unit: string) =>
    shiftMap[deps.phongBan.includes(unit) ? OFFICE_LOCATION_NAME : unit] || { in: 480, out: 1020 },
  [shiftMap, deps.phongBan]);

  // ─── Lọc theo BĐH + tìm kiếm (áp cho cả cây tháng lẫn bảng) ───
  const matchesFilter = useCallback((r: Checkin) => {
    if (bdhFilter && r.bdh_name !== bdhFilter) return false;
    const q = search.trim().toLowerCase();
    if (q) {
      const hay = `${r.employee_name || ""} ${r.user_email} ${r.employee_code || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }, [bdhFilter, search]);

  const filteredRows = useMemo(() => rows.filter(matchesFilter), [rows, matchesFilter]);

  // ─── Cây thư mục Năm → Tháng ───
  const tree = useMemo(() => {
    const byMonth = new Map<string, Checkin[]>();
    filteredRows.forEach((r) => {
      const mk = monthKeyOf(r.captured_at);
      if (!byMonth.has(mk)) byMonth.set(mk, []);
      byMonth.get(mk)!.push(r);
    });
    const byYear = new Map<string, { mk: string; mn: string; emps: number; lots: number }[]>();
    Array.from(byMonth.keys()).sort().reverse().forEach((mk) => {
      const [y, mn] = mk.split("-");
      const list = byMonth.get(mk)!;
      const emps = new Set(list.map((r) => r.user_email)).size;
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y)!.push({ mk, mn, emps, lots: list.length });
    });
    return Array.from(byYear.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [filteredRows]);

  // ─── Tổng hợp ngày công của 1 tháng (mk = yyyy-mm) ───
  const summarizeMonth = useCallback((mk: string): EmpSummary[] => {
    if (!mk) return [];
    const monthRows = filteredRows.filter((r) => monthKeyOf(r.captured_at) === mk);
    const byEmp = new Map<string, Checkin[]>();
    monthRows.forEach((r) => {
      if (!byEmp.has(r.user_email)) byEmp.set(r.user_email, []);
      byEmp.get(r.user_email)!.push(r);
    });
    const out: EmpSummary[] = [];
    byEmp.forEach((list, email) => {
      const last = list[0];
      const dirEmp = directory.find((e) => {
        const dc = cleanCode(e.employee_code), gc = cleanCode(last.employee_code);
        return (dc && gc && dc === gc) || (!!e.name && normName(e.name) === normName(last.employee_name));
      });
      const bdh = last.bdh_name;
      const sh = shiftOf(bdh);
      // gom theo ngày
      const byDay = new Map<string, Checkin[]>();
      list.forEach((r) => {
        const dk = dayKeyOf(r.captured_at);
        if (!byDay.has(dk)) byDay.set(dk, []);
        byDay.get(dk)!.push(r);
      });
      let totalDays = 0, totalLate = 0, totalEarly = 0, totalOvertime = 0;
      const details: DayDetail[] = [];
      Array.from(byDay.keys()).sort().forEach((dk) => {
        const dl = byDay.get(dk)!;
        const ins = dl.filter((r) => r.kind === "in").sort((a, b) => +new Date(a.captured_at) - +new Date(b.captured_at));
        const outs = dl.filter((r) => r.kind === "out").sort((a, b) => +new Date(a.captured_at) - +new Date(b.captured_at));
        const firstIn = ins[0] || null;
        const lastOut = outs[outs.length - 1] || null;
        const hasIn = !!firstIn, hasOut = !!lastOut;
        const workday = hasIn && hasOut ? 1 : (hasIn || hasOut ? 0.5 : 0);
        totalDays += workday;
        const inMin = firstIn ? minutesOf(firstIn.captured_at) : 0;
        const outMin = lastOut ? minutesOf(lastOut.captured_at) : 0;
        const late = hasIn && inMin > sh.in ? inMin - sh.in : 0;
        const early = hasOut && outMin < sh.out ? sh.out - outMin : 0;
        const ot = hasOut && outMin > sh.out ? (outMin - sh.out) / 60 : 0;
        const hours = hasIn && hasOut ? Math.max(0, Math.round(((outMin - inMin) / 60) * 10) / 10) : 0;
        totalLate += late; totalEarly += early; totalOvertime += ot;
        details.push({
          dateKey: dk,
          date: ddmmyyyy(dk),
          dayOfWeek: fmtWeekday.format(new Date((firstIn || lastOut)!.captured_at)),
          checkin: firstIn ? hmOf(firstIn.captured_at) : "",
          checkout: lastOut ? hmOf(lastOut.captured_at) : "",
          hours,
          late, early, overtime: Math.round(ot * 10) / 10,
          workday,
          distanceIn: firstIn?.distance_m ?? null,
          distanceOut: lastOut?.distance_m ?? null,
          photoIn: firstIn?.photo_path ?? null,
          photoOut: lastOut?.photo_path ?? null,
          status: "Hợp lệ (GPS)",
        });
      });
      out.push({
        email,
        name: last.employee_name || email,
        employeeCode: last.employee_code || "—",
        bdh,
        reportEmail: dirEmp?.email || "",
        totalDays,
        totalLate,
        totalEarly,
        totalOvertime: Math.round(totalOvertime * 10) / 10,
        details,
      });
    });
    return out.sort((a, b) => a.name.localeCompare(b.name, "vi"));
  }, [filteredRows, shiftOf, directory]);

  const summaries = useMemo(() => summarizeMonth(month), [summarizeMonth, month]);

  const monthLabel = month ? `${month.slice(5, 7)}/${month.slice(0, 4)}` : "";
  const validLots = useMemo(
    () => filteredRows.filter((r) => (month ? monthKeyOf(r.captured_at) === month : true)).length,
    [filteredRows, month]
  );

  // ─── Ảnh minh chứng ───
  async function openPhoto(path: string | null) {
    if (!path) return;
    const { data } = await supabase.storage.from("gps-checkins").createSignedUrl(path, 120);
    if (data?.signedUrl) setPhotoUrl(data.signedUrl);
    else notify("Không mở được ảnh (có thể đã bị xoá).", "error");
  }

  // Email nhận báo cáo: ô sửa tay (nếu có) > email trong danh bạ nhân sự.
  const recipientOf = (s: EmpSummary) => emailOverride[s.email] ?? s.reportEmail;

  // ─── Gửi email 1 người. Trả về null nếu OK, chuỗi lỗi nếu thất bại. ───
  async function sendOne(s: EmpSummary): Promise<string | null> {
    if (!smtpConfig.user || !smtpConfig.pass) { onNeedSmtp(); return "Chưa cấu hình SMTP."; }
    const recipientEmail = recipientOf(s)
      .split(",").map((x) => x.trim()).filter(Boolean).join(", ");
    if (!recipientEmail) { return "Chưa có email nhận báo cáo."; }
    setSendStatus((m) => ({ ...m, [s.email]: "sending" }));
    try {
      const res = await apiFetch("/api/send-attendance-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          smtpConfig,
          recipient: { email: recipientEmail, name: s.name, employeeCode: s.employeeCode || "—" },
          summary: { totalDays: s.totalDays, totalLate: s.totalLate, totalEarly: s.totalEarly, totalOvertime: s.totalOvertime },
          details: s.details.map((d) => ({
            date: d.date, dayOfWeek: d.dayOfWeek, checkin: d.checkin, checkout: d.checkout,
            hours: d.hours, late: d.late, early: d.early, status: d.status,
          })),
          month: monthLabel,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = data?.error || `Máy chủ trả lỗi (HTTP ${res.status}).`;
        setSendStatus((m) => ({ ...m, [s.email]: "error" }));
        setSendMsg((m) => ({ ...m, [s.email]: msg }));
        return msg;
      }
      setSendStatus((m) => ({ ...m, [s.email]: "success" }));
      setSendMsg((m) => ({ ...m, [s.email]: "" }));
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Lỗi kết nối khi gửi email.";
      setSendStatus((m) => ({ ...m, [s.email]: "error" }));
      setSendMsg((m) => ({ ...m, [s.email]: msg }));
      return msg;
    }
  }

  // Gửi 1 người từ nút ✈ — hiện popup lỗi cụ thể nếu thất bại.
  async function sendOneManual(s: EmpSummary) {
    const err = await sendOne(s);
    if (err) notify(`Gửi cho ${s.name} thất bại: ${err}`, "error");
  }

  async function sendAll() {
    if (!smtpConfig.user || !smtpConfig.pass) { onNeedSmtp(); return; }
    if (busyRef.current) return;
    busyRef.current = true;
    setSendingAll(true);
    let ok = 0, fail = 0, lastErr = "";
    for (const s of summaries) {
      if (sendStatus[s.email] === "success" || !recipientOf(s).trim()) continue;
      const err = await sendOne(s);
      if (err) { fail++; lastErr = err; } else ok++;
    }
    setSendingAll(false);
    busyRef.current = false;
    notify(
      `Đã gửi ${ok} email${fail ? `, ${fail} lỗi. Lỗi gần nhất: ${lastErr}` : "."}`,
      fail ? "error" : "success"
    );
  }

  // ─── Xuất CSV một tháng — cùng bộ cột với file "Chi tiết chấm công" của máy chấm
  // công Văn phòng: mỗi nhân sự đủ mọi ngày trong tháng, ngày không chấm ghi Ca "V". ───
  function exportMonthCsv(mk: string) {
    const [y, m] = mk.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const header = ["STT", "Mã nhân viên", "Tên nhân viên", "Phòng ban", "Ngày", "Thứ", "Giờ vào", "Giờ ra", "Trễ", "Sớm", "Công", "Tổng giờ", "Tăng ca", "Tổng toàn bộ", "Ca"];
    const lines: (string | number)[][] = [];
    summarizeMonth(mk).forEach((s) => {
      const sh = shiftOf(s.bdh);
      for (let d = 1; d <= daysInMonth; d++) {
        const dk = `${mk}-${String(d).padStart(2, "0")}`;
        const det = s.details.find((x) => x.dateKey === dk);
        const inMin = det ? hmToMin(det.checkin) : null;
        const outMin = det ? hmToMin(det.checkout) : null;
        const both = inMin != null && outMin != null;
        // Tổng giờ = phần nằm trong ca chuẩn của BĐH; Tổng toàn bộ = giờ ra − giờ vào.
        const inShift = both ? Math.max(0, Math.min(outMin, sh.out) - Math.max(inMin, sh.in)) / 60 : 0;
        const span = both ? Math.max(0, outMin - inMin) / 60 : 0;
        lines.push([
          lines.length + 1, s.employeeCode, s.name, s.bdh, ddmmyyyy(dk),
          WEEKDAY_SHORT[new Date(y, m - 1, d).getDay()],
          det?.checkin || "", det?.checkout || "",
          det?.late || 0, det?.early || 0, det?.workday || 0,
          Math.round(inShift * 100) / 100, det?.overtime || 0, Math.round(span * 100) / 100,
          det ? "HC" : "V",
        ]);
      }
    });
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = "﻿" + [header, ...lines].map((row) => row.map(esc).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `Cham_cong_GPS_${mk}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Mở bảng tổng hợp ngày công (dùng chung với Văn phòng) cho tháng đang xem.
  function openTimesheet() {
    if (!onOpenTimesheet || !month) return;
    onOpenTimesheet(
      `${month.slice(5, 7)}/${month.slice(0, 4)}`,
      summaries.map((s) => ({ employeeCode: s.employeeCode, name: s.name, department: s.bdh, details: s.details }))
    );
  }

  // ─── Xoá một tháng (kèm ảnh) ───
  function deleteMonth(mk: string) {
    const list = rows.filter((r) => monthKeyOf(r.captured_at) === mk);
    if (!list.length) return;
    ask({
      title: `Xoá dữ liệu chấm công GPS tháng ${mk.slice(5, 7)}/${mk.slice(0, 4)}?`,
      message: `${list.length} lượt chấm của ${new Set(list.map((r) => r.user_email)).size} nhân sự sẽ bị xoá vĩnh viễn (kèm ảnh).`,
      tone: "danger",
      onConfirm: async () => {
        const ids = list.map((r) => r.id);
        const paths = list.map((r) => r.photo_path).filter(Boolean) as string[];
        const { error } = await supabase.from("gps_checkins").delete().in("id", ids);
        if (error) { notify(error.message, "error"); return; }
        if (paths.length) await supabase.storage.from("gps-checkins").remove(paths);
        notify(`Đã xoá dữ liệu tháng ${mk.slice(5, 7)}/${mk.slice(0, 4)}.`, "success");
        if (month === mk) setMonth("");
        load();
      },
    });
  }

  const sendableCount = summaries.filter((s) => sendStatus[s.email] !== "success" && recipientOf(s).trim()).length;
  const missingEmailCount = summaries.filter((s) => !recipientOf(s).trim()).length;

  return (
    <div className="glass bg-white rounded-2xl p-6 border border-slate-200/50 shadow-premium space-y-5">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-slate-100 pb-4 gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-indigo-500 to-blue-500 flex items-center justify-center shadow-md shadow-blue-500/25 shrink-0">
            <Fingerprint size={19} className="text-white" />
          </div>
          <div>
            <h3 className="font-heading font-extrabold text-slate-800 text-sm">DANH SÁCH NHÂN VIÊN CHẤM CÔNG GPS</h3>
            <p className="text-slate-400 text-[10px] font-semibold mt-0.5">
              Điểm danh tại Văn phòng công ty & công trường (Ban điều hành) — tổng hợp ngày công & gửi báo cáo email.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onNeedSmtp}
            className="flex items-center gap-2 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl active:scale-95 transition-all text-xs cursor-pointer"
          >
            {smtpConfig.user ? `SMTP: ${smtpConfig.user}` : "Cấu hình gửi email"}
          </button>
          {onOpenTimesheet && month && summaries.length > 0 && (
            <button
              onClick={openTimesheet}
              className="flex items-center gap-2 px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold rounded-xl active:scale-95 transition-all text-xs cursor-pointer border border-indigo-100"
            >
              <FileText size={13} />
              Bảng tổng hợp ngày công trong tháng
            </button>
          )}
          {month && summaries.length > 0 && (
            <button
              onClick={sendAll}
              disabled={sendingAll}
              className="flex items-center gap-2 px-4 py-1.5 bg-[#005BAC] hover:bg-blue-700 text-white font-bold rounded-xl active:scale-95 transition-all text-xs cursor-pointer shadow disabled:opacity-50"
            >
              {sendingAll ? <><Loader2 size={13} className="animate-spin" /> Đang gửi...</> : <><Send size={13} /> Gửi tất cả ({sendableCount})</>}
            </button>
          )}
        </div>
      </div>

      {/* Bộ lọc */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-50 border border-slate-100 min-w-[180px] flex-1">
          <Search size={14} className="text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm theo tên / email / mã NV..."
            className="flex-1 bg-transparent text-xs font-semibold text-slate-700 placeholder:text-slate-400 focus:outline-none"
          />
        </div>
        <select
          value={bdhFilter}
          onChange={(e) => setBdhFilter(e.target.value)}
          className="text-xs font-semibold text-slate-600 bg-slate-50 border border-slate-100 rounded-xl px-3 py-2 focus:outline-none focus:border-[#00AEEF]"
        >
          <option value="">Tất cả phòng ban / BĐH</option>
          <optgroup label="Văn phòng công ty">
            {deps.phongBan.map((b) => <option key={b} value={b}>{b}</option>)}
          </optgroup>
          <optgroup label="Ban điều hành">
            {deps.bdh.map((b) => <option key={b} value={b}>{b}</option>)}
          </optgroup>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-slate-400 text-xs font-semibold">
          <Loader2 size={16} className="animate-spin" /> Đang tải dữ liệu chấm công...
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-10 text-slate-400 text-xs italic">
          Chưa có lượt chấm công GPS nào. Nhân sự BĐH chấm công tại trang “Chấm công GPS”.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Cây thư mục tháng */}
          <div className="lg:col-span-1 space-y-2">
            <p className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Thư mục theo tháng</p>
            <div className="rounded-xl border border-slate-100 bg-slate-50/50 p-2 space-y-1 max-h-[420px] overflow-y-auto">
              {tree.map(([year, months]) => {
                const open = openYears[year] ?? true;
                return (
                  <div key={year}>
                    <button
                      onClick={() => setOpenYears((o) => ({ ...o, [year]: !open }))}
                      className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-white text-xs font-bold text-slate-600"
                    >
                      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      <Folder size={13} className="text-amber-500" /> Năm {year}
                    </button>
                    {open && (
                      <div className="pl-3 space-y-1">
                        {months.map((m) => (
                          <div
                            key={m.mk}
                            className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-semibold cursor-pointer group ${
                              month === m.mk ? "bg-blue-50 text-[#005BAC] border border-blue-100" : "hover:bg-white text-slate-600 border border-transparent"
                            }`}
                          >
                            <button onClick={() => setMonth(m.mk)} className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
                              {month === m.mk ? <FolderOpen size={13} className="text-[#005BAC]" /> : <Folder size={13} className="text-slate-400" />}
                              <span className="truncate">Tháng {m.mn} · {m.emps} NS · {m.lots} lượt</span>
                            </button>
                            <button onClick={() => exportMonthCsv(m.mk)} title="Tải CSV" className="p-1 text-slate-400 hover:text-emerald-600">
                              <Download size={12} />
                            </button>
                            <button onClick={() => deleteMonth(m.mk)} title="Xoá tháng" className="p-1 text-slate-400 hover:text-rose-600">
                              <Trash2 size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 2 ô thống kê */}
            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <div className="rounded-xl bg-gradient-to-br from-indigo-500 to-blue-500 text-white p-3">
                <div className="flex items-center gap-1.5 text-[9px] font-extrabold uppercase tracking-wider opacity-90"><Users size={11} /> Nhân sự chấm</div>
                <p className="text-2xl font-black mt-1">{summaries.length}</p>
              </div>
              <div className="rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 text-white p-3">
                <div className="flex items-center gap-1.5 text-[9px] font-extrabold uppercase tracking-wider opacity-90"><CheckCircle2 size={11} /> Lượt hợp lệ</div>
                <p className="text-2xl font-black mt-1">{validLots}</p>
              </div>
            </div>
          </div>

          {/* Bảng */}
          <div className="lg:col-span-2 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-bold text-slate-600">
                  {monthLabel ? `Tháng ${monthLabel}` : "Chọn một tháng ở thư mục bên trái"}
                </p>
                {month && missingEmailCount > 0 && (
                  <span className="text-[10px] text-amber-600 font-bold bg-amber-50 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                    <AlertCircle size={10} /> Có {missingEmailCount} nhân viên chưa có email. Vui lòng cập nhật trực tiếp tại dòng tương ứng.
                  </span>
                )}
              </div>
              <div className="flex rounded-xl bg-slate-100 p-0.5 text-[11px] font-bold">
                <button onClick={() => setMode("summary")} className={`px-3 py-1 rounded-lg transition-all ${mode === "summary" ? "bg-white text-[#005BAC] shadow-sm" : "text-slate-500"}`}>Tổng hợp</button>
                <button onClick={() => setMode("detail")} className={`px-3 py-1 rounded-lg transition-all ${mode === "detail" ? "bg-white text-[#005BAC] shadow-sm" : "text-slate-500"}`}>Chi tiết</button>
              </div>
            </div>

            {!month ? (
              <div className="text-center py-10 text-slate-400 text-xs italic">Chưa chọn tháng.</div>
            ) : summaries.length === 0 ? (
              <div className="text-center py-10 text-slate-400 text-xs italic">Không có lượt chấm trong tháng này (theo bộ lọc).</div>
            ) : mode === "summary" ? (
              <div className="overflow-x-auto rounded-xl border border-slate-100">
                <table className="w-full text-xs text-left border-collapse min-w-[640px]">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-400 font-extrabold uppercase tracking-wider text-[10px]">
                      <th className="py-2.5 px-3">Mã NV / Họ tên</th>
                      <th className="py-2.5 px-3">Phòng ban / BĐH</th>
                      <th className="py-2.5 px-2 text-center">Công</th>
                      <th className="py-2.5 px-2 text-center">Trễ</th>
                      <th className="py-2.5 px-2 text-center">Sớm</th>
                      <th className="py-2.5 px-2 text-center">TC</th>
                      <th className="py-2.5 px-3">Email nhận báo cáo</th>
                      <th className="py-2.5 px-2 text-center">Gửi</th>
                      <th className="py-2.5 px-2 text-center">Hành động</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                    {summaries.map((s) => {
                      const st = sendStatus[s.email];
                      return (
                        <tr key={s.email} className="hover:bg-slate-50/50">
                          <td className="py-2.5 px-3">
                            <p className="font-bold text-slate-800">{s.name}</p>
                            <p className="text-[10px] text-slate-400">{s.employeeCode}</p>
                          </td>
                          <td className="py-2.5 px-3 text-[11px] text-slate-500">{s.bdh}</td>
                          <td className="py-2.5 px-2 text-center font-bold text-[#005BAC]">{s.totalDays}</td>
                          <td className="py-2.5 px-2 text-center text-rose-500 font-semibold">{s.totalLate || "—"}</td>
                          <td className="py-2.5 px-2 text-center text-amber-500 font-semibold">{s.totalEarly || "—"}</td>
                          <td className="py-2.5 px-2 text-center text-emerald-600 font-semibold">{s.totalOvertime || "—"}</td>
                          <td className="py-2.5 px-3">
                            <div className="relative flex items-center">
                              <input
                                value={recipientOf(s)}
                                onChange={(e) => setEmailOverride((m) => ({ ...m, [s.email]: e.target.value }))}
                                className={`w-full min-w-[150px] text-[11px] font-medium text-slate-600 bg-slate-50 border rounded-lg px-2 py-1.5 focus:outline-none ${
                                  recipientOf(s).trim() ? "border-slate-100 focus:border-[#00AEEF]" : "border-amber-300 focus:border-amber-500 pr-6"
                                }`}
                                placeholder="Nhập email thủ công..."
                              />
                              {!recipientOf(s).trim() && (
                                <AlertTriangle size={12} className="text-amber-500 absolute right-2 pointer-events-none animate-pulse" />
                              )}
                            </div>
                          </td>
                          <td className="py-2.5 px-2 text-center">
                            {st === "success" ? <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">Đã gửi</span>
                              : st === "error" ? <span title={sendMsg[s.email] || "Gửi thất bại"} className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 cursor-help">Lỗi</span>
                              : st === "sending" ? <Loader2 size={13} className="animate-spin mx-auto text-slate-400" />
                              : <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-400">Chưa</span>}
                          </td>
                          <td className="py-2.5 px-2">
                            <div className="flex items-center justify-center gap-1">
                              <button onClick={() => setDetailEmp(s)} title="Xem chi tiết" className="p-1.5 text-slate-400 hover:text-[#005BAC] hover:bg-blue-50 rounded-lg transition-all">
                                <Eye size={14} />
                              </button>
                              <button onClick={() => sendOneManual(s)} disabled={st === "sending"} title="Gửi email" className="p-1.5 text-slate-400 hover:text-[#005BAC] hover:bg-blue-50 rounded-lg transition-all disabled:opacity-50">
                                <Send size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              // Chế độ chi tiết: mỗi nhân sự một khối, các ngày
              <div className="space-y-3 max-h-[460px] overflow-y-auto pr-1">
                {summaries.map((s) => (
                  <div key={s.email} className="rounded-xl border border-slate-100 overflow-hidden">
                    <div className="bg-slate-50 px-3 py-2 flex items-center gap-2 border-b border-slate-100">
                      <span className="font-bold text-slate-700 text-xs">{s.name}</span>
                      <span className="text-[10px] text-slate-400">· {s.bdh}</span>
                    </div>
                    <table className="w-full text-[11px] text-left">
                      <thead>
                        <tr className="text-slate-400 font-bold uppercase text-[9px] tracking-wider">
                          <th className="py-1.5 px-3">Ngày</th>
                          <th className="py-1.5 px-2 text-center">Vào</th>
                          <th className="py-1.5 px-2 text-center">Ra</th>
                          <th className="py-1.5 px-2 text-center">Khoảng cách</th>
                          <th className="py-1.5 px-2 text-center">Ảnh</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {s.details.map((d) => (
                          <tr key={d.dateKey}>
                            <td className="py-1.5 px-3 text-slate-600">{d.date} <span className="text-slate-300">·</span> <span className="text-slate-400">{d.dayOfWeek}</span></td>
                            <td className="py-1.5 px-2 text-center font-mono font-bold text-emerald-600">{d.checkin || "—"}</td>
                            <td className="py-1.5 px-2 text-center font-mono font-bold text-[#005BAC]">{d.checkout || "—"}</td>
                            <td className="py-1.5 px-2 text-center text-slate-500">
                              {d.distanceIn != null ? `${Math.round(d.distanceIn)}m` : ""}
                              {d.distanceOut != null ? ` / ${Math.round(d.distanceOut)}m` : ""}
                            </td>
                            <td className="py-1.5 px-2 text-center">
                              <div className="flex items-center justify-center gap-1">
                                {d.photoIn && <button onClick={() => openPhoto(d.photoIn)} className="text-emerald-500 hover:text-emerald-700" title="Ảnh vào"><ImageIcon size={13} /></button>}
                                {d.photoOut && <button onClick={() => openPhoto(d.photoOut)} className="text-[#005BAC] hover:text-blue-700" title="Ảnh ra"><ImageIcon size={13} /></button>}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal chi tiết 1 nhân sự */}
      {detailEmp && (
        <div onClick={() => setDetailEmp(null)} className="fixed inset-0 z-[95] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-100">
              <MapPin size={16} className="text-[#005BAC]" />
              <div className="flex-1 min-w-0">
                <p className="font-heading font-extrabold text-sm text-slate-800 truncate">{detailEmp.name}</p>
                <p className="text-[11px] text-slate-400">{detailEmp.bdh} · Tháng {monthLabel}</p>
              </div>
              <button onClick={() => setDetailEmp(null)} className="text-slate-400 hover:text-rose-500"><X size={19} /></button>
            </div>
            <div className="overflow-y-auto p-4">
              <table className="w-full text-[11px] text-left">
                <thead>
                  <tr className="text-slate-400 font-bold uppercase text-[9px] tracking-wider border-b border-slate-100">
                    <th className="py-2 px-2">Ngày</th>
                    <th className="py-2 px-2 text-center">Vào</th>
                    <th className="py-2 px-2 text-center">Ra</th>
                    <th className="py-2 px-2 text-center">Giờ</th>
                    <th className="py-2 px-2 text-center">Trễ</th>
                    <th className="py-2 px-2 text-center">Sớm</th>
                    <th className="py-2 px-2 text-center">Ảnh</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 text-slate-600">
                  {detailEmp.details.map((d) => (
                    <tr key={d.dateKey}>
                      <td className="py-2 px-2">{d.date} <span className="text-slate-400">{d.dayOfWeek}</span></td>
                      <td className="py-2 px-2 text-center font-mono font-bold text-emerald-600">{d.checkin || "—"}</td>
                      <td className="py-2 px-2 text-center font-mono font-bold text-[#005BAC]">{d.checkout || "—"}</td>
                      <td className="py-2 px-2 text-center">{d.hours || "—"}</td>
                      <td className="py-2 px-2 text-center text-rose-500">{d.late || "—"}</td>
                      <td className="py-2 px-2 text-center text-amber-500">{d.early || "—"}</td>
                      <td className="py-2 px-2 text-center">
                        <div className="flex items-center justify-center gap-1">
                          {d.photoIn && <button onClick={() => openPhoto(d.photoIn)} className="text-emerald-500" title="Ảnh vào"><ImageIcon size={13} /></button>}
                          {d.photoOut && <button onClick={() => openPhoto(d.photoOut)} className="text-[#005BAC]" title="Ảnh ra"><ImageIcon size={13} /></button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Modal ảnh */}
      {photoUrl && (
        <div onClick={() => setPhotoUrl(null)} className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div onClick={(e) => e.stopPropagation()} className="relative max-w-lg w-full">
            <button onClick={() => setPhotoUrl(null)} className="absolute -top-10 right-0 text-white/80 hover:text-white"><X size={24} /></button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photoUrl} alt="Ảnh chấm công" className="w-full rounded-2xl shadow-2xl" />
          </div>
        </div>
      )}

      {confirmNode}
      {noticeNode}
    </div>
  );
}
