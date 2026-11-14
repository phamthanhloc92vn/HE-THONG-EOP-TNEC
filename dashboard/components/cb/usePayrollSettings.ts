"use client";
// Nạp "Cài đặt chung" bảng lương (payroll_settings, migration 167). Chưa chạy migration
// hoặc lỗi mạng -> giữ PAYROLL_SETTINGS_DEFAULT, bảng lương vẫn tính đúng số hiện hành.
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { PAYROLL_SETTINGS_DEFAULT, PayrollSettings } from "@/lib/payroll";

export function usePayrollSettings(enabled: boolean) {
  const [settings, setSettings] = useState<PayrollSettings>(PAYROLL_SETTINGS_DEFAULT);

  useEffect(() => {
    if (!enabled) return;
    supabase.from("payroll_settings").select("*").eq("id", 1).maybeSingle().then(({ data }) => {
      if (!data) return;
      const num = (k: keyof PayrollSettings) => (data[k] === null || data[k] === undefined ? PAYROLL_SETTINGS_DEFAULT[k] : Number(data[k]));
      setSettings({
        standard_workdays: num("standard_workdays") as number,
        self_deduction: num("self_deduction") as number,
        dependent_deduction: num("dependent_deduction") as number,
        bhxh_rate: num("bhxh_rate") as number,
        bhyt_rate: num("bhyt_rate") as number,
        bhtn_rate: num("bhtn_rate") as number,
        company_insurance_rate: num("company_insurance_rate") as number,
        tax_brackets: Array.isArray(data.tax_brackets) && data.tax_brackets.length ? data.tax_brackets : PAYROLL_SETTINGS_DEFAULT.tax_brackets,
        lunch_per_day: num("lunch_per_day") as number,
        fuel_senior: num("fuel_senior") as number, phone_senior: num("phone_senior") as number,
        fuel_mid: num("fuel_mid") as number, phone_mid: num("phone_mid") as number,
        fuel_junior: num("fuel_junior") as number, phone_junior: num("phone_junior") as number,
        fuel_staff: num("fuel_staff") as number, phone_staff: num("phone_staff") as number,
      });
    });
  }, [enabled]);

  return { settings, setSettings };
}
