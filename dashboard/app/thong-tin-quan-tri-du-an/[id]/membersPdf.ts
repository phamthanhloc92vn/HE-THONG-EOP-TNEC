// Dựng file PDF "Danh sách thành viên dự án" (tab Thành viên > Xuất PDF). Cột, nhóm,
// màu export ra để membersXlsx.ts (Tải Excel) dùng chung — 2 file luôn khớp nhau.
// Hàm thuần — không import gì ngoài kiểu — để chạy thử được ngoài trình duyệt.
//
// Bố cục: dải tiêu đề + dòng thông tin dự án, bảng A4 ngang chia 4 NHÓM CỘT, mỗi
// nhóm một tông màu (hàng nhóm đậm, hàng tên cột nhạt cùng tông):
//   Dự án (xám xanh) · Nhân sự (xanh Lodeza EOP) · Phân công (xanh ngọc) · Liên hệ & quyền (chàm)
// Trạng thái / Quyền tô màu theo giá trị; hàng xen kẽ nền rất nhạt; chỉ kẻ ngang.

export type MembersPdfRow = {
  name: string;
  unitGroup: string;
  department: string;
  title: string;
  projectRole: string;
  duty: string;
  reportsTo: string;
  phone: string;
  email: string;
  status: string; // NOT_JOINED | JOINED | CONCURRENT | COMPANY_LEVEL
  statusLabel: string;
  role: string; // VIEW | EDIT | …
  roleLabel: string;
};

export type MembersPdfMeta = {
  projectCode: string;
  projectName: string;
  bdhName: string;
  today: string; // dd/mm/yyyy theo giờ Việt Nam
};

type Margin = [number, number, number, number];

export const INK = "#1E293B";
export const MUTED = "#64748B";
export const LINE = "#E2E8F0";
export const ZEBRA = "#F8FAFC";
export const NAVY = "#0B3D6E";

// Nhóm cột: tông đậm cho hàng nhóm, tông nhạt cho hàng tên cột.
export const GROUPS = [
  { label: "DỰ ÁN", span: 3, dark: "#475569", light: "#F1F5F9" },
  { label: "NHÂN SỰ", span: 4, dark: "#005BAC", light: "#E6F0FA" },
  { label: "PHÂN CÔNG", span: 3, dark: "#0F766E", light: "#E3F3F1" },
  { label: "LIÊN HỆ & QUYỀN", span: 4, dark: "#4338CA", light: "#ECEEFB" },
];

export const COLUMNS = [
  "STT", "Mã dự án", "Tên dự án",
  "Nhóm đơn vị", "Phòng ban/Bộ phận", "Họ và tên", "Chức danh",
  "Vai trò", "Nhiệm vụ", "Quản lý/Báo cáo",
  "SĐT", "Email", "Trạng thái", "Quyền hệ thống",
];

// Căn lề DÙNG CHUNG cho tên cột và dữ liệu (lệch nhau là nhìn bảng bị xô):
// cột ngắn căn giữa, cột chữ dài căn trái.
export const ALIGN: ("left" | "center")[] = [
  "center", "center", "left",
  "left", "left", "left", "left",
  "left", "left", "left",
  "center", "left", "center", "center",
];

export const STATUS_COLOR: Record<string, string> = {
  JOINED: "#047857",
  CONCURRENT: "#B45309",
  COMPANY_LEVEL: "#1D4ED8",
  NOT_JOINED: "#94A3B8",
};

// Email dài không có dấu cách -> tách ở "@" để xuống dòng thay vì ngắt giữa chữ.
function breakEmail(e: string): string {
  return e.length > 32 && e.includes("@") ? e.replace("@", "\n@") : e;
}

export function buildMembersPdfDoc(rows: MembersPdfRow[], meta: MembersPdfMeta) {
  const groupRow: object[] = [];
  GROUPS.forEach((g) => {
    groupRow.push({ text: g.label, colSpan: g.span, style: "group", fillColor: g.dark, verticalAlignment: "middle" });
    for (let k = 1; k < g.span; k++) groupRow.push({});
  });

  // Màu nền tên cột theo nhóm của cột đó.
  const lightOf: string[] = [];
  GROUPS.forEach((g) => {
    for (let k = 0; k < g.span; k++) lightOf.push(g.light);
  });
  const darkOf: string[] = [];
  GROUPS.forEach((g) => {
    for (let k = 0; k < g.span; k++) darkOf.push(g.dark);
  });
  const headRow = COLUMNS.map((t, i) => ({
    text: t,
    style: "th",
    alignment: ALIGN[i],
    verticalAlignment: "middle" as const,
    fillColor: lightOf[i],
    color: darkOf[i],
  }));

  const bodyRows = rows.map((m, i) => {
    const fill = i % 2 === 1 ? ZEBRA : undefined;
    let col = 0;
    const cell = (text: string, extra: object = {}) => ({
      text,
      fillColor: fill,
      alignment: ALIGN[col++],
      verticalAlignment: "middle" as const,
      ...extra,
    });
    return [
      cell(String(i + 1), { color: MUTED }),
      cell(meta.projectCode, { color: MUTED }),
      cell(meta.projectName, { color: MUTED }),
      cell(m.unitGroup),
      cell(m.department),
      cell(m.name, { bold: true, color: NAVY }),
      cell(m.title, { color: "#005BAC" }),
      cell(m.projectRole),
      cell(m.duty),
      cell(m.reportsTo),
      cell(m.phone),
      cell(breakEmail(m.email), { color: MUTED }),
      cell(m.statusLabel, { bold: true, color: STATUS_COLOR[m.status] || INK }),
      cell(m.roleLabel, { bold: m.role === "EDIT", color: m.role === "EDIT" ? "#4338CA" : MUTED }),
    ];
  });

  const subtitle = [meta.projectName + (meta.projectCode ? ` (${meta.projectCode})` : ""), meta.bdhName]
    .filter(Boolean)
    .join("  ·  ");

  return {
    pageSize: "A4" as const,
    pageOrientation: "landscape" as const,
    pageMargins: [20, 22, 20, 28] as Margin,
    info: { title: `Danh sách thành viên dự án ${meta.projectCode}` },
    defaultStyle: { fontSize: 6, lineHeight: 1.12, color: INK },
    styles: {
      group: { bold: true, fontSize: 6.3, color: "#FFFFFF", alignment: "center" as const, characterSpacing: 0.6 },
      th: { bold: true, fontSize: 6.2 },
    },
    footer: (page: number, pages: number) => ({
      columns: [
        { text: `Ngày xuất: ${meta.today}  ·  Tổng ${rows.length} thành viên`, fontSize: 6, color: MUTED },
        { text: `Trang ${page}/${pages}`, alignment: "right" as const, fontSize: 6, color: MUTED },
      ],
      margin: [20, 10, 20, 0] as Margin,
    }),
    content: [
      {
        table: {
          widths: ["*"],
          body: [
            [
              {
                stack: [
                  { text: "DANH SÁCH THÀNH VIÊN DỰ ÁN", bold: true, fontSize: 11, color: "#FFFFFF", characterSpacing: 0.8 },
                  { text: subtitle, fontSize: 7, color: "#CFE0F3", margin: [0, 2, 0, 0] as Margin },
                ],
                fillColor: NAVY,
                alignment: "center" as const,
                margin: [0, 5, 0, 5] as Margin,
              },
            ],
          ],
        },
        layout: "noBorders",
        margin: [0, 0, 0, 6] as Margin,
      },
      {
        table: {
          headerRows: 2,
          dontBreakRows: true,
          widths: [14, 30, 50, 44, 44, 56, 50, "*", "*", 52, 44, 116, 40, 42],
          body: [groupRow, headRow, ...bodyRows],
        },
        layout: {
          hLineColor: (i: number, node: { table: { body: unknown[] } }) => (i === 2 || i === node.table.body.length ? NAVY : LINE),
          hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
            i === 0 || i === 1 ? 0 : i === 2 ? 0.8 : i === node.table.body.length ? 0.8 : 0.5,
          vLineWidth: (i: number) => (i === 3 || i === 7 || i === 10 ? 0.6 : 0),
          vLineColor: () => "#FFFFFF",
          paddingLeft: () => 3,
          paddingRight: () => 3,
          paddingTop: () => 3,
          paddingBottom: () => 3,
        },
      },
    ],
  };
}
