// Nội dung phiếu lương (bố cục phiếu mẫu HCNS) dùng chung cho Excel và PDF.
import type { Payslip, PayslipInput } from "@/lib/payroll";
import type { PayrollSettings } from "@/lib/payroll";

// kpiLevel: người phòng KPI — dòng thưởng ghi "Thưởng KPI" thay "Thưởng HQCV"
export type PayslipView = { name: string; role: string; department: string; month: string; input: PayslipInput; slip: Payslip; kpiLevel?: string | null; settings: PayrollSettings };
// kind: title/sub = tiêu đề phải, h = tiêu đề mục, info = thông tin cá nhân, band = dải xanh,
//       b = đậm, r = dòng con đỏ nghiêng, net = thực lĩnh
export type PayslipRowKind = "title" | "sub" | "h" | "info" | "band" | "b" | "r" | "net" | "";
export type PayslipRow = [string, string | number, PayslipRowKind];

export function payslipRows(v: PayslipView): PayslipRow[] {
  const { input: i, slip: s } = v;
  const mm = v.month.split("/")[0];
  const vnd = (n: number) => n.toLocaleString("vi-VN");
  const isKpi = i.kpiBonus !== undefined;
  const st = v.settings;
  const pct = (r: number) => `${+(r * 100).toFixed(2)}%`;
  return [
    ["PHIẾU LƯƠNG NHÂN VIÊN", "", "title"],
    [`Tháng ${v.month}`, "", "sub"],
    ["I, THÔNG TIN CÁ NHÂN:", "", "h"],
    [`Họ và tên: ${v.name}`, `Lương cơ bản: ${vnd(i.baseSalary)}`, "info"],
    [`Chức vụ: ${v.role}`, isKpi ? `Lương theo KPI — mức đạt: ${v.kpiLevel || "chưa nhập"}` : `Lương Thưởng HQCV: ${vnd(i.performanceBonus)}`, "info"],
    [`Phòng/Ban: ${v.department}`, `Ngày công T${mm}: ${i.workdays} ngày (Ngày công chuẩn: ${st.standard_workdays} ngày)`, "info"],
    [`II, CHI TIẾT LƯƠNG THÁNG ${mm}:`, "", "h"],
    ["Khoản mục", "Số tiền", "band"],
    ["Các khoản thu nhập:", "", "b"],
    [`   1. Lương cơ bản T${mm}`, s.basePay, ""],
    [isKpi ? `   2. Thưởng KPI T${mm}` : `   2. Thưởng hiệu quả công việc T${mm}`, s.bonusPay, ""],
    ["Trong đó: Các PC", s.allowances, ""],
    ["        2.1 PC Tiền ăn", i.lunch, ""],
    ["        2.2 PC xăng xe", i.fuel, ""],
    ["        2.3 PC điện thoại", i.phone, ""],
    ["   3  Tăng ca miễn thuế", i.otTaxFree, ""],
    ["   4  Tăng ca tính thuế", i.otTaxable, ""],
    ["   5  Truy lĩnh", i.backPay, ""],
    ["TỔNG THU NHẬP (1)", s.gross, "band"],
    [`6  Tổng BHXH phải đóng (${pct(st.bhxh_rate + st.bhyt_rate + st.bhtn_rate)})`, s.insurance, "b"],
    [`      6.1 BHXH (${pct(st.bhxh_rate)})`, s.bhxh, "r"],
    [`      6.2 BHYT (${pct(st.bhyt_rate)})`, s.bhyt, "r"],
    [`      6.3 BHTN (${pct(st.bhtn_rate)})`, s.bhtn, "r"],
    [`7  Thuế TNCN phát sinh T${mm}`, s.tax, "b"],
    ["    7.1 Giảm trừ bản thân", s.selfDeduction, "r"],
    ["    7.2 Giảm trừ gia cảnh", s.dependentDeduction, "r"],
    ["    7.3 Giảm trừ tiền ăn", i.lunch, "r"],
    ["    7.4 Thu nhập tính thuế: (1) – mục 6 – mục 7.1 – mục 7.2 – mục 7.3", s.taxable, "r"],
    ["8  Truy thu", i.clawback, ""],
    ["TỔNG KHẤU TRỪ (2)", s.deductions, "band"],
    ["THỰC LĨNH (1) – (2)", s.net, "net"],
  ];
}

// pdfmake doc definition. Có password -> PDF mã hoá AES-256, mở phải nhập mật khẩu.
export function payslipPdfDoc(v: PayslipView, password: string) {
  const BLUE = "#1F4E79", RED = "#C00000";
  const fmt = (b: string | number) => (typeof b === "number" ? b.toLocaleString("en-US") : b);
  const body = payslipRows(v).map(([a, b, kind]) => {
    if (kind === "title" || kind === "sub" || kind === "h") {
      return [{
        text: a, colSpan: 2, bold: true, italics: kind === "sub",
        fontSize: kind === "title" ? 16 : kind === "sub" ? 12 : 11,
        alignment: kind === "h" ? "left" : "right",
      }, {}];
    }
    const base = {
      bold: kind === "b" || kind === "band" || kind === "net" || kind === "info",
      italics: kind === "r" || kind === "info",
      color: kind === "r" ? RED : kind === "band" ? "white" : undefined,
      fillColor: kind === "band" ? BLUE : kind === "net" ? "#BFBFBF" : undefined,
      fontSize: kind === "net" ? 12 : 10,
    };
    return [
      { ...base, text: a, color: kind === "net" ? RED : base.color, alignment: kind === "band" ? "center" : "left" },
      { ...base, text: fmt(b), alignment: kind === "band" ? "center" : typeof b === "number" ? "right" : "left" },
    ];
  });
  return {
    pageSize: "A4",
    pageMargins: [36, 36, 36, 36],
    userPassword: password,
    ownerPassword: password + "#HCNS",
    permissions: { printing: "highResolution" },
    version: "1.7ext3",
    info: { title: `Phiếu lương ${v.month} - ${v.name}` },
    defaultStyle: { font: "Roboto", fontSize: 10 },
    content: [{ table: { widths: ["60%", "40%"], body }, layout: { hLineColor: "#808080", vLineColor: "#808080" } }],
  };
}

// 6 số cuối CCCD làm mật khẩu PDF (user chốt 13/11/2026); thiếu CCCD -> null, không gửi.
export function payslipPassword(cccd?: string | null): string | null {
  const digits = (cccd || "").replace(/\D/g, "");
  return digits.length >= 6 ? digits.slice(-6) : null;
}
