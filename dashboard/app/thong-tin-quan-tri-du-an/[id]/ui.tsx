"use client";

// Ô nhập / nút dùng chung cho các tab hồ sơ dự án — cùng một kiểu để form gọn.

import type { ReactNode, InputHTMLAttributes, SelectHTMLAttributes } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { formatVnd } from "@/lib/projectControl";

export const inputCls =
  "w-full text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-[#00AEEF] placeholder:text-slate-400 disabled:bg-slate-50 disabled:text-slate-500";

export function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block space-y-1 ${className}`}>
      <span className="text-[10px] font-bold text-slate-500">{label}</span>
      {children}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className || ""}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputCls} ${props.className || ""}`} />;
}

// Ô tiền: gõ số, tự chấm hàng nghìn khi rời ô. Giá trị giữ dạng chuỗi trong form.
export function MoneyInput({
  value,
  onChange,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <input
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        inputMode="numeric"
        onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
        onBlur={(e) => {
          const d = e.target.value.replace(/\D/g, "");
          onChange(d ? formatVnd(parseInt(d, 10)) : "");
        }}
        className={`${inputCls} pr-9 text-right font-mono`}
      />
      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold text-slate-400">đ</span>
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
  busy,
  disabled,
  tone = "blue",
}: {
  children: ReactNode;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  tone?: "blue" | "green";
}) {
  const color =
    tone === "green"
      ? "bg-emerald-600 hover:bg-emerald-700 shadow-emerald-500/15"
      : "bg-[#005BAC] hover:bg-blue-700 shadow-blue-500/15";
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      className={`flex items-center gap-1.5 ${color} disabled:opacity-60 text-white text-[11px] font-bold px-3.5 py-2 rounded-lg shadow-sm transition-all active:scale-[0.98]`}
    >
      {busy && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

export function GhostButton({ children, onClick, danger }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-2 rounded-lg transition-all ${
        danger ? "text-slate-400 hover:text-rose-500 hover:bg-rose-50" : "text-slate-500 hover:text-[#005BAC] hover:bg-blue-50"
      }`}
    >
      {children}
    </button>
  );
}

export function ErrorLine({ msg }: { msg: string | null | undefined }) {
  if (!msg) return null;
  return (
    <p className="flex items-start gap-1.5 text-[11px] font-semibold text-rose-500">
      <AlertCircle size={13} className="mt-0.5 shrink-0" /> {msg}
    </p>
  );
}

export function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border border-slate-100 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 px-5 py-3.5 border-b border-slate-100">
        <h3 className="font-heading font-extrabold text-xs text-slate-800 flex-1 min-w-0">{title}</h3>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
  xwide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  xwide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-[900] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className={`bg-white rounded-2xl shadow-2xl w-full ${xwide ? "max-w-6xl" : wide ? "max-w-3xl" : "max-w-lg"} max-h-[90vh] overflow-y-auto p-6 space-y-4 animate-in zoom-in-95 duration-150`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <h2 className="font-heading font-extrabold text-sm text-slate-800 flex-1">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-rose-500 text-lg leading-none">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function LockedMoney() {
  return <span className="text-[11px] italic text-slate-400">Không có quyền xem</span>;
}

// Ô chọn trạng thái kiểu Excel 0 / 0.5 / 1 (hoặc 0 / 1). `scale` = nhãn từng mức.
export function TriToggle({
  value,
  scale,
  onChange,
  disabled,
}: {
  value: number;
  scale: Record<string, string>;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  // Object.keys đưa khoá số nguyên ("0","1") lên trước "0.5" -> phải sắp lại.
  const levels = Object.keys(scale).map(Number).sort((a, b) => a - b);
  const tone = (v: number) =>
    v >= 1 ? "bg-emerald-500 text-white" : v > 0 ? "bg-amber-400 text-white" : "bg-slate-400 text-white";
  return (
    <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
      {levels.map((v) => {
        const on = Number(value) === v;
        return (
          <button
            key={v}
            type="button"
            disabled={disabled}
            onClick={() => !on && onChange(v)}
            title={scale[String(v)]}
            className={`px-2 py-1 text-[10px] font-bold transition-colors disabled:cursor-default ${
              on ? tone(v) : "bg-white text-slate-400 hover:bg-slate-50"
            }`}
          >
            {v === 0.5 ? "½" : v}
          </button>
        );
      })}
    </div>
  );
}

// Thanh trạng thái chia phần có màu (đỏ → vàng → xanh lá), dùng cho mọi ô trạng
// thái kiểu Excel 0 / 0.5 / 1 hoặc 0 / 1. Bấm phần nào thì phần đó sáng màu.
// compact = bản thấp trên dòng danh sách; widthCls để chỉnh bề rộng theo bảng.
export function StatusBar({
  value,
  scale,
  onChange,
  compact,
  disabled,
  widthCls,
}: {
  value: number;
  scale: Record<string, string>;
  onChange: (v: number) => void;
  compact?: boolean;
  disabled?: boolean;
  widthCls?: string;
}) {
  const levels = Object.keys(scale).map(Number).sort((a, b) => a - b);
  const tone = (v: number) =>
    v >= 1 ? "bg-emerald-500 text-white" : v > 0 ? "bg-amber-400 text-white" : "bg-rose-500 text-white";
  return (
    <div
      className={`grid rounded-lg border border-slate-200 overflow-hidden ${compact ? "shrink-0" : ""} ${widthCls || ""}`}
      style={{ gridTemplateColumns: `repeat(${levels.length}, minmax(0, 1fr))` }}
    >
      {levels.map((v, i) => {
        const active = Number(value) === v;
        return (
          <button
            key={v}
            type="button"
            disabled={disabled}
            onClick={() => !active && onChange(v)}
            className={`${compact ? "py-1 px-1 text-[10px]" : "py-2 text-[11px]"} font-bold whitespace-nowrap transition-colors disabled:cursor-default ${
              i > 0 ? "border-l border-slate-200" : ""
            } ${active ? tone(v) : "bg-white text-slate-400 hover:bg-slate-50"}`}
          >
            {scale[String(v)]}
          </button>
        );
      })}
    </div>
  );
}
