"use client";
// Tab "Bảng lương & BHXH > Lương theo KPI": nhập chỉ tiêu + doanh số đạt cho người thuộc
// phòng hưởng KPI, tự tính mức đạt / hệ số / thưởng (bảng tra kiểu VLOOKUP bên phải).
// Thưởng KPI được tab "Tính lương" dùng THAY cho Thưởng HQCV. Công thức: lib/payroll.ts.
import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { computeKpiBonus, KpiConfig } from "@/lib/payroll";
import { usePayrollKpi } from "./usePayrollKpi";
import { ContractLite, TimesheetRow, mergeDepartments, pickContract, plain, vnd } from "./PayrollCalcTab";

const LEVEL_STYLE: Record<string, string> = {
  "Vượt": "bg-emerald-100 text-emerald-700",
  "Đạt": "bg-blue-100 text-blue-700",
  "Chưa đạt": "bg-rose-100 text-rose-700",
};
const toNum = (v: string) => Number(v.replace(/\D/g, "")) || 0;

export default function PayrollKpiTab({ month, rows, contracts, departments, notify }: {
  month: string; rows: TimesheetRow[]; contracts: ContractLite[]; departments: string[];
  notify: (msg: string, type?: "success" | "error") => void;
}) {
  const { config, setConfig, entries, setEntries } = usePayrollKpi(month);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  const deptOptions = useMemo(
    () => mergeDepartments(departments, [...rows.map(r => r.department || "Chưa xếp phòng"), ...config.departments]),
    [departments, rows, config.departments]
  );

  const lines = useMemo(() => rows
    .filter(r => config.departments.includes(r.department || "Chưa xếp phòng"))
    .map(r => {
      const base = pickContract(contracts, r.employeeCode, r.name)?.base_salary_insurance || 0;
      const e = entries[r.employeeCode] || { target: 0, actual: 0 };
      return { row: r, base, ...e, kpi: base && e.target ? computeKpiBonus(base, e.target, e.actual, config) : null };
    }), [rows, contracts, entries, config]);
  const visible = lines.filter(l => !search.trim() || plain(l.row.name).includes(plain(search.trim())));
  const total = visible.reduce((s, l) => s + (l.kpi?.total || 0), 0);
  const totalIncome = visible.reduce((s, l) => s + (l.kpi ? l.base + l.kpi.total : 0), 0);

  const setEntry = (code: string, key: "target" | "actual", v: string) =>
    setEntries(prev => ({ ...prev, [code]: { ...(prev[code] || { target: 0, actual: 0 }), [key]: toNum(v) } }));
  const setCfg = (key: keyof KpiConfig, v: number) => setConfig(prev => ({ ...prev, [key]: v }));
  const toggleDept = (d: string) => setConfig(prev => ({
    ...prev, departments: prev.departments.includes(d) ? prev.departments.filter(x => x !== d) : [...prev.departments, d],
  }));

  const saveConfig = async () => {
    const { data: auth } = await supabase.auth.getUser();
    const { error } = await supabase.from("payroll_kpi_config").upsert({
      id: 1, ...config, updated_at: new Date().toISOString(), updated_by: auth.user?.email || null,
    });
    if (error) return notify("Lỗi lưu cấu hình KPI: " + error.message, "error");
    notify("Đã lưu cấu hình KPI", "success");
  };

  const saveEntries = async () => {
    if (lines.length === 0) return;
    setSaving(true);
    const { error } = await supabase.from("payroll_kpi_entries").upsert(lines.map(l => ({
      month, employee_code: l.row.employeeCode, employee_name: l.row.name, department: l.row.department,
      target: l.target, actual: l.actual, updated_at: new Date().toISOString(),
    })));
    setSaving(false);
    if (error) return notify("Lỗi lưu KPI: " + error.message, "error");
    notify(`Đã lưu KPI tháng ${month} cho ${lines.length} nhân viên`, "success");
  };

  if (!month || rows.length === 0) {
    return (
      <div className="glass bg-white rounded-2xl p-8 border border-slate-200/50 shadow-premium text-center text-xs font-semibold text-slate-500">
        Chưa nạp bảng công. Vào <b>Chấm công › Lấy ngày công máy chấm công</b>, mở bảng công tháng cần tính lương, rồi quay lại tab này.
      </div>
    );
  }

  const th = "py-3 px-2 whitespace-nowrap";
  const td = "py-2.5 px-2 whitespace-nowrap text-right";
  const cfgInput = "w-20 text-right border border-slate-200 rounded px-1.5 py-1 bg-white font-bold";
  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_300px] gap-4 items-start">
      <div className="glass bg-white rounded-2xl p-6 border border-slate-200/50 shadow-premium space-y-4 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <h3 className="font-heading font-extrabold text-slate-800 text-sm">LƯƠNG THEO KPI THÁNG {month}</h3>
            <p className="text-slate-400 text-[10px] font-semibold mt-0.5">
              Thưởng KPI = Hệ số × Lương CB + {Math.round(config.over_rate * 100)}% doanh số vượt · thay cho Thưởng HQCV ở tab Tính lương
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Tìm họ và tên..."
              className="border border-slate-200 rounded-lg px-3 py-1.5 bg-white w-52 font-semibold" />
            <button onClick={saveEntries} disabled={saving || lines.length === 0}
              className="px-3 py-1.5 rounded-lg bg-[#005BAC] text-white hover:bg-[#004a8c] disabled:opacity-40 cursor-pointer">
              {saving ? "Đang lưu..." : "Lưu KPI tháng"}
            </button>
          </div>
        </div>
        {config.departments.length === 0 ? (
          <p className="text-center text-xs font-semibold text-amber-600 py-6">Chưa chọn phòng hưởng KPI — tick phòng ở khung “Cấu hình KPI” bên phải rồi bấm Lưu cấu hình.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="bg-emerald-600 text-white font-extrabold uppercase tracking-wider text-[10px]">
                  <th className={th}>Họ và tên</th>
                  <th className={th + " text-right"}>Lương CB</th>
                  <th className={th + " text-right"}>Chỉ tiêu KPI</th>
                  <th className={th + " text-right"}>Doanh số đạt</th>
                  <th className={th + " text-center"}>Mức đạt</th>
                  <th className={th + " text-right"}>Hệ số</th>
                  <th className={th + " text-right"}>Thưởng vượt DS</th>
                  <th className={th + " text-right"}>Tổng thưởng KPI</th>
                  <th className={th + " text-right"} title="Lương CB (HĐ) + Tổng thưởng KPI — số thực nhận theo ngày công, phụ cấp, BH, thuế xem ở tab Tính lương">Tổng thu nhập</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                {visible.map(l => (
                  <tr key={l.row.employeeCode || l.row.name} className="hover:bg-slate-50/50">
                    <td className="py-2.5 px-2 whitespace-nowrap">
                      <div className="font-bold text-slate-800">{l.row.name}</div>
                      <div className="text-[10px] text-slate-400">{l.row.department}</div>
                    </td>
                    <td className={td}>{l.base ? vnd(l.base) : <span className="text-amber-600 text-[10px]">Chưa có trong HĐ</span>}</td>
                    {(["target", "actual"] as const).map(k => (
                      <td key={k} className="py-1.5 px-1">
                        <input value={l[k] ? vnd(l[k]) : ""} onChange={e => setEntry(l.row.employeeCode, k, e.target.value)} placeholder="0"
                          className="w-32 text-right border border-slate-200 rounded px-1.5 py-1 bg-white" />
                      </td>
                    ))}
                    <td className="py-2.5 px-2 text-center">
                      {l.kpi && <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${LEVEL_STYLE[l.kpi.level]}`}>{l.kpi.level}</span>}
                    </td>
                    <td className={td}>{l.kpi?.coef ?? ""}</td>
                    <td className={td}>{l.kpi?.overBonus ? vnd(l.kpi.overBonus) : l.kpi ? "-" : ""}</td>
                    <td className={td + " text-emerald-600 font-black"}>{l.kpi ? vnd(l.kpi.total) : ""}</td>
                    <td className={td + " text-slate-800 font-black"}>{l.kpi ? vnd(l.base + l.kpi.total) : ""}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-200 font-black text-slate-800">
                  <td className="py-3 px-2" colSpan={7}>Tổng thưởng KPI ({visible.length} người)</td>
                  <td className={td + " text-emerald-600"}>{vnd(total)}</td>
                  <td className={td}>{vnd(totalIncome)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <div className="glass bg-white rounded-2xl p-5 border border-slate-200/50 shadow-premium space-y-4 text-xs">
        <h4 className="font-heading font-extrabold text-slate-800 text-sm">Cấu hình KPI</h4>
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-emerald-600 text-white text-[10px] uppercase font-extrabold">
              <th className="py-2 px-2 text-left">Mức đạt</th><th className="py-2 px-2 text-right">Hệ số KPI</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 font-semibold">
            {([["Vượt", "coef_over"], ["Đạt", "coef_meet"], ["Chưa đạt", "coef_under"]] as const).map(([label, key]) => (
              <tr key={key}>
                <td className="py-1.5 px-2"><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${LEVEL_STYLE[label]}`}>{label}</span></td>
                <td className="py-1.5 px-2 text-right">
                  <input type="number" step="0.1" min="0" value={config[key]} onChange={e => setCfg(key, Number(e.target.value) || 0)} className={cfgInput} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <label className="flex items-center justify-between font-semibold text-slate-600">
          Ngưỡng “Đạt” (% chỉ tiêu)
          <input type="number" min="0" max="100" value={Math.round(config.meet_threshold * 100)} onChange={e => setCfg("meet_threshold", (Number(e.target.value) || 0) / 100)} className={cfgInput} />
        </label>
        <label className="flex items-center justify-between font-semibold text-slate-600">
          Thưởng vượt doanh số (%)
          <input type="number" min="0" max="100" value={Math.round(config.over_rate * 100)} onChange={e => setCfg("over_rate", (Number(e.target.value) || 0) / 100)} className={cfgInput} />
        </label>
        <p className="text-[10px] text-slate-400 leading-relaxed">
          Vượt: doanh số &gt; chỉ tiêu · Đạt: từ {Math.round(config.meet_threshold * 100)}% đến 100% · Chưa đạt: dưới {Math.round(config.meet_threshold * 100)}%.
        </p>
        <div className="space-y-1.5">
          <div className="font-bold text-slate-700">Phòng hưởng lương theo KPI</div>
          {deptOptions.map(d => (
            <label key={d} className="flex items-center gap-2 font-semibold text-slate-600 cursor-pointer">
              <input type="checkbox" checked={config.departments.includes(d)} onChange={() => toggleDept(d)} />
              {d}
            </label>
          ))}
        </div>
        <button onClick={saveConfig} className="w-full px-3 py-2 rounded-lg bg-emerald-600 text-white font-bold hover:bg-emerald-700 cursor-pointer">Lưu cấu hình</button>
      </div>
    </div>
  );
}
