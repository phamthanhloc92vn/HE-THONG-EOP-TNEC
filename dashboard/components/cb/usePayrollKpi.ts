"use client";
// Nạp cấu hình KPI + chỉ tiêu/doanh số tháng (migration 166). Dùng chung cho tab
// "Lương theo KPI" (nhập) và "Tính lương" (thay HQCV bằng thưởng KPI).
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { KpiConfig } from "@/lib/payroll";

export type KpiEntry = { target: number; actual: number };

export const KPI_CONFIG_DEFAULT: KpiConfig = {
  departments: [], coef_over: 1.8, coef_meet: 1, coef_under: 0.5, over_rate: 0.2, meet_threshold: 0.9,
};

export function usePayrollKpi(month: string) {
  const [config, setConfig] = useState<KpiConfig>(KPI_CONFIG_DEFAULT);
  const [entries, setEntries] = useState<Record<string, KpiEntry>>({});

  useEffect(() => {
    Promise.all([
      supabase.from("payroll_kpi_config").select("*").eq("id", 1).maybeSingle(),
      month ? supabase.from("payroll_kpi_entries").select("employee_code, target, actual").eq("month", month) : Promise.resolve({ data: [] }),
    ]).then(([cfg, ent]) => {
      if (cfg.data) setConfig({ ...KPI_CONFIG_DEFAULT, ...cfg.data, departments: cfg.data.departments || [] });
      const m: Record<string, KpiEntry> = {};
      (ent.data || []).forEach((r: { employee_code: string; target: number; actual: number }) => {
        m[r.employee_code] = { target: Number(r.target) || 0, actual: Number(r.actual) || 0 };
      });
      setEntries(m);
    });
  }, [month]);

  return { config, setConfig, entries, setEntries };
}
