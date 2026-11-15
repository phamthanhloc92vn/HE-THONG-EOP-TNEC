"use client";

// Xem trước PHIẾU XUẤT KHO theo bố cục mẫu public/templates/Phieu_xuat_kho_atld.xlsx
// (user yêu cầu 02/10/2026: icon mắt cạnh nút sửa, bật giữa màn hình, có nút tải
// về đúng file mẫu). Dữ liệu lấy từ issuePrintData — CHUNG với route xuất Excel.
//
// Tờ giấy dùng style inline (nền trắng, chữ đen) chứ không dùng class Tailwind:
// dark mode remap các class màu trong globals.css, tờ phiếu thì phải luôn giống
// bản in.

import { useState } from "react";
import { createPortal } from "react-dom";
import { Download, Loader2, X, AlertCircle } from "lucide-react";
import { formatMoney, formatQty } from "@/lib/atldStock";
import { type IssuePrint, type IssueStatus, ISSUE_STATUS_META, downloadIssueXlsx } from "@/lib/atldVouchers";
import { BTN_PRIMARY } from "@/components/atld/ui";

const PAPER: React.CSSProperties = { background: "#fff", color: "#111", fontFamily: "'Times New Roman', Times, serif" };
const CELL: React.CSSProperties = { border: "1px solid #333", padding: "4px 6px", fontSize: 12 };
const HEAD: React.CSSProperties = { ...CELL, fontWeight: 700, textAlign: "center", background: "#f1f5f9" };

const money = (n: number | null) => (n == null ? "" : formatMoney(Math.round(n)));

function ngayDong(iso: string) {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `TP.HCM, Ngày ${d} Tháng ${m} Năm ${y}` : "TP.HCM, Ngày … Tháng … Năm …";
}

export default function AtldIssuePreview({ data, status, onClose }: { data: IssuePrint; status: IssueStatus; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const meta = ISSUE_STATUS_META[status];
  const tongSL = data.lines.reduce((a, l) => a + l.qty, 0);

  const download = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await downloadIssueXlsx(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const totalRow = (label: string, mid: React.ReactNode, value: number) => (
    <tr>
      <td colSpan={4} style={{ ...CELL, fontWeight: 700, textAlign: "center" }}>{label}</td>
      <td style={{ ...CELL, textAlign: "right", fontWeight: 700 }}>{mid}</td>
      <td style={CELL} />
      <td style={{ ...CELL, textAlign: "right", fontWeight: 700 }}>{money(value)}</td>
      <td style={CELL} />
    </tr>
  );

  return createPortal(
    <div className="fixed inset-0 z-[85] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl w-full max-w-[880px] max-h-[92vh] flex flex-col animate-in zoom-in-95 duration-150">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-100">
          <h2 className="font-heading font-extrabold text-sm text-slate-800">Xem trước phiếu xuất kho</h2>
          <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${meta.cls}`}>{meta.label}</span>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={download} disabled={busy} className={BTN_PRIMARY}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Tải về (.xlsx)
            </button>
            <button type="button" onClick={onClose} className="text-slate-400 hover:text-rose-500 cursor-pointer p-1" aria-label="Đóng">
              <X size={18} />
            </button>
          </div>
        </div>
        {err && (
          <div className="mx-5 mt-3 flex items-start gap-2 bg-rose-50 border border-rose-200 text-rose-600 text-xs font-semibold px-4 py-2.5 rounded-xl">
            <AlertCircle size={14} className="mt-0.5 shrink-0" /> {err}
          </div>
        )}

        <div className="overflow-auto p-4 bg-slate-100 rounded-b-2xl">
          <div style={{ ...PAPER, padding: "28px 32px", minWidth: 720, boxShadow: "0 1px 4px rgba(0,0,0,.15)" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/templates/Phieu_xuat_kho_atld_letterhead.png" alt="Lodeza EOP" style={{ height: 78, width: "auto" }} />
            <div style={{ textAlign: "center", fontWeight: 700, fontSize: 20, marginTop: 14 }}>PHIẾU XUẤT KHO</div>
            <div style={{ textAlign: "center", fontStyle: "italic", fontSize: 13, marginTop: 4 }}>Số: {data.soPhieu}</div>

            <div style={{ fontSize: 13, lineHeight: 1.7, marginTop: 12, paddingLeft: 48 }}>
              <div><b>Họ và tên:</b> {data.hoTen}</div>
              <div><b>Nội dung:</b> {data.noiDung}</div>
              <div><b>Địa chỉ:</b> {data.diaChi}</div>
            </div>
            <div style={{ fontSize: 13, marginTop: 4 }}>Xuất tại kho: HH - kho hàng hóa</div>

            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
              <thead>
                <tr>
                  <th style={{ ...HEAD, width: 40 }}>STT</th>
                  <th style={{ ...HEAD, width: 80 }}>Mã SP</th>
                  <th style={HEAD}>Tên SP</th>
                  <th style={{ ...HEAD, width: 52 }}>ĐVT</th>
                  <th style={{ ...HEAD, width: 70 }}>Số lượng</th>
                  <th style={{ ...HEAD, width: 86 }}>Đơn Giá</th>
                  <th style={{ ...HEAD, width: 104 }}>Thành Tiền</th>
                  <th style={{ ...HEAD, width: 96 }}>Ghi chú</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l, i) => (
                  <tr key={i}>
                    <td style={{ ...CELL, textAlign: "center" }}>{i + 1}</td>
                    <td style={CELL}>{l.code}</td>
                    <td style={CELL}>{l.name}</td>
                    <td style={{ ...CELL, textAlign: "center" }}>{l.unit}</td>
                    <td style={{ ...CELL, textAlign: "center" }}>{formatQty(l.qty)}</td>
                    <td style={{ ...CELL, textAlign: "right" }}>{money(l.price)}</td>
                    <td style={{ ...CELL, textAlign: "right" }}>{l.price == null ? "" : money(l.qty * l.price)}</td>
                    <td style={{ ...CELL, textAlign: "center" }}>{l.note}</td>
                  </tr>
                ))}
                {totalRow("TỔNG (Chưa bao gồm VAT)", formatQty(tongSL), data.tienHang)}
                <tr>
                  <td colSpan={4} style={{ ...CELL, fontWeight: 700, textAlign: "center" }}>Thuế GTGT (VAT)</td>
                  <td style={CELL} />
                  <td style={{ ...CELL, textAlign: "center", fontWeight: 700 }}>{data.vatPercent}%</td>
                  <td style={{ ...CELL, textAlign: "right", fontWeight: 700 }}>{money(data.tienVat)}</td>
                  <td style={CELL} />
                </tr>
                {totalRow("TỔNG CỘNG (Đã gồm VAT)", null, data.tienHang + data.tienVat)}
                {totalRow("Chi phí vận chuyển giao hàng", null, data.phiVanChuyen)}
                {totalRow("TỔNG CỘNG (Đã gồm VAT + Vận chuyển)", null, data.tongCong)}
              </tbody>
            </table>

            <div style={{ textAlign: "right", fontStyle: "italic", fontSize: 13, marginTop: 28, paddingRight: 40 }}>{ngayDong(data.ngay)}</div>
            <div style={{ display: "flex", justifyContent: "space-around", fontWeight: 700, fontSize: 15, marginTop: 12, paddingBottom: 72 }}>
              <span>Bên nhận hàng</span>
              <span>Bên giao hàng</span>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
