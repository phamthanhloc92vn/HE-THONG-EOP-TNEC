import { requireApiAuth } from "@/lib/apiAuth";
import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { htmlToText } from "@/lib/mailText";
import { getTenantConfigServer } from "@/lib/tenantConfigServer";

// ============================================================
// POST /api/send-atld-email — báo tiến độ PHIẾU XUẤT KHO BHLĐ (P. An toàn lao động).
//
//   trinh   -> thư cho TP/PP ATLĐ (cờ "Duyệt xuất kho ATLĐ"): có phiếu chờ duyệt.
//   duyet   -> thư cho NGƯỜI LẬP: phiếu đã duyệt, kho đã trừ.
//   tra_lai -> thư cho NGƯỜI LẬP: bị trả lại + lý do.
//   huy     -> thư cho NGƯỜI LẬP: phiếu đã duyệt bị huỷ + lý do.
// User chốt 02/10/2026: phiếu chờ duyệt báo cả CHUÔNG lẫn EMAIL.
//
// ⚠ MÚI GIỜ: route chạy UTC — luôn truyền timeZone "Asia/Ho_Chi_Minh".
// SMTP: biến môi trường server trước, cùng khuôn send-signing-email.
// Lỗi gửi thư KHÔNG làm hỏng thao tác ở client (client gọi kiểu chạy ngầm).
// ============================================================

const TZ = "Asia/Ho_Chi_Minh";

type Payload = {
  event: "trinh" | "duyet" | "tra_lai" | "huy";
  soPhieu?: string;
  ngay?: string;            // yyyy-mm-dd
  khachHang?: string;
  bdh?: string;
  nguoiNhan?: string;
  tongTien?: number | null;
  soDong?: number;
  creatorEmail?: string | null;
  actorName?: string;
  lyDo?: string;
  approverEmails?: string[];
  siteUrl?: string;
};

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n) ? new Intl.NumberFormat("vi-VN").format(Math.round(n)) + " đồng" : "—";

const row = (label: string, value: string) => `
  <tr style="border-bottom:1px solid #e2e8f0;">
    <td style="padding:10px 14px;width:38%;background:#f8fafc;color:#64748b;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:.03em;">${esc(label)}</td>
    <td style="padding:10px 14px;color:#1e293b;font-size:13px;font-weight:600;">${value || "—"}</td>
  </tr>`;

function shell(title: string, accent: string, bodyRows: string, note: string, cta: string, brand: string) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;">
    <div style="background:${accent};padding:20px 24px;">
      <p style="margin:0;color:#fff;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;opacity:.85;">${esc(brand)} · P. An toàn lao động</p>
      <h1 style="margin:6px 0 0;color:#fff;font-size:18px;font-weight:800;">${esc(title)}</h1>
    </div>
    <table style="width:100%;border-collapse:collapse;">${bodyRows}</table>
    ${note ? `<div style="padding:14px 24px;background:#fffbeb;border-top:1px solid #fde68a;color:#92400e;font-size:13px;font-weight:600;">${note}</div>` : ""}
    ${cta}
    <div style="padding:16px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:11px;">
      Thư tự động từ hệ thống ${esc(brand)} — vui lòng không trả lời thư này.
    </div>
  </div></body></html>`;
}

export async function POST(request: NextRequest) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const b = (await request.json()) as Payload;
    const cfg = await getTenantConfigServer();

    const user = process.env.SMTP_USER || "";
    const pass = process.env.SMTP_PASS || "";
    const host = process.env.SMTP_HOST || "smtp.gmail.com";
    const port = Number(process.env.SMTP_PORT) || 465;
    if (!user || !pass) {
      return NextResponse.json({ error: "Chưa cấu hình SMTP gửi email (biến SMTP_USER/SMTP_PASS)." }, { status: 400 });
    }
    const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass }, tls: { rejectUnauthorized: false } });

    const now = new Date().toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
    const origin = b.siteUrl || request.headers.get("origin") || process.env.NEXT_PUBLIC_SITE_URL || cfg.site_url;
    const link = `${origin}/an-toan-lao-dong?tab=issues`;
    const ngay = b.ngay ? b.ngay.split("-").reverse().join("/") : "";

    const info = [
      row("Số phiếu", esc(b.soPhieu)),
      row("Ngày xuất", esc(ngay)),
      row("Khách hàng", esc(b.khachHang)),
      row("Ban điều hành", esc(b.bdh)),
      row("Người nhận", esc(b.nguoiNhan)),
      row("Số dòng hàng", esc(b.soDong)),
      row("Tổng tiền (giá bán)", money(b.tongTien ?? null)),
      row("Thời điểm", esc(now)),
    ].join("");
    const button = `
      <div style="padding:20px 24px;text-align:center;">
        <a href="${esc(link)}" style="display:inline-block;background:#005BAC;color:#fff;text-decoration:none;padding:12px 26px;border-radius:10px;font-size:13px;font-weight:bold;">
          Mở phiếu trong hệ thống
        </a>
      </div>`;

    const sent: string[] = [];
    const failed: string[] = [];
    const send = async (to: string[], subject: string, html: string) => {
      const list = Array.from(new Set(to.filter((x) => x && x.includes("@"))));
      if (list.length === 0) return;
      try {
        await transporter.sendMail({ from: `"${cfg.company_name}" <${user}>`, to: list.join(","), subject, html, text: htmlToText(html) });
        sent.push(...list);
      } catch (e) {
        failed.push(`${list.join(",")}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    if (b.event === "trinh") {
      const title = "Có phiếu xuất kho BHLĐ chờ bạn duyệt";
      await send(
        b.approverEmails || [],
        `[${esc(b.soPhieu)}] ${title}`,
        shell(title, "#d97706", info + row("Người lập", esc(b.actorName)), "Kho chỉ bị trừ sau khi phiếu được duyệt.", button, cfg.company_name)
      );
    } else if (b.creatorEmail) {
      const meta = {
        duyet: { title: "Phiếu xuất kho đã được duyệt", accent: "#059669", note: `${esc(b.actorName)} đã duyệt — kho đã trừ theo phiếu.` },
        tra_lai: { title: "Phiếu xuất kho bị trả lại", accent: "#e11d48", note: `<strong>${esc(b.actorName)}</strong> trả lại phiếu. Lý do: ${esc(b.lyDo)}` },
        huy: { title: "Phiếu xuất kho đã bị huỷ", accent: "#64748b", note: `<strong>${esc(b.actorName)}</strong> huỷ phiếu — kho đã cộng lại. Lý do: ${esc(b.lyDo)}` },
      }[b.event];
      await send([b.creatorEmail], `[${esc(b.soPhieu)}] ${meta.title}`, shell(meta.title, meta.accent, info, meta.note, button, cfg.company_name));
    }

    return NextResponse.json({ ok: true, sent, failed });
  } catch (error: unknown) {
    console.error("Send ATLĐ email error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Lỗi gửi email" }, { status: 500 });
  }
}
