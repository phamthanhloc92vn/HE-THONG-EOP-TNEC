// Dựng file Excel "Danh sách thành viên dự án" (tab Thành viên > Tải Excel).
// Dùng chung cột / nhóm màu / căn lề với bản PDF (membersPdf.ts). Tạo workbook MỚI
// từ đầu — không mở file mẫu nào, nên không dính bẫy exceljs làm rơi phần của file mẫu.
// Nhận sẵn class Workbook của exceljs để chạy thử được ngoài trình duyệt.

import type { Workbook as WorkbookT, Borders, Fill } from "exceljs";
import { ALIGN, COLUMNS, GROUPS, INK, LINE, MUTED, NAVY, STATUS_COLOR, ZEBRA, type MembersPdfMeta, type MembersPdfRow } from "./membersPdf";

const argb = (hex: string) => `FF${hex.replace("#", "").toUpperCase()}`;
const fill = (hex: string): Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb: argb(hex) } });
const FONT = "Arial";

// Độ rộng cột (ký tự) — cột Vai trò / Nhiệm vụ rộng nhất vì chữ dài.
const WIDTHS = [6, 11, 16, 15, 17, 22, 22, 36, 46, 18, 13, 32, 15, 16];

export async function buildMembersWorkbook(Workbook: new () => WorkbookT, rows: MembersPdfRow[], meta: MembersPdfMeta) {
  const wb = new Workbook();
  wb.creator = "HCNS Lodeza EOP";
  const ws = wb.addWorksheet("Thành viên", {
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } },
    views: [{ state: "frozen", ySplit: 4, xSplit: 0 }],
  });
  const N = COLUMNS.length;
  ws.columns = WIDTHS.map((w) => ({ width: w }));

  // Dòng 1-2: tiêu đề + thông tin dự án (gộp ngang cả bảng).
  ws.mergeCells(1, 1, 1, N);
  const t = ws.getCell(1, 1);
  t.value = "DANH SÁCH THÀNH VIÊN DỰ ÁN";
  t.font = { name: FONT, size: 14, bold: true, color: { argb: "FFFFFFFF" } };
  t.fill = fill(NAVY);
  t.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 26;

  ws.mergeCells(2, 1, 2, N);
  const sub = ws.getCell(2, 1);
  sub.value = [meta.projectName + (meta.projectCode ? ` (${meta.projectCode})` : ""), meta.bdhName, `Ngày xuất: ${meta.today}`]
    .filter(Boolean)
    .join("   ·   ");
  sub.font = { name: FONT, size: 9, color: { argb: argb("#CFE0F3") } };
  sub.fill = fill(NAVY);
  sub.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(2).height = 18;

  // Dòng 3: nhóm cột (tông đậm). Dòng 4: tên cột (tông nhạt cùng nhóm).
  const white: Partial<Borders> = {
    left: { style: "thin", color: { argb: "FFFFFFFF" } },
    right: { style: "thin", color: { argb: "FFFFFFFF" } },
  };
  let c = 1;
  GROUPS.forEach((g) => {
    ws.mergeCells(3, c, 3, c + g.span - 1);
    const cell = ws.getCell(3, c);
    cell.value = g.label;
    cell.font = { name: FONT, size: 9, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = fill(g.dark);
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = white;
    for (let k = 0; k < g.span; k++) {
      const h = ws.getCell(4, c + k);
      h.value = COLUMNS[c + k - 1];
      h.font = { name: FONT, size: 9, bold: true, color: { argb: argb(g.dark) } };
      h.fill = fill(g.light);
      h.alignment = { horizontal: ALIGN[c + k - 1], vertical: "middle", wrapText: true };
      h.border = { bottom: { style: "medium", color: { argb: argb(NAVY) } } };
    }
    c += g.span;
  });
  ws.getRow(3).height = 18;
  ws.getRow(4).height = 30;

  // Dữ liệu từ dòng 5.
  const rowLine: Partial<Borders> = { bottom: { style: "thin", color: { argb: argb(LINE) } } };
  rows.forEach((m, i) => {
    const r = 5 + i;
    const values = [
      i + 1, meta.projectCode, meta.projectName,
      m.unitGroup, m.department, m.name, m.title,
      m.projectRole, m.duty, m.reportsTo,
      m.phone, m.email, m.statusLabel, m.roleLabel,
    ];
    values.forEach((v, j) => {
      const cell = ws.getCell(r, j + 1);
      cell.value = v === "" ? null : v;
      cell.font = { name: FONT, size: 9, color: { argb: argb(INK) } };
      cell.alignment = { horizontal: ALIGN[j], vertical: "middle", wrapText: true };
      cell.border = rowLine;
      if (i % 2 === 1) cell.fill = fill(ZEBRA);
    });
    // Tô màu theo nội dung — giống bản PDF.
    [1, 2, 3, 12].forEach((col) => (ws.getCell(r, col).font = { name: FONT, size: 9, color: { argb: argb(MUTED) } }));
    ws.getCell(r, 6).font = { name: FONT, size: 9, bold: true, color: { argb: argb(NAVY) } };
    ws.getCell(r, 7).font = { name: FONT, size: 9, color: { argb: argb("#005BAC") } };
    ws.getCell(r, 13).font = { name: FONT, size: 9, bold: true, color: { argb: argb(STATUS_COLOR[m.status] || INK) } };
    ws.getCell(r, 14).font = {
      name: FONT,
      size: 9,
      bold: m.role === "EDIT",
      color: { argb: argb(m.role === "EDIT" ? "#4338CA" : MUTED) },
    };
    // SĐT giữ dạng chữ để không mất số 0 đầu.
    ws.getCell(r, 11).numFmt = "@";
    // exceljs không tự co giãn chiều cao hàng có chữ xuống dòng -> ước theo số dòng
    // của ô dài nhất (cỡ 9 ≈ 1,1 ký tự mỗi đơn vị độ rộng cột).
    const lines = Math.max(
      1,
      ...values.map((v, j) => Math.ceil(String(v ?? "").length / Math.max(1, Math.floor(WIDTHS[j] * 1.1))))
    );
    ws.getRow(r).height = Math.max(18, lines * 12 + 6);
  });

  const last = 4 + rows.length;
  if (rows.length) {
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: last, column: N } };
    for (let j = 1; j <= N; j++) {
      const cell = ws.getCell(last, j);
      cell.border = { bottom: { style: "medium", color: { argb: argb(NAVY) } } };
    }
  }
  const foot = ws.getCell(last + 2, 1);
  foot.value = `Tổng ${rows.length} thành viên`;
  foot.font = { name: FONT, size: 9, italic: true, color: { argb: argb(MUTED) } };

  return wb;
}
