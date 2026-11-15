import { requireApiAuth } from "@/lib/apiAuth";
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";

// ============================================================
// POST /api/export-signing-form — xuất PHIẾU TRÌNH KÝ HỒ SƠ/VĂN BẢN (.docx)
//
// Điền vào phieu_trinh_ky_ho_so_van_ban_template.docx (bản đã gắn tag từ file
// mẫu TL/BM/011 của công ty — letterhead, khung viền, ô ký tên giữ nguyên 100%).
//
// TEMPLATE CÂM, ROUTE DỰNG CHUỖI: mỗi ô giá trị trong phiếu chỉ là MỘT tag, còn
// chuỗi hiển thị đầy đủ ("10.932.743.000 đồng (A)") do route này ghép. Nhờ vậy
// đổi cách trình bày số tiền / hậu tố / tỉ lệ % chỉ sửa ở đây, không phải mở
// Word gắn lại tag — thao tác rất dễ làm hỏng định dạng.
//
// Cùng khuôn export-invoice-payment (docxtemplater + PizZip) đã chạy ổn định.
// ============================================================

// Hai biểu mẫu, chọn theo `loai` (migration 060). Cả hai đều là bản ĐÃ GẮN TAG
// sinh ra từ file gốc của công ty — letterhead, khung viền, ô ký giữ nguyên.
const TEMPLATE_HO_SO = "phieu_trinh_ky_ho_so_van_ban_template.docx";
const TEMPLATE_HOP_DONG = "phieu_trinh_ky_hop_dong_template.docx";
// Tờ trình TTr/Lodeza EOP (migration 088). Bản đã gắn tag sinh ra từ To_Trinh_2.docx của
// công ty — letterhead, footer, khung 3 ô ký giữ nguyên 100%.
const TEMPLATE_TO_TRINH = "to_trinh_2_template.docx";
// Phiếu yêu cầu HC-BM 023/PYC (migration 091). Bảng vật tư dùng VÒNG LẶP HÀNG
// `{#vatTu}` nên số dòng in ra do dữ liệu quyết định, không phải do file mẫu.
const TEMPLATE_PHIEU_YEU_CAU = "phieu_yeu_cau_template.docx";

const fmt = (n: number) => new Intl.NumberFormat("vi-VN").format(Math.round(n));

// "ngày 22 tháng 09 năm 2026" theo NGÀY LẬP PHIẾU. BẮT BUỘC ghi timeZone: route
// chạy giờ UTC nên phiếu lập sau 17h giờ VN sẽ in ra ngày hôm trước.
function ngayVN(iso: unknown): string {
  const d = iso ? new Date(String(iso)) : new Date();
  const ok = Number.isNaN(d.getTime()) ? new Date() : d;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric",
  }).formatToParts(ok);
  const g = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `ngày ${g("day")} tháng ${g("month")} năm ${g("year")}`;
}

// Số tiền -> "1.234.000 đồng (A)". Chuỗi rỗng khi không có số: để trống trong
// phiếu vẫn hơn in ra "0 đồng" ở một dòng mà kế toán chưa chốt được con số.
function money(v: unknown, suffix = ""): string {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return `${fmt(n)} đồng${suffix}`;
}

// "(C) (5%)" — chỉ thêm phần % khi thực sự có tỉ lệ.
function rateSuffix(label: string, rate: unknown, prefix = ""): string {
  const r = rate === null || rate === undefined || rate === "" ? null : Number(rate);
  if (r === null || !Number.isFinite(r)) return ` (${label})`;
  return ` (${label}) (${prefix}${r}%)`;
}

export async function POST(request: NextRequest) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json();
    const {
      donVi,
      veViec,
      noiDungTrinh,
      dotSo,
      chuDauTu,
      duAn,
      hopDongSo,
      goiThau,
      giaTriHD,
      giaTriNghiemThu,
      giuBaoHanh,
      giuLaiTungLan,
      tyLeGiuLai,
      khauTruTamUng,
      tyLeThuHoi,
      luyKeDaThanhToan,
      tamUngConLai,
      ykienQLDA,
      ykienKHDT,
      ykienGiamDoc,
    } = body;

    const loai =
      body.loai === "hop_dong" ? "hop_dong" :
      body.loai === "to_trinh" ? "to_trinh" :
      body.loai === "phieu_yeu_cau" ? "phieu_yeu_cau" : "ho_so";
    const templateFile =
      loai === "hop_dong" ? TEMPLATE_HOP_DONG :
      loai === "to_trinh" ? TEMPLATE_TO_TRINH :
      loai === "phieu_yeu_cau" ? TEMPLATE_PHIEU_YEU_CAU : TEMPLATE_HO_SO;
    const templatePath = path.join(process.cwd(), "public", "templates", templateFile);
    if (!fs.existsSync(templatePath)) {
      return NextResponse.json(
        { error: "template_not_found", fileName: templateFile },
        { status: 404 }
      );
    }

    const zip = new PizZip(fs.readFileSync(templatePath, "binary"));
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

    // ─── PHIẾU YÊU CẦU (HC-BM 023/PYC, migration 091) ───
    // Ba ô chữ + một bảng vật tư 6 cột. Lọc dòng trống và tự đánh số thứ tự để
    // phiếu in ra không có hàng thừa, cũng không phải bắt người lập gõ số TT.
    if (loai === "phieu_yeu_cau") {
      const vatTu = (Array.isArray(body.vatTu) ? body.vatTu : [])
        .filter((r: Record<string, unknown>) =>
          ["ten", "quyCach", "dvt", "soLuong", "ngayCap"]
            .some((k) => String(r?.[k] || "").trim() !== ""))
        .map((r: Record<string, unknown>, i: number) => ({
          stt: String(r?.stt || "").trim() || String(i + 1),
          ten: String(r?.ten || ""),
          quyCach: String(r?.quyCach || ""),
          dvt: String(r?.dvt || ""),
          soLuong: String(r?.soLuong || ""),
          ngayCap: String(r?.ngayCap || ""),
        }));

      doc.render({
        nguoiYeuCau: String(body.nguoiYeuCau || "").trim(),
        boPhan: String(body.boPhan || "").trim(),
        noiDungYeuCau: String(body.noiDungYeuCau || "").trim(),
        ngayThang: ngayVN(body.ngayLap),
        vatTu,
      });

      const buf = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(
            String(body.fileName || "Phieu_Yeu_Cau.docx")
          )}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    // ─── TỜ TRÌNH (TTr/Lodeza EOP, migration 088) ───
    // Tờ này là một LÁ THƯ, không có bảng số liệu: mọi câu chữ do route ghép rồi
    // đổ vào đúng 9 tag. Rẽ nhánh sớm rồi trả về luôn, như nhánh hợp đồng.
    if (loai === "to_trinh") {
      // Ngày trên đầu tờ trình = NGÀY LẬP PHIẾU (body.ngayLap), không phải ngày
      // bấm nút xuất. Bắt buộc ghi rõ timeZone: route chạy giờ UTC nên phiếu lập
      // sau 17h giờ VN sẽ in ra ngày hôm trước.
      const dLap = body.ngayLap ? new Date(String(body.ngayLap)) : new Date();
      const ngay = Number.isNaN(dLap.getTime()) ? new Date() : dLap;
      const phan = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Ho_Chi_Minh",
        day: "2-digit", month: "2-digit", year: "numeric",
      }).formatToParts(ngay);
      const lay = (t: string) => phan.find((p) => p.type === t)?.value || "";
      const nam = lay("year");

      // Số hiệu do văn thư cấp sau khi ký. Bỏ trống thì in khung sẵn "………/26/TTr/
      // Lodeza EOP" đúng như tờ giấy, để điền tay — hơn hẳn in ra một ô trắng.
      const soToTrinh =
        String(body.soToTrinh || "").trim() || `………/${nam.slice(-2)}/TTr/Lodeza EOP`;

      // Khối chi phí: 2 dòng trong CÙNG một đoạn (template bật linebreaks).
      // Tờ trình không xin tiền thì cả khối rỗng — không in dòng "0 đồng".
      const gia = body.chiPhiDuKien;
      const coGia = gia !== null && gia !== undefined && gia !== "" && Number.isFinite(Number(gia));
      const vat = body.vatPercent;
      const dienGiai = String(body.dienGiaiChiPhi || "").trim();
      const donViBaoGia = String(body.donViBaoGia || "").trim();
      const dongChiPhi = [
        donViBaoGia ? `Chi phí đơn vị ${donViBaoGia} báo giá` : coGia ? "Chi phí dự kiến" : "",
        coGia
          ? `Giá dự kiến: ${money(gia)}`
            + (vat === null || vat === undefined || vat === "" ? "" : ` (đã bao gồm thuế VAT ${vat}%)`)
            + (dienGiai ? ` — ${dienGiai}` : "")
          : dienGiai,
      ].filter(Boolean).join("\n");

      doc.render({
        soToTrinh,
        ngayThang: `Tp.HCM, ngày ${lay("day")} tháng ${lay("month")} năm ${nam}`,
        veViec: String(body.veViec || "").trim(),
        canCu: String(body.canCu || "").trim(),
        boPhan: String(body.donVi || "").trim(),
        noiDung: String(body.noiDung || "").trim(),
        chiPhi: dongChiPhi,
        kienNghi: String(body.kienNghi || "").trim(),
        // Ô "NGƯỜI TRÌNH KÝ" điền sẵn tên người lập; hai ô "TRƯỞNG BỘ PHẬN" và
        // "BAN LÃNH ĐẠO" để trắng cho người ký tự ghi, như hai mẫu kia.
        nguoiTrinh: String(body.nguoiTrinh || "").trim(),
      });

      const buf = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(
            String(body.fileName || "To_Trinh.docx")
          )}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    // ─── PHIẾU TRÌNH KÝ HỢP ĐỒNG (KHKT/BM/001) ───
    // Rẽ nhánh sớm rồi trả về luôn: bộ tag khác hẳn phiếu hồ sơ/văn bản, gộp
    // chung một lệnh render thì nửa số tag lúc nào cũng rỗng, đọc rất khó biết
    // tag nào thuộc phiếu nào.
    if (loai === "hop_dong") {
      // Bảng so sánh A-B ↔ B-B′ — SỐ DÒNG THÊM/BỚT ĐƯỢC, template dùng vòng lặp
      // hàng `{#soSanh}`. Lọc dòng trống để phiếu in ra không có hàng thừa.
      const soSanh = (Array.isArray(body.soSanh) ? body.soSanh : [])
        .filter((r: Record<string, unknown>) =>
          [r?.muc, r?.ab, r?.bb].some((v) => String(v || "").trim() !== ""))
        .map((r: Record<string, unknown>, i: number) => ({
          // Không có ký hiệu thì tự đánh a) b) c)… theo đúng tờ giấy.
          stt: String(r?.stt || "").trim() || `${String.fromCharCode(97 + i)})`,
          muc: String(r?.muc || ""),
          ab: String(r?.ab || ""),
          bb: String(r?.bb || ""),
        }));

      // "2.263.389.186 đồng (bao gồm thuế VAT 8%)" — ghép ở route chứ không bắt
      // người dùng gõ cả câu, và cũng không nhét công thức vào file Word.
      const vat = body.vatPercent;
      const giaTriHopDong = giaTriHD === null || giaTriHD === undefined || giaTriHD === ""
        ? ""
        : `${money(giaTriHD)}${vat === null || vat === undefined || vat === "" ? "" : ` (bao gồm thuế VAT ${vat}%)`}`;

      doc.render({
        donVi: donVi || "",
        duAn: duAn || "",
        goiThau: goiThau || "",
        hangMuc: body.hangMuc || "",
        hopDongSo: hopDongSo || "",
        benA: body.benA || "",
        benB: body.benB || "",
        giaTriHD: giaTriHopDong,
        soSanh,
        // Tờ này chỉ có 2 ô ý kiến: Phó Giám đốc phụ trách và Giám đốc.
        ykienPGD: ykienQLDA || ykienKHDT || "",
        ykienGiamDoc: ykienGiamDoc || "",
        // 3 ô ký: người trình điền sẵn, 2 ô còn lại để trắng cho người ký tự ghi.
        nguoiTrinh: body.nguoiTrinh || "",
        phuTrach: "",
        bldPheDuyet: "",
      });

      const buf = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(
            String(body.fileName || "Phieu_Trinh_Ky_Hop_Dong.docx")
          )}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    // Giá trị đề nghị thanh toán: ưu tiên số do người dùng chốt, không có thì
    // tự tính A-B-C-D. Người lập phiếu vẫn phải được quyền ghi đè — có đợt bị
    // trừ thêm khoản ngoài công thức.
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const tinhDeNghi =
      num(giaTriNghiemThu) - num(giuBaoHanh) - num(giuLaiTungLan) - num(khauTruTamUng);
    const deNghi = body.deNghiThanhToan ?? tinhDeNghi;

    // Dùng render(data) chứ không setData() + render(): setData đã bị đánh dấu
    // deprecated, mỗi lần xuất phiếu lại in một vệt cảnh báo kèm stack vào log
    // server. (Route export-invoice-payment cũ vẫn dùng lối cũ — không đụng.)
    doc.render({
      donVi: donVi || "",
      veViec: veViec || "",
      noiDungTrinh: noiDungTrinh || "",
      dotSo: dotSo === null || dotSo === undefined || dotSo === "" ? "" : String(dotSo),

      chuDauTu: chuDauTu || "",
      duAn: duAn || "",
      hopDongSo: hopDongSo || "",
      goiThau: goiThau || "",

      giaTriHD: money(giaTriHD),
      giaTriNghiemThu: money(giaTriNghiemThu, " (A)"),
      giuBaoHanh: money(giuBaoHanh, " (B)"),
      giuLaiTungLan: money(giuLaiTungLan, rateSuffix("C", tyLeGiuLai)),
      khauTruTamUng: money(khauTruTamUng, rateSuffix("D", tyLeThuHoi, "tỉ lệ thu hồi ~ ")),
      // Giữ nguyên chữ "A-B-C-D=" như tờ phiếu giấy để sếp đối chiếu nhanh.
      deNghiThanhToan: deNghi === "" ? "" : `A-B-C-D= ${money(deNghi)}`,
      luyKeDaThanhToan: money(luyKeDaThanhToan),
      tamUngConLai: money(tamUngConLai),

      // Bước 5 mới đổ dữ liệu thật; bây giờ để trống thì phiếu in ra vẫn có
      // 3 ô ý kiến trắng đúng như bản giấy.
      ykienQLDA: ykienQLDA || "",
      ykienKHDT: ykienKHDT || "",
      ykienGiamDoc: ykienGiamDoc || "",
      // Ô "Người trình" cuối phiếu — tên người lập, như tờ hợp đồng.
      nguoiTrinh: body.nguoiTrinh || "",
    });

    const buf = doc.getZip().generate({ type: "nodebuffer" });

    const safe = String(hopDongSo || "phieu").replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60);
    const outputFilename = `Phieu_Trinh_Ky_${safe}_Dot_${dotSo || "x"}.docx`;

    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(outputFilename)}"`,
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      },
    });
  } catch (error: unknown) {
    console.error("Export signing form error:", error);
    const msg = error instanceof Error ? error.message : "Error exporting template";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
