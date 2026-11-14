"use client";
// Tab "Bảng lương & BHXH > Cài đặt chung": thông số theo luật/chính sách (công chuẩn,
// giảm trừ gia cảnh, % bảo hiểm, biểu thuế TNCN). Lưu 1 lần -> Tính lương, BHXH, phiếu
// lương, hồ sơ đều áp theo. Tháng đã chốt giữ số cũ cho tới khi bấm "Chốt lại".
import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { ALLOWANCE_TIER_LABEL, AllowanceTier, PAYROLL_SETTINGS_DEFAULT, PayrollSettings, TaxBracket } from "@/lib/payroll";
import { vnd } from "./PayrollCalcTab";

const toNum = (v: string) => Number(v.replace(/\D/g, "")) || 0;
// % hiển thị tối đa 2 số lẻ: 0.015 -> 1.5
const pctOf = (r: number) => +(r * 100).toFixed(2);

export default function PayrollSettingsTab({ settings, onSaved, notify }: {
  settings: PayrollSettings;
  onSaved: (s: PayrollSettings) => void;
  notify: (msg: string, type?: "success" | "error") => void;
}) {
  const [draft, setDraft] = useState<PayrollSettings>(settings);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof PayrollSettings>(k: K, v: PayrollSettings[K]) => setDraft(prev => ({ ...prev, [k]: v }));
  const setBracket = (idx: number, patch: Partial<TaxBracket>) =>
    set("tax_brackets", draft.tax_brackets.map((b, i) => (i === idx ? { ...b, ...patch } : b)));

  const save = async () => {
    // Bậc thuế phải tăng dần, bậc cuối không giới hạn
    const caps = draft.tax_brackets.slice(0, -1).map(b => b.upto || 0);
    if (caps.some((c, i) => c <= 0 || (i > 0 && c <= caps[i - 1]))) {
      return notify("Biểu thuế: ngưỡng các bậc phải lớn hơn 0 và tăng dần.", "error");
    }
    const payload = { ...draft, tax_brackets: draft.tax_brackets.map((b, i, arr) => (i === arr.length - 1 ? { ...b, upto: null } : b)) };
    setSaving(true);
    const { data: auth } = await supabase.auth.getUser();
    const { error } = await supabase.from("payroll_settings").upsert({
      id: 1, ...payload, updated_at: new Date().toISOString(), updated_by: auth.user?.email || null,
    });
    setSaving(false);
    if (error) return notify("Lỗi lưu cài đặt: " + error.message, "error");
    onSaved(payload);
    notify("Đã lưu cài đặt chung — bảng lương áp dụng ngay. Tháng đã chốt cần bấm \"Chốt lại\" để cập nhật.", "success");
  };

  const card = "glass bg-white rounded-2xl p-5 border border-slate-200/50 shadow-premium space-y-3 text-xs";
  const row = "flex items-center justify-between gap-3 font-semibold text-slate-600";
  const input = "w-36 text-right border border-slate-200 rounded px-2 py-1.5 bg-white font-bold text-slate-800";
  const pctInput = (label: string, k: "bhxh_rate" | "bhyt_rate" | "bhtn_rate" | "company_insurance_rate") => (
    <label className={row}>
      {label}
      <span className="flex items-center gap-1">
        <input type="number" step="0.1" min="0" value={pctOf(draft[k])} onChange={e => set(k, (Number(e.target.value) || 0) / 100)} className={input + " w-24"} />%
      </span>
    </label>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-heading font-extrabold text-slate-800 text-sm">CÀI ĐẶT CHUNG BẢNG LƯƠNG</h3>
          <p className="text-slate-400 text-[10px] font-semibold mt-0.5">Thông số theo luật / chính sách.</p>
        </div>
        <div className="flex gap-2 text-xs font-bold">
          <button onClick={() => setDraft(PAYROLL_SETTINGS_DEFAULT)} className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 cursor-pointer">Về mặc định 2026</button>
          <button onClick={save} disabled={saving} className="px-4 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 cursor-pointer">{saving ? "Đang lưu..." : "Lưu cài đặt"}</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        <div className={card}>
          <h4 className="font-heading font-extrabold text-[#005BAC] text-sm">Ngày công & giảm trừ</h4>
          <label className={row}>
            Ngày công chuẩn / tháng
            <input type="number" min="1" value={draft.standard_workdays} onChange={e => set("standard_workdays", Number(e.target.value) || 1)} className={input + " w-24"} />
          </label>
          <label className={row}>
            Giảm trừ bản thân (đ/tháng)
            <input value={vnd(draft.self_deduction)} onChange={e => set("self_deduction", toNum(e.target.value))} className={input} />
          </label>
          <label className={row}>
            Giảm trừ mỗi người phụ thuộc (đ/tháng)
            <input value={vnd(draft.dependent_deduction)} onChange={e => set("dependent_deduction", toNum(e.target.value))} className={input} />
          </label>
        </div>

        <div className={card}>
          <h4 className="font-heading font-extrabold text-[#005BAC] text-sm">Tỷ lệ bảo hiểm</h4>
          <div className="text-[10px] font-bold text-slate-400 uppercase">Người lao động đóng (trừ vào lương)</div>
          {pctInput("BHXH", "bhxh_rate")}
          {pctInput("BHYT", "bhyt_rate")}
          {pctInput("BHTN", "bhtn_rate")}
          <div className={row + " border-t border-slate-100 pt-2 text-slate-800 font-bold"}>
            Tổng NLĐ đóng <span>{pctOf(draft.bhxh_rate + draft.bhyt_rate + draft.bhtn_rate)}%</span>
          </div>
          <div className="text-[10px] font-bold text-slate-400 uppercase pt-1">Doanh nghiệp đóng thêm (tab BHXH)</div>
          {pctInput("Doanh nghiệp đóng", "company_insurance_rate")}
        </div>

        <div className={card}>
          <h4 className="font-heading font-extrabold text-[#005BAC] text-sm">Biểu thuế TNCN lũy tiến (tháng)</h4>
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-emerald-600 text-white text-[10px] uppercase font-extrabold">
                <th className="py-2 px-2 text-left">Bậc</th>
                <th className="py-2 px-2 text-right">Thu nhập tính thuế đến (đ)</th>
                <th className="py-2 px-2 text-right">Thuế suất</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-semibold">
              {draft.tax_brackets.map((b, i) => {
                const last = i === draft.tax_brackets.length - 1;
                return (
                  <tr key={i}>
                    <td className="py-1.5 px-2">{i + 1}</td>
                    <td className="py-1.5 px-2 text-right">
                      {last ? <span className="text-slate-500">Trên {vnd(draft.tax_brackets[i - 1]?.upto || 0)}</span> : (
                        <input value={vnd(b.upto || 0)} onChange={e => setBracket(i, { upto: toNum(e.target.value) })} className={input} />
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-right whitespace-nowrap">
                      <input type="number" step="0.5" min="0" value={pctOf(b.rate)} onChange={e => setBracket(i, { rate: (Number(e.target.value) || 0) / 100 })} className={input + " w-16"} />%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className={card}>
        <h4 className="font-heading font-extrabold text-[#005BAC] text-sm">Phụ cấp</h4>
        <label className={row + " max-w-md"}>
          Tiền ăn (đ/ngày đi làm thực tế)
          <input value={vnd(draft.lunch_per_day)} onChange={e => set("lunch_per_day", toNum(e.target.value))} className={input} />
        </label>
        <p className="text-[10px] text-slate-400">Tiền ăn = đơn giá × số ngày có mặt văn phòng trong tháng (gồm làm online thứ 7; không tính phép, lễ, công tác).</p>
        <table className="w-full max-w-2xl border-collapse">
          <thead>
            <tr className="bg-emerald-600 text-white text-[10px] uppercase font-extrabold">
              <th className="py-2 px-2 text-left">Cấp (tự xếp theo Chức vụ trong hồ sơ)</th>
              <th className="py-2 px-2 text-right">Xăng xe (đ/tháng)</th>
              <th className="py-2 px-2 text-right">Điện thoại (đ/tháng)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 font-semibold">
            {(Object.keys(ALLOWANCE_TIER_LABEL) as AllowanceTier[]).map(t => (
              <tr key={t}>
                <td className="py-1.5 px-2 text-slate-700">{ALLOWANCE_TIER_LABEL[t]}</td>
                <td className="py-1.5 px-2 text-right">
                  <input value={vnd(draft[`fuel_${t}`])} onChange={e => set(`fuel_${t}`, toNum(e.target.value))} className={input} />
                </td>
                <td className="py-1.5 px-2 text-right">
                  <input value={vnd(draft[`phone_${t}`])} onChange={e => set(`phone_${t}`, toNum(e.target.value))} className={input} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[10px] text-slate-400">Xăng, điện thoại trả cố định theo cấp mỗi tháng, không xét ngày công. Cấp cao: Ban lãnh đạo, Giám đốc, Phó giám đốc · Quản lý cấp trung: Trưởng/Phó phòng (TP/PP) · Quản lý sơ cấp: Tổ trưởng · Nhân viên: còn lại.</p>
      </div>
    </div>
  );
}
