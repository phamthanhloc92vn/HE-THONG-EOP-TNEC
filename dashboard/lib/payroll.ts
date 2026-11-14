// ─── TÍNH LƯƠNG CỨNG THÁNG (user chốt 13/11/2026, khớp phiếu lương mẫu T9/2026) ───
// Lương cơ bản tháng = Lương CB (HĐ) / công chuẩn × ngày công (ngày lễ L đã nằm trong ngày công,
//   KHÔNG cộng thêm — user chốt 14/11/2026: phiếu T9 cộng thêm 1 ngày là C&B tính nhầm; đúng như phiếu T7)
// Thưởng HQCV tháng  = Thưởng HQCV (HĐ) / công chuẩn × ngày công, tối đa công chuẩn (không vượt mức HĐ)
// Phụ cấp: cơm = đơn giá × ngày có mặt văn phòng (trừ công tác, phép, lễ);
//          xăng/điện thoại = đủ ngưỡng công thì mức đủ, thiếu thì mức giảm.
// BHXH + BHYT + BHTN (mặc định 8% + 1,5% + 1%) trên lương đóng bảo hiểm (HĐ, không chia theo công).
// Thuế TNCN biểu lũy tiến (mặc định 2026); tiền cơm và tăng ca miễn thuế không tính thuế.

// Thông số theo luật/chính sách — sửa ở tab "Cài đặt chung" (bảng payroll_settings, migration 167).
// DEFAULT = đúng số đang áp dụng, dùng khi chưa chạy migration hoặc mất mạng.
export type TaxBracket = { upto: number | null; rate: number }; // upto null = không giới hạn
export type PayrollSettings = {
  standard_workdays: number;
  self_deduction: number;
  dependent_deduction: number;
  bhxh_rate: number;
  bhyt_rate: number;
  bhtn_rate: number;
  company_insurance_rate: number;
  tax_brackets: TaxBracket[];
  // Phụ cấp (migration 168): cơm theo ngày đi làm, xăng/ĐT cố định theo 3 cấp
  lunch_per_day: number;
  fuel_senior: number; phone_senior: number;
  fuel_mid: number; phone_mid: number;
  fuel_junior: number; phone_junior: number;
  fuel_staff: number; phone_staff: number;
};
export const PAYROLL_SETTINGS_DEFAULT: PayrollSettings = {
  standard_workdays: 26,
  self_deduction: 15_500_000,
  dependent_deduction: 6_200_000,
  bhxh_rate: 0.08,
  bhyt_rate: 0.015,
  bhtn_rate: 0.01,
  company_insurance_rate: 0.215,
  tax_brackets: [
    { upto: 10_000_000, rate: 0.05 },
    { upto: 30_000_000, rate: 0.1 },
    { upto: 60_000_000, rate: 0.2 },
    { upto: 100_000_000, rate: 0.3 },
    { upto: null, rate: 0.35 },
  ],
  lunch_per_day: 35_000,
  fuel_senior: 100_000, phone_senior: 100_000,
  fuel_mid: 100_000, phone_mid: 100_000,
  fuel_junior: 100_000, phone_junior: 100_000,
  fuel_staff: 100_000, phone_staff: 100_000,
};

// 4 cấp phụ cấp xăng/ĐT (user chốt 14/11/2026), gom từ 5 cấp của getEmployeeLevel (app/cb/page.tsx, dùng chung Phúc lợi)
export type AllowanceTier = "senior" | "mid" | "junior" | "staff";
export const ALLOWANCE_TIER_LABEL: Record<AllowanceTier, string> = {
  senior: "Cấp cao (BLĐ, GĐ, PGĐ)",
  mid: "Quản lý cấp trung (TP, PP)",
  junior: "Quản lý sơ cấp (Tổ trưởng)",
  staff: "Nhân viên",
};
export function allowanceTier(levelLabel: string): AllowanceTier {
  if (levelLabel === "Điều hành cao cấp" || levelLabel === "Quản lý cấp cao") return "senior";
  if (levelLabel === "Quản lý cấp trung") return "mid";
  if (levelLabel === "Quản lý sơ cấp") return "junior";
  return "staff";
}
// officeDays = ngày đi làm thực tế (có mặt VP, gồm OL; không tính phép/lễ/công tác)
export function computeAllowances(st: PayrollSettings, tier: AllowanceTier, officeDays: number) {
  return { lunch: Math.round(st.lunch_per_day * officeDays), fuel: st[`fuel_${tier}`], phone: st[`phone_${tier}`] };
}

export function progressiveTax(taxable: number, brackets: TaxBracket[]): number {
  let tax = 0, lower = 0;
  for (const { upto, rate } of brackets) {
    if (taxable <= lower) break;
    const upper = upto ?? Infinity;
    tax += (Math.min(taxable, upper) - lower) * rate;
    lower = upper;
  }
  return Math.round(tax);
}

export type PayslipInput = {
  baseSalary: number;        // Lương cơ bản theo HĐ (= lương đóng BH)
  performanceBonus: number;  // Thưởng HQCV theo HĐ
  workdays: number;          // Tổng ngày công (văn phòng + công tác + phép có lương)
  holidays: number;          // Số ngày lễ (L = 1, L/2 = 0,5) — chỉ để hiển thị, đã gồm trong workdays
  lunch: number;             // Phụ cấp cơm (miễn thuế)
  fuel: number;
  phone: number;
  dependents: number;
  otTaxFree: number;
  otTaxable: number;
  backPay: number;           // Truy lĩnh
  clawback: number;          // Truy thu
  kpiBonus?: number;         // Có = người phòng KPI: thưởng KPI THAY HQCV, không chia theo công
};

export function computePayslip(i: PayslipInput, st: PayrollSettings = PAYROLL_SETTINGS_DEFAULT) {
  const std = st.standard_workdays;
  const basePay = Math.round((i.baseSalary / std) * i.workdays);
  const bonusPay = i.kpiBonus !== undefined
    ? i.kpiBonus
    : Math.round((i.performanceBonus / std) * Math.min(i.workdays, std));
  const allowances = i.lunch + i.fuel + i.phone;
  const gross = basePay + bonusPay + allowances + i.otTaxFree + i.otTaxable + i.backPay;
  const bhxh = Math.round(i.baseSalary * st.bhxh_rate);
  const bhyt = Math.round(i.baseSalary * st.bhyt_rate);
  const bhtn = Math.round(i.baseSalary * st.bhtn_rate);
  const insurance = bhxh + bhyt + bhtn;
  const selfDeduction = st.self_deduction;
  const dependentDeduction = i.dependents * st.dependent_deduction;
  const taxable = Math.max(0, gross - insurance - selfDeduction - dependentDeduction - i.lunch - i.otTaxFree);
  const tax = progressiveTax(taxable, st.tax_brackets);
  const deductions = insurance + tax + i.clawback;
  return { basePay, bonusPay, allowances, gross, bhxh, bhyt, bhtn, insurance, selfDeduction, dependentDeduction, taxable, tax, deductions, net: gross - deductions };
}

export type Payslip = ReturnType<typeof computePayslip>;

// ─── LƯƠNG THEO KPI (migration 166, user chốt 13/11/2026) ───
// Vượt: doanh số > chỉ tiêu · Đạt: ≥ meetThreshold × chỉ tiêu · còn lại Chưa đạt.
// Thưởng KPI = hệ số × Lương CB (HĐ) + overRate × phần doanh số vượt. Không chia theo công.
export type KpiConfig = {
  departments: string[];
  coef_over: number;
  coef_meet: number;
  coef_under: number;
  over_rate: number;
  meet_threshold: number;
};
export type KpiLevel = "Vượt" | "Đạt" | "Chưa đạt";

export function computeKpiBonus(baseSalary: number, target: number, actual: number, cfg: KpiConfig) {
  const level: KpiLevel = actual > target ? "Vượt" : actual >= target * cfg.meet_threshold ? "Đạt" : "Chưa đạt";
  const coef = level === "Vượt" ? cfg.coef_over : level === "Đạt" ? cfg.coef_meet : cfg.coef_under;
  const coefBonus = Math.round(coef * baseSalary);
  const overBonus = level === "Vượt" ? Math.round((actual - target) * cfg.over_rate) : 0;
  return { level, coef, coefBonus, overBonus, total: coefBonus + overBonus };
}
