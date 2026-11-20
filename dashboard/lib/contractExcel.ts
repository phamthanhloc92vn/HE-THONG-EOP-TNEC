import * as XLSX from "xlsx";

// Đọc thẳng file Excel HĐ có cột chuẩn (không cần AI). Trả về null khi không
// nhận ra bảng → nơi gọi chuyển sang AI. Kết quả cùng dạng với /api/analyze-contract-excel.

type Field =
  | "stt" | "employee_code" | "employee_name" | "department" | "onboard_date"
  | "probation_contract_number" | "probation_start_date" | "probation_end_date"
  | "type" | "contract_number" | "sign_date" | "expiration_date"
  | "base_salary_insurance" | "performance_bonus" | "allowances" | "total_income"
  | "last_salary_adj_date" | "notes";

const DATE_FIELDS = new Set<Field>(["onboard_date", "probation_start_date", "probation_end_date", "sign_date", "expiration_date", "last_salary_adj_date"]);
const MONEY_FIELDS = new Set<Field>(["base_salary_insurance", "performance_bonus", "allowances", "total_income"]);

const tokens = (s: string) =>
  s.toLowerCase().replace(/đ/g, "d").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/).filter(Boolean);

// Nhận diện tên cột → trường dữ liệu. Thứ tự kiểm tra quan trọng (cụ thể trước, chung sau).
const fieldOf = (label: string): Field | null => {
  const t = new Set(tokens(label));
  const has = (...w: string[]) => w.every(x => t.has(x));
  if (t.size === 1 && has("stt")) return "stt";
  if (has("loai")) return "type";
  if (has("tong", "nhap")) return "total_income";
  if (has("bhxh")) return "base_salary_insurance";
  if (has("thuong")) return "performance_bonus";
  if (has("phu", "cap")) return "allowances";
  if (has("ghi", "chu")) return "notes";
  if (has("dieu", "chinh")) return "last_salary_adj_date";
  if (has("hdtv") || has("thu", "viec")) {
    if (has("so")) return "probation_contract_number";
    if (has("den")) return "probation_end_date";
    if (has("tu")) return "probation_start_date";
    return null;
  }
  if (has("hdld") || has("hd") || has("hop", "dong")) {
    if (has("so")) return "contract_number";
    if (has("den") || has("het")) return "expiration_date";
    if (has("tu") || has("ky") || has("hieu", "luc")) return "sign_date";
    return null;
  }
  if (has("msnv") || has("ma", "nv") || has("ma", "nhan", "vien")) return "employee_code";
  if (has("ho", "ten") || has("ten", "nhan", "vien")) return "employee_name";
  if (has("phong", "ban") || has("bo", "phan") || has("don", "vi")) return "department";
  if (has("nhan", "viec") || has("vao", "lam")) return "onboard_date";
  return null;
};

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

const toDate = (v: unknown): string => {
  if (typeof v === "number" && v > 1) {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const s = text(v);
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/); // dd/mm/yyyy (kiểu Việt Nam)
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
};

const toMoney = (v: unknown): number | null => {
  if (typeof v === "number") return Math.round(v);
  const digits = text(v).replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : null;
};

// Map cột cho một dòng tiêu đề (có thể ghép với dòng tiêu đề phụ "Từ/Đến" bên dưới).
const mapColumns = (top: unknown[], sub?: unknown[]) => {
  const cols = new Map<number, Field>();
  let group = "";
  const width = Math.max(top.length, sub?.length || 0);
  for (let i = 0; i < width; i++) {
    const own = text(top[i]);
    if (own) group = own; // ô gộp: chỉ ô đầu có chữ → kéo sang các ô kế bên
    const subText = sub ? text(sub[i]) : "";
    const label = sub ? `${own || (subText ? group : "")} ${subText}` : own;
    const f = label.trim() ? fieldOf(label) : null;
    if (f && ![...cols.values()].includes(f)) cols.set(i, f);
  }
  return cols;
};

export const parseStandardContractExcel = (data: ArrayBuffer): any[] | null => {
  const wb = XLSX.read(data, { type: "array" });
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: "" });

  // Tìm dòng tiêu đề trong 20 dòng đầu: cách map nhận ra nhiều cột nhất
  let best: { cols: Map<number, Field>; dataStart: number } | null = null;
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    for (const [cols, dataStart] of [
      [mapColumns(rows[r]), r + 1],
      [mapColumns(rows[r], rows[r + 1] || []), r + 2],
    ] as const) {
      if (!best || cols.size > best.cols.size) best = { cols, dataStart };
    }
  }
  if (!best) return null;
  const fields = [...best.cols.values()];
  const hasPerson = fields.includes("employee_name") || fields.includes("employee_code");
  if (!hasPerson || fields.length < 4) return null;

  const contracts: any[] = [];
  let groupDept = "";
  for (const row of rows.slice(best.dataStart)) {
    const c: any = {};
    for (const [i, f] of best.cols) {
      const v = row[i];
      c[f] = DATE_FIELDS.has(f) ? toDate(v) : MONEY_FIELDS.has(f) ? toMoney(v) : text(v);
    }
    if (!c.employee_name && !c.employee_code) {
      // Dòng tiêu đề nhóm (vd "P. HÀNH CHÍNH NHÂN SỰ"): chỉ 1 ô có chữ → phòng ban cho các dòng dưới
      const filled = row.map(text).filter(Boolean);
      if (filled.length === 1 && !/^\d+$/.test(filled[0])) groupDept = filled[0];
      continue;
    }
    c.stt = c.stt ? parseInt(c.stt, 10) || null : null;
    c.department = c.department || groupDept;
    contracts.push(c);
  }
  return contracts.length ? contracts : null;
};
