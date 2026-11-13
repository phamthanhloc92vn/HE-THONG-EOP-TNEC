"use client";
// Tab "Bảng lương & BHXH > Tính lương": bảng công đang nạp + HĐLĐ + định mức phụ cấp
// -> bảng lương cứng tháng, chốt vào payroll_slips (migration 165), xuất phiếu lương Excel/PDF,
// gửi phiếu PDF (khoá 6 số cuối CCCD) qua email cho từng nhân viên.
import { useEffect, useMemo, useState } from "react";
import ExcelJS from "exceljs";
import { supabase } from "@/lib/supabase";
import { apiFetch } from "@/lib/apiClient";
import { computeKpiBonus, computePayslip, KpiLevel, Payslip, PayslipInput, PayrollSettings } from "@/lib/payroll";
import { usePayrollKpi } from "./usePayrollKpi";
import { payslipRows, payslipPdfDoc, payslipPassword, PayslipView } from "@/lib/payslip";

export type TimesheetRow = { employeeCode: string; name: string; department: string; days: string[]; vanPhong: number; tongNgayCong: number };
export type ContractLite = {
  id: string; employee_code?: string; employee_name?: string; contract_number: string; sign_date: string;
  base_salary_insurance?: number | null; performance_bonus?: number | null; dependents?: number | null;
  employees?: { name: string; role?: string };
};
type Policy = { code: string; kind: "per_day" | "threshold"; per_day_amount: number | null; threshold_days: number | null; full_amount: number | null; reduced_amount: number | null };
type Manual = Pick<PayslipInput, "otTaxFree" | "otTaxable" | "backPay" | "clawback" | "dependents">;
type Line = { code: string; name: string; department: string; role: string; contract?: ContractLite; input?: PayslipInput; slip?: Payslip; email: string; cccd: string; kpi?: { level: KpiLevel | null } };
type EmployeeLite = { employee_code?: string; name: string; email?: string; cccd?: string };
type SendState = { status: "sending" | "success" | "error"; message?: string };

const MANUAL_FIELDS: { key: keyof Manual; label: string }[] = [
  { key: "dependents", label: "Người phụ thuộc" },
  { key: "otTaxFree", label: "Tăng ca miễn thuế" },
  { key: "otTaxable", label: "Tăng ca tính thuế" },
  { key: "backPay", label: "Truy lĩnh" },
  { key: "clawback", label: "Truy thu" },
];

export const vnd = (n: number) => n.toLocaleString("vi-VN");
// Phòng ban theo module Danh sách phòng ban (thứ tự ở đó), cộng phòng chỉ có trong bảng công
export const mergeDepartments = (master: string[], extra: string[]) =>
  [...master, ...Array.from(new Set(extra)).filter(d => !master.includes(d)).sort((a, b) => a.localeCompare(b, "vi"))];
const norm = (s?: string) => (s || "").toString().trim().toLowerCase();
// Tìm tên không dấu: "loc" khớp "Lộc"
export const plain = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();

const toView = (l: Line, month: string, settings: PayrollSettings): PayslipView => ({ name: l.name, role: l.role, department: l.department, month, input: l.input!, slip: l.slip!, kpiLevel: l.kpi?.level ?? undefined, settings });

// pdfmake chỉ nạp khi cần (giống MembersTab), font Roboto kèm sẵn đủ dấu tiếng Việt
async function createPayslipPdf(l: Line, month: string, settings: PayrollSettings) {
  const [pdfMake, vfsMod] = await Promise.all([import("pdfmake/build/pdfmake"), import("pdfmake/build/vfs_fonts")]);
  pdfMake.addVirtualFileSystem(vfsMod.default);
  const doc = payslipPdfDoc(toView(l, month, settings), payslipPassword(l.cccd)!);
  return pdfMake.createPdf(doc as unknown as Parameters<typeof pdfMake.createPdf>[0]);
}

// Ưu tiên HĐLĐ thật (có số + ngày ký), giống tab Hồ sơ > Hợp đồng
export const pickContract = (contracts: ContractLite[], code: string, name: string) => {
  const real = (c: ContractLite) => !!c.contract_number && !c.contract_number.startsWith("IMPORT-");
  const list = contracts.filter(c => (code && norm(c.employee_code) === norm(code)) || norm(c.employee_name) === norm(name));
  return list.find(c => real(c) && c.sign_date) || list.find(real) || list[0];
};

const holidayDays = (days: string[]) => days.reduce((s, t) => s + (t === "L" ? 1 : t === "L/2" ? 0.5 : 0), 0);

const allowance = (policies: Policy[], code: string, r: TimesheetRow) => {
  const p = policies.find(x => x.code === code);
  if (!p) return 0;
  // Cơm: ngày làm việc VP (gồm cả OL làm online thứ 7), không tính công tác/phép/lễ
  if (p.kind === "per_day") return Math.round((p.per_day_amount || 0) * r.vanPhong);
  return r.tongNgayCong >= (p.threshold_days || 0) ? p.full_amount || 0 : p.reduced_amount || 0;
};

// Xem nhanh phiếu lương (cùng nội dung với file Excel/PDF — lib/payslip.ts)
const PREVIEW_ROW: Record<string, string> = {
  title: "text-right text-base font-black text-slate-800",
  sub: "text-right italic font-bold text-slate-600",
  h: "font-black text-slate-800 pt-3",
  info: "font-bold italic text-slate-700",
  band: "bg-[#1F4E79] text-white font-black text-center",
  b: "font-bold text-slate-800",
  r: "italic text-rose-600",
  net: "bg-slate-200 font-black text-base",
  "": "text-slate-700",
};

function PayslipPreview({ view, onClose, onPdf }: { view: PayslipView; onClose: () => void; onPdf: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
          <span className="font-heading font-extrabold text-sm text-slate-800">Phiếu lương — {view.name}</span>
          <div className="flex items-center gap-2 text-xs font-bold">
            <button onClick={onPdf} className="px-3 py-1.5 rounded-lg border border-[#005BAC] text-[#005BAC] hover:bg-blue-50 cursor-pointer">Tải PDF</button>
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 cursor-pointer">Đóng</button>
          </div>
        </div>
        <div className="overflow-y-auto p-5">
          <table className="w-full text-xs border-collapse">
            <tbody>
              {payslipRows(view).map(([a, b, kind], idx) => {
                const cls = PREVIEW_ROW[kind];
                const full = kind === "title" || kind === "sub" || kind === "h";
                return (
                  <tr key={idx} className={full ? "" : "border border-slate-200"}>
                    {full ? (
                      <td colSpan={2} className={`py-1.5 px-2 ${cls}`}>{a}</td>
                    ) : (
                      <>
                        <td className={`py-1.5 px-2 border-r border-slate-200 ${cls} ${kind === "net" ? "text-rose-700" : ""}`}>{a}</td>
                        <td className={`py-1.5 px-2 ${cls} ${typeof b === "number" ? "text-right tabular-nums" : ""}`}>{typeof b === "number" ? vnd(b) : b}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function PayrollCalcTab({ month, rows, contracts, policies, employees, departments, settings, smtpConfig, onNeedSmtp, notify, askConfirm }: {
  month: string; rows: TimesheetRow[]; contracts: ContractLite[]; policies: Policy[]; employees: EmployeeLite[]; departments: string[]; settings: PayrollSettings;
  smtpConfig: { user: string; pass: string }; onNeedSmtp: () => void;
  notify: (msg: string, type?: "success" | "error") => void;
  askConfirm: (msg: string) => Promise<boolean>;
}) {
  const [sendState, setSendState] = useState<Record<string, SendState>>({});
  const [sendingAll, setSendingAll] = useState(false);
  const [dept, setDept] = useState("");
  const [search, setSearch] = useState("");
  const [manual, setManual] = useState<Record<string, Partial<Manual>>>({});
  const [lockedAt, setLockedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewCode, setPreviewCode] = useState<string | null>(null);
  const { config: kpiConfig, entries: kpiEntries } = usePayrollKpi(month);

  // Nạp số nhập tay đã chốt của tháng (nếu có)
  useEffect(() => {
    if (!month) return;
    supabase.from("payroll_slips").select("employee_code, data, updated_at").eq("month", month).then(({ data }) => {
      const m: Record<string, Partial<Manual>> = {};
      (data || []).forEach(r => {
        const i = r.data?.input || {};
        m[r.employee_code] = { dependents: i.dependents, otTaxFree: i.otTaxFree, otTaxable: i.otTaxable, backPay: i.backPay, clawback: i.clawback };
      });
      setManual(m);
      setLockedAt(data && data.length ? data[0].updated_at : null);
    });
  }, [month]);

  const lines: Line[] = useMemo(() => rows.map(r => {
    const contract = pickContract(contracts, r.employeeCode, r.name);
    const emp = employees.find(e => (r.employeeCode && norm(e.employee_code) === norm(r.employeeCode))) || employees.find(e => norm(e.name) === norm(r.name));
    const base = { code: r.employeeCode, name: r.name, department: r.department || "Chưa xếp phòng", role: contract?.employees?.role || "", contract, email: emp?.email || "", cccd: emp?.cccd || "" };
    if (!contract?.base_salary_insurance) return base;
    const m = manual[r.employeeCode] || {};
    const input: PayslipInput = {
      baseSalary: contract.base_salary_insurance, performanceBonus: contract.performance_bonus || 0,
      workdays: r.tongNgayCong, holidays: holidayDays(r.days),
      lunch: allowance(policies, "lunch", r), fuel: allowance(policies, "fuel", r), phone: allowance(policies, "phone", r),
      dependents: m.dependents ?? contract.dependents ?? 0,
      otTaxFree: m.otTaxFree || 0, otTaxable: m.otTaxable || 0, backPay: m.backPay || 0, clawback: m.clawback || 0,
    };
    // Phòng hưởng KPI: thưởng KPI (tab Lương theo KPI) THAY HQCV; chưa nhập KPI -> 0
    let kpi: Line["kpi"];
    if (kpiConfig.departments.includes(base.department)) {
      const e = kpiEntries[r.employeeCode];
      const k = e?.target ? computeKpiBonus(input.baseSalary, e.target, e.actual, kpiConfig) : null;
      input.kpiBonus = k?.total ?? 0;
      kpi = { level: k?.level ?? null };
    }
    return { ...base, input, slip: computePayslip(input, settings), kpi };
  }), [rows, contracts, policies, manual, employees, kpiConfig, kpiEntries, settings]);

  const deptOptions = useMemo(() => mergeDepartments(departments, lines.map(l => l.department)), [departments, lines]);
  const visible = lines.filter(l => (!dept || l.department === dept) && (!search.trim() || plain(l.name).includes(plain(search.trim()))));
  const payable = visible.filter(l => l.slip);
  const totalNet = payable.reduce((s, l) => s + l.slip!.net, 0);

  const setField = (code: string, key: keyof Manual, v: string) =>
    setManual(prev => ({ ...prev, [code]: { ...prev[code], [key]: Number(v.replace(/\D/g, "")) || 0 } }));

  const handleLock = async () => {
    if (payable.length === 0) return;
    setSaving(true);
    const { data: auth } = await supabase.auth.getUser();
    // Số người phụ thuộc là thuộc tính của nhân viên -> ghi ngược về HĐ để tháng sau tự lấy
    const depChanged = payable.filter(l => l.input!.dependents !== (l.contract!.dependents ?? 0));
    const depResults = await Promise.all(depChanged.map(l => supabase.from("contracts").update({ dependents: l.input!.dependents }).eq("id", l.contract!.id)));
    const { error } = await supabase.from("payroll_slips").upsert(payable.map(l => ({
      month, employee_code: l.code, employee_name: l.name, department: l.department,
      data: { role: l.role, input: l.input, slip: l.slip }, locked_by: auth.user?.email || null, updated_at: new Date().toISOString(),
    })));
    setSaving(false);
    const depErr = depResults.find(r => r.error)?.error;
    if (error || depErr) return notify("Lỗi chốt lương: " + (error || depErr)!.message, "error");
    setLockedAt(new Date().toISOString());
    notify(`Đã chốt lương tháng ${month} cho ${payable.length} nhân viên`, "success");
  };

  const exportSlips = async (list: Line[]) => {
    const wb = new ExcelJS.Workbook();
    const used = new Set<string>();
    list.filter(l => l.slip).forEach(l => {
      let sheetName = l.name.replace(/[\\/?*[\]:]/g, "").slice(0, 28) || l.code;
      while (used.has(sheetName)) sheetName += "_";
      used.add(sheetName);
      const ws = wb.addWorksheet(sheetName);
      ws.columns = [{ width: 52 }, { width: 30 }];
      const border = { top: { style: "thin" as const }, bottom: { style: "thin" as const }, left: { style: "thin" as const }, right: { style: "thin" as const } };
      const blue = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF1F4E79" } };
      payslipRows(toView(l, month, settings)).forEach(([a, b, kind], idx) => {
        const row = ws.getRow(idx + 1);
        row.getCell(1).value = a;
        row.getCell(2).value = b;
        row.getCell(2).numFmt = "#,##0";
        // Chữ dài (dòng ngày công, dòng 7.4) tự xuống dòng thay vì tràn ra ngoài khung
        [1, 2].forEach(c => { row.getCell(c).border = border; row.getCell(c).alignment = { wrapText: true, vertical: "middle", horizontal: c === 2 && typeof b === "number" ? "right" : "left" }; });
        if (String(a).length > 52 || String(b).length > 32) row.height = 32; // 2 dòng
        if (kind === "title" || kind === "sub") {
          ws.mergeCells(idx + 1, 1, idx + 1, 2);
          row.getCell(1).alignment = { horizontal: "right" };
          row.getCell(1).font = { bold: true, size: kind === "title" ? 16 : 12, italic: kind === "sub" };
        } else if (kind === "h") {
          ws.mergeCells(idx + 1, 1, idx + 1, 2);
          row.getCell(1).font = { bold: true, size: 12 };
        } else if (kind === "band") {
          [1, 2].forEach(c => { row.getCell(c).fill = blue; row.getCell(c).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 12 }; row.getCell(c).alignment = { horizontal: "center" }; });
        } else if (kind === "net") {
          [1, 2].forEach(c => { row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFBFBFBF" } }; row.getCell(c).font = { bold: true, size: 13 }; });
          row.getCell(1).font = { bold: true, size: 13, color: { argb: "FFC00000" } };
        } else if (kind === "r") {
          [1, 2].forEach(c => { row.getCell(c).font = { italic: true, color: { argb: "FFC00000" } }; });
        } else if (kind === "b") {
          [1, 2].forEach(c => { row.getCell(c).font = { bold: true }; });
        } else if (kind === "info") {
          [1, 2].forEach(c => { row.getCell(c).font = { bold: true, italic: true }; });
        }
      });
    });
    const blob = new Blob([await wb.xlsx.writeBuffer()], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Phieu_luong_${month.replace("/", "_")}${list.length === 1 ? "_" + list[0].code : dept ? "_" + dept : ""}.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // PDF tải về cũng khoá 6 số cuối CCCD: file có thể bị chuyển tiếp như email
  const downloadPdf = async (l: Line) => {
    if (!payslipPassword(l.cccd)) return notify(`${l.name} chưa có số CCCD trong hồ sơ — không tạo được PDF có mật khẩu.`, "error");
    await (await createPayslipPdf(l, month, settings)).download(`Phieu_luong_${month.replace("/", "_")}_${l.code}.pdf`);
  };

  const sendOne = async (l: Line) => {
    setSendState(prev => ({ ...prev, [l.code]: { status: "sending" } }));
    try {
      const pdfBase64 = await (await createPayslipPdf(l, month, settings)).getBase64();
      const res = await apiFetch("/api/send-payslip-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ smtpConfig, month, pdfBase64, recipient: { email: l.email, name: l.name, employeeCode: l.code } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gửi email thất bại!");
      setSendState(prev => ({ ...prev, [l.code]: { status: "success" } }));
    } catch (err) {
      setSendState(prev => ({ ...prev, [l.code]: { status: "error", message: err instanceof Error ? err.message : String(err) } }));
    }
  };

  // Gửi hàng loạt theo bộ lọc đang xem, giống "Gửi tất cả" của bảng công; bỏ qua người đã gửi xong
  const sendable = payable.filter(l => l.email && payslipPassword(l.cccd) && sendState[l.code]?.status !== "success");
  const missingInfo = payable.filter(l => !l.email || !payslipPassword(l.cccd));
  const handleSendAll = async () => {
    if (!smtpConfig.user || !smtpConfig.pass) return onNeedSmtp();
    if (sendable.length === 0) return notify("Không còn nhân viên nào đủ điều kiện gửi (cần email + CCCD, chưa gửi).", "error");
    if (!(await askConfirm(`Gửi phiếu lương tháng ${month} (PDF khoá 6 số cuối CCCD) cho ${sendable.length} nhân viên?`))) return;
    setSendingAll(true);
    for (const l of sendable) await sendOne(l);
    setSendingAll(false);
    notify("Đã chạy xong gửi phiếu lương hàng loạt — xem trạng thái từng dòng.", "success");
  };

  if (!month || rows.length === 0) {
    return (
      <div className="glass bg-white rounded-2xl p-8 border border-slate-200/50 shadow-premium text-center text-xs font-semibold text-slate-500">
        Chưa nạp bảng công. Vào <b>Chấm công › Lấy ngày công máy chấm công</b>, mở bảng công tháng cần tính lương (nút xem trong thư mục lưu trữ), rồi quay lại tab này.
      </div>
    );
  }

  const th = "py-3 px-2 whitespace-nowrap";
  const td = "py-2.5 px-2 whitespace-nowrap text-right";
  return (
    <div className="glass bg-white rounded-2xl p-6 border border-slate-200/50 shadow-premium space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
        <h3 className="font-heading font-extrabold text-slate-800 text-sm">BẢNG LƯƠNG THÁNG {month}</h3>
        <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Tìm họ và tên..."
            className="border border-slate-200 rounded-lg px-3 py-1.5 bg-white w-52 font-semibold"
          />
          <select value={dept} onChange={e => setDept(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1.5 bg-white">
            <option value="">Tất cả phòng ban</option>
            {deptOptions.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <button onClick={() => exportSlips(payable)} disabled={payable.length === 0} className="px-3 py-1.5 rounded-lg border border-[#005BAC] text-[#005BAC] hover:bg-blue-50 disabled:opacity-40 cursor-pointer">
            Xuất Excel ({payable.length})
          </button>
          <button
            onClick={handleSendAll}
            disabled={sendingAll}
            title={missingInfo.length ? `Thiếu email/CCCD (không gửi được): ${missingInfo.map(l => l.name).join(", ")}` : undefined}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 cursor-pointer"
          >
            {sendingAll ? "Đang gửi..." : `Gửi phiếu lương (${sendable.length})`}
          </button>
          <button onClick={handleLock} disabled={saving || payable.length === 0} className="px-3 py-1.5 rounded-lg bg-[#005BAC] text-white hover:bg-[#004a8c] disabled:opacity-40 cursor-pointer">
            {saving ? "Đang chốt..." : lockedAt ? "Chốt lại" : "Chốt lương tháng"}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs text-left border-collapse">
          <thead>
            <tr className="bg-emerald-600 text-white font-extrabold uppercase tracking-wider text-[10px]">
              <th className={th}>Họ và tên</th>
              <th className={th + " text-center"}>Công</th>
              <th className={th + " text-center"}>Lễ</th>
              <th className={th + " text-right"}>Lương CB</th>
              <th className={th + " text-right"}>HQCV / KPI</th>
              <th className={th + " text-right"}>Phụ cấp</th>
              {MANUAL_FIELDS.map(f => <th key={f.key} className={th + " text-right"}>{f.label}</th>)}
              <th className={th + " text-right"}>Tổng thu nhập</th>
              <th className={th + " text-right"}>BH ({+((settings.bhxh_rate + settings.bhyt_rate + settings.bhtn_rate) * 100).toFixed(2)}%)</th>
              <th className={th + " text-right"}>Thuế TNCN</th>
              <th className={th + " text-right"}>Thực lĩnh</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
            {visible.map(l => {
              const s = l.slip, i = l.input;
              return (
                <tr key={l.code || l.name} className="hover:bg-slate-50/50">
                  <td className="py-2.5 px-2 whitespace-nowrap">
                    {l.slip ? (
                      <button onClick={() => setPreviewCode(l.code)} title="Xem nhanh phiếu lương" className="font-bold text-slate-800 hover:text-[#005BAC] hover:underline cursor-pointer text-left">{l.name}</button>
                    ) : (
                      <div className="font-bold text-slate-800">{l.name}</div>
                    )}
                    <div className="text-[10px] text-slate-400">{l.department}</div>
                  </td>
                  {!s || !i ? (
                    <td colSpan={MANUAL_FIELDS.length + 10} className="py-2.5 px-2 text-amber-600 text-[11px]">
                      Chưa có lương cơ bản trong Hợp đồng nhân sự (mã NV {l.code || "—"}) — bỏ qua khi chốt/xuất phiếu.
                    </td>
                  ) : (
                    <>
                      <td className="py-2.5 px-2 text-center text-blue-600 font-bold">{i.workdays}</td>
                      <td className="py-2.5 px-2 text-center">{i.holidays || ""}</td>
                      <td className={td}>{vnd(s.basePay)}</td>
                      <td className={td}>
                        {vnd(s.bonusPay)}
                        {l.kpi && <div className={`text-[9px] font-bold ${l.kpi.level ? "text-emerald-600" : "text-amber-600"}`}>KPI · {l.kpi.level || "chưa nhập"}</div>}
                      </td>
                      <td className={td} title={`Cơm ${vnd(i.lunch)} · Xăng ${vnd(i.fuel)} · ĐT ${vnd(i.phone)}`}>{vnd(s.allowances)}</td>
                      {MANUAL_FIELDS.map(f => (
                        <td key={f.key} className="py-1.5 px-1">
                          <input
                            value={i[f.key] ? vnd(i[f.key]) : ""}
                            onChange={e => setField(l.code, f.key, e.target.value)}
                            placeholder="0"
                            className={`${f.key === "dependents" ? "w-10" : "w-24"} text-right border border-slate-200 rounded px-1.5 py-1 bg-white`}
                          />
                        </td>
                      ))}
                      <td className={td + " font-bold"}>{vnd(s.gross)}</td>
                      <td className={td + " text-rose-600"}>-{vnd(s.insurance)}</td>
                      <td className={td + " text-amber-600"}>-{vnd(s.tax)}</td>
                      <td className={td + " text-emerald-600 font-black"}>{vnd(s.net)}</td>
                      <td className="py-2.5 px-2 whitespace-nowrap text-[10px] font-bold">
                        <button onClick={() => exportSlips([l])} className="text-[#005BAC] hover:underline cursor-pointer mr-2">Excel</button>
                        <button onClick={() => downloadPdf(l)} className="text-[#005BAC] hover:underline cursor-pointer mr-2">PDF</button>
                        {!l.email || !payslipPassword(l.cccd) ? (
                          <span className="text-amber-600" title="Cần email và số CCCD trong Hồ sơ nhân viên để gửi">Thiếu {!l.email ? "email" : "CCCD"}</span>
                        ) : sendState[l.code]?.status === "sending" ? (
                          <span className="text-slate-400">Đang gửi...</span>
                        ) : sendState[l.code]?.status === "success" ? (
                          <span className="text-emerald-600">✓ Đã gửi</span>
                        ) : (
                          <button
                            onClick={() => (smtpConfig.user && smtpConfig.pass ? sendOne(l) : onNeedSmtp())}
                            title={sendState[l.code]?.message || `Gửi tới ${l.email}`}
                            className={`${sendState[l.code]?.status === "error" ? "text-rose-600" : "text-emerald-600"} hover:underline cursor-pointer`}
                          >
                            {sendState[l.code]?.status === "error" ? "Lỗi — gửi lại" : "Gửi mail"}
                          </button>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-200 font-black text-slate-800">
              <td className="py-3 px-2" colSpan={MANUAL_FIELDS.length + 9}>Tổng thực lĩnh ({payable.length} người có lương)</td>
              <td className={td + " text-emerald-600"}>{vnd(totalNet)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      {(() => {
        const l = previewCode ? lines.find(x => x.code === previewCode && x.slip) : undefined;
        return l ? <PayslipPreview view={toView(l, month, settings)} onClose={() => setPreviewCode(null)} onPdf={() => downloadPdf(l)} /> : null;
      })()}
    </div>
  );
}
