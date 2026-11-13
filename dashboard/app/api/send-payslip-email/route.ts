import { requireApiAuth, supabaseForCaller } from "@/lib/apiAuth";
import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { getTenantConfigServer } from "@/lib/tenantConfigServer";

// Gửi phiếu lương PDF (đã khoá mật khẩu 6 số cuối CCCD ở trình duyệt) cho 1 nhân viên.
// Cùng cách cấu hình SMTP với /api/send-attendance-email.
export async function POST(request: NextRequest) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response;

  // Chỉ nhóm làm lương được gửi phiếu lương: gọi đúng 2 hàm mà RLS của contracts /
  // payroll_slips dùng (018 + 086) để quy tắc quyền chỉ nằm một chỗ trong CSDL.
  const db = supabaseForCaller(auth.caller);
  const [admin, salary] = await Promise.all([db.rpc("is_admin_caller"), db.rpc("can_view_salary_caller")]);
  if (admin.data !== true && salary.data !== true) {
    return NextResponse.json({ error: "Bạn không có quyền gửi phiếu lương (cần cờ \"Xem lương & HĐLĐ\" hoặc Admin)." }, { status: 403 });
  }

  try {
    const { smtpConfig, recipient, month, pdfBase64 } = await request.json();
    if (!smtpConfig?.user || !smtpConfig?.pass) {
      return NextResponse.json({ error: "Cấu hình gửi email (SMTP) không đầy đủ!" }, { status: 400 });
    }
    if (!recipient?.email || !recipient?.name || !pdfBase64 || !month) {
      return NextResponse.json({ error: "Thiếu email người nhận hoặc file phiếu lương!" }, { status: 400 });
    }
    const cfg = await getTenantConfigServer();
    const port = Number(smtpConfig.port) || 465;
    const transporter = nodemailer.createTransport({
      host: smtpConfig.host || "smtp.gmail.com",
      port,
      secure: smtpConfig.secure === undefined ? port === 465 : smtpConfig.secure,
      auth: { user: smtpConfig.user, pass: smtpConfig.pass },
      tls: { rejectUnauthorized: false },
    });

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:24px auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;color:#1e293b">
        <div style="background:#1F4E79;color:#fff;padding:20px 28px">
          <div style="font-size:18px;font-weight:bold">Phiếu lương tháng ${month}</div>
          <div style="font-size:12px;color:#bfdbfe;margin-top:4px">${cfg.company_name}</div>
        </div>
        <div style="padding:24px 28px;font-size:14px;line-height:1.6">
          <p>Kính gửi Anh/Chị <strong>${recipient.name}</strong> (Mã NV: <strong>${recipient.employeeCode || ""}</strong>),</p>
          <p>Phòng Hành chính Nhân sự gửi Anh/Chị phiếu lương tháng <strong>${month}</strong> trong file PDF đính kèm.</p>
          <p style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:12px">
            🔒 File được khoá bằng mật khẩu: <strong>6 số cuối số CCCD</strong> của Anh/Chị.
          </p>
          <p>Phiếu lương là thông tin bảo mật, vui lòng không chia sẻ. Mọi thắc mắc xin liên hệ bộ phận C&amp;B qua email
            <a href="mailto:${smtpConfig.user}" style="color:#005BAC">${smtpConfig.user}</a>.</p>
        </div>
        <div style="background:#f8fafc;padding:14px 28px;font-size:11px;color:#64748b;text-align:center">Email gửi tự động từ hệ thống ${cfg.company_name}.</div>
      </div>`;

    await transporter.sendMail({
      from: `"${cfg.email_sender_name}" <${smtpConfig.user}>`,
      to: recipient.email,
      subject: `Phiếu lương tháng ${month} - ${recipient.name}`,
      html,
      attachments: [{
        filename: `Phieu_luong_${month.replace("/", "_")}_${recipient.employeeCode || "NV"}.pdf`,
        content: Buffer.from(pdfBase64, "base64"),
        contentType: "application/pdf",
      }],
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error sending payslip email:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Lỗi không xác định khi gửi email!" }, { status: 500 });
  }
}
