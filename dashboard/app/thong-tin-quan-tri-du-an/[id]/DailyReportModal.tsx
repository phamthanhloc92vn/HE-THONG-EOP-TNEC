"use client";

// Form phiếu BÁO CÁO NGÀY theo mẫu công ty (migration 105) — 1 phiếu / dự án / ngày,
// không qua duyệt. Phần "Công việc hôm nay" tự lấy từ nhật ký sản lượng ĐÃ DUYỆT
// của ngày (chỉ đọc), người lập ghi thêm việc khác + việc ngày mai + ảnh theo đơn vị.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { uploadLogPhoto, removeLogPhotos, copyLogPhoto } from "@/lib/projectLogPhotos";
import { formatDate, pcErrorMessage, todayVN, type LogPhoto } from "@/lib/projectControl";
import {
  DAILY_WEATHER,
  EQUIPMENT_TYPES,
  MANPOWER_ROLES,
  UNIT_GROUP_LABEL,
  autoWorkLines,
  carryOverUnits,
  defaultUnits,
  emptyUnit,
  loadDailyData,
  mergeUnits,
  sortUnits,
  sumRecord,
  type DailyData,
  type DailyUnit,
  type PcDailyReport,
  type UnitGroup,
} from "@/lib/projectDailyReport";
import { Field, TextInput, Select, PrimaryButton, ErrorLine, Modal, inputCls } from "./ui";
import { Loader2, Camera, ImageIcon, X, Plus, Trash2, Info } from "lucide-react";

export default function DailyReportModal({
  projectId,
  initialDate,
  copyFrom,
  onClose,
  onSaved,
}: {
  projectId: string;
  initialDate?: string;
  copyFrom?: string; // nhân đôi: chép toàn bộ phiếu ngày này (trừ ảnh) sang ngày đang chọn
  onClose: () => void;
  onSaved: (date: string) => void;
}) {
  const [date, setDate] = useState(initialDate || todayVN());
  const [data, setData] = useState<DailyData | null>(null);
  const [weatherAm, setWeatherAm] = useState("");
  const [weatherPm, setWeatherPm] = useState("");
  const [method, setMethod] = useState("");
  const [units, setUnits] = useState<DailyUnit[]>([]);
  const [issues, setIssues] = useState("");
  const [proposals, setProposals] = useState("");
  const [reporterName, setReporterName] = useState("");
  const [reporterTitle, setReporterTitle] = useState("");
  const [uploading, setUploading] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Ảnh đang trỏ vào tệp của phiếu nguồn (nhân đôi) -> khi lưu sẽ chép sang tệp mới.
  const sourcePaths = useRef<Set<string>>(new Set());
  // Đổi ngày liên tục thì lần tải cũ về sau không được đè lần tải mới.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setData(null);
    const [d, src] = await Promise.all([
      loadDailyData(projectId, date),
      copyFrom ? supabase.from("pc_daily_reports").select("*").eq("project_id", projectId).eq("report_date", copyFrom).maybeSingle() : null,
    ]);
    if (seq !== loadSeq.current) return;
    if (d.error) setErr(pcErrorMessage(d.error));
    if (src?.error) setErr(`Không đọc được phiếu nguồn để nhân đôi: ${pcErrorMessage(src.error)}`);
    // Nhân đôi: điền NGUYÊN phiếu nguồn (kể cả ảnh — ảnh được chép sang tệp mới lúc lưu).
    const source = src?.data ? ({ ...(src.data as PcDailyReport), units: Array.isArray(src.data.units) ? src.data.units : [] } as PcDailyReport) : null;
    setCopied(!!source);
    sourcePaths.current = new Set(source ? source.units.flatMap((u) => (Array.isArray(u.photos) ? u.photos.map((p) => p.path) : [])) : []);
    const rep = source || d.report;
    const defs = defaultUnits(d.ctx);
    setWeatherAm(rep?.weather_am || "");
    setWeatherPm(rep?.weather_pm || "");
    setMethod(rep?.method ?? d.prevMeta?.method ?? "");
    setUnits(rep ? mergeUnits(rep.units, defs) : mergeUnits(d.prevUnits ? carryOverUnits(d.prevUnits) : [], defs));
    setIssues(rep?.issues || "");
    setProposals(rep?.proposals || "");
    setReporterName(rep?.reporter_name ?? d.prevMeta?.reporter_name ?? "");
    setReporterTitle(rep?.reporter_title ?? d.prevMeta?.reporter_title ?? "");
    setData(d);
  }, [projectId, date, copyFrom]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const auto = data ? autoWorkLines(data.logs, data.ctx) : new Map<string, string[]>();
  const patch = (key: string, p: Partial<DailyUnit>) => setUnits((xs) => xs.map((u) => (u.key === key ? { ...u, ...p } : u)));
  const setNum = (key: string, field: "manpower" | "equipment", k: string, v: string) =>
    setUnits((xs) =>
      xs.map((u) => {
        if (u.key !== key) return u;
        const rec = { ...u[field] };
        const n = parseInt(v.replace(/\D/g, ""), 10);
        if (Number.isFinite(n) && n > 0) rec[k] = n;
        else delete rec[k];
        return { ...u, [field]: rec };
      })
    );

  function addUnit() {
    setUnits((xs) => sortUnits([...xs, emptyUnit(`u-${Date.now().toString(36)}`, "", "NON_NOMINAL")]));
  }

  async function addPhotos(key: string, files: FileList | null) {
    if (!files?.length) return;
    setUploading(key);
    setErr(null);
    try {
      const added: LogPhoto[] = [];
      for (const f of Array.from(files)) added.push(await uploadLogPhoto(projectId, f));
      setUnits((xs) => xs.map((u) => (u.key === key ? { ...u, photos: [...u.photos, ...added] } : u)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Không tải được ảnh.");
    }
    setUploading(null);
  }

  async function save() {
    if (units.some((u) => !u.name.trim())) return setErr("Có đơn vị chưa nhập tên.");
    setSaving(true);
    setErr(null);
    let clean = units.map((u) => ({ ...u, name: u.name.trim(), scope: u.scope.trim(), today: u.today.trim(), tomorrow: u.tomorrow.trim() }));
    // Ảnh chép từ phiếu nguồn: tạo bản sao tệp riêng cho phiếu này trước khi ghi.
    if (sourcePaths.current.size) {
      try {
        const mapped: typeof clean = [];
        for (const u of clean) {
          const photos: LogPhoto[] = [];
          for (const p of u.photos) photos.push(sourcePaths.current.has(p.path) ? await copyLogPhoto(projectId, p) : p);
          mapped.push({ ...u, photos });
        }
        clean = mapped;
      } catch (e) {
        setSaving(false);
        return setErr(e instanceof Error ? e.message : "Không chép được ảnh.");
      }
    }
    const { data: saved, error } = await supabase
      .from("pc_daily_reports")
      .upsert(
        {
          project_id: projectId,
          report_date: date,
          weather_am: weatherAm || null,
          weather_pm: weatherPm || null,
          method: method.trim() || null,
          units: clean,
          issues: issues.trim() || null,
          proposals: proposals.trim() || null,
          reporter_name: reporterName.trim() || null,
          reporter_title: reporterTitle.trim() || null,
        },
        { onConflict: "project_id,report_date" }
      )
      .select("id");
    setSaving(false);
    if (error) return setErr(pcErrorMessage(error));
    if (!saved?.length) return setErr("Không lưu được — tài khoản không có quyền nhập báo cáo dự án này.");
    // Ảnh đã gỡ khỏi phiếu: CSDL đã thôi trỏ tới -> giờ mới xoá khỏi kho.
    const kept = new Set(clean.flatMap((u) => u.photos.map((p) => p.path)));
    const old = data?.report?.units.flatMap((u) => (Array.isArray(u.photos) ? u.photos.map((p) => p.path) : [])) || [];
    removeLogPhotos(old.filter((p) => !kept.has(p)));
    onSaved(date);
  }

  const numCls = "w-full text-center text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-md px-1 py-1 focus:outline-none focus:border-[#00AEEF]";
  const areaCls = `${inputCls} min-h-[64px] resize-y`;

  const matrix = (title: string, keys: string[], field: "manpower" | "equipment") => {
    const grand = units.reduce((a, u) => a + sumRecord(u[field]), 0);
    return (
      <div className="space-y-1.5">
        <p className="text-[11px] font-extrabold text-slate-700">
          {title} <span className="font-semibold text-slate-400">— tổng {grand}</span>
        </p>
        <div className="overflow-x-auto border border-slate-100 rounded-lg">
          <table className="text-[11px] min-w-full">
            <thead>
              <tr className="bg-slate-50 text-slate-500">
                <th className="text-left font-bold px-2 py-1.5 w-28 sticky left-0 bg-slate-50 z-10 border-r border-slate-200">Nội dung</th>
                {units.map((u) => (
                  <th key={u.key} className="font-bold px-1 py-1.5 min-w-[88px]" title={u.name}>
                    {u.key.startsWith("u-") ? (
                      // Nhà thầu thêm tay: gõ tên ngay trên đầu cột.
                      <input
                        value={u.name}
                        placeholder="Tên nhà thầu"
                        onChange={(e) => patch(u.key, { name: e.target.value })}
                        className={`${numCls} font-bold`}
                      />
                    ) : (
                      <span className="line-clamp-2 break-words">{u.name || "?"}</span>
                    )}
                  </th>
                ))}
                <th className="px-1 py-1.5 w-10">
                  <button onClick={addUnit} className="mx-auto flex items-center justify-center w-7 h-7 rounded-md text-[#005BAC] hover:bg-blue-50" title="Thêm nhà thầu phụ">
                    <Plus size={14} />
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k} className="border-t border-slate-100">
                  <td className="px-2 py-1 font-semibold text-slate-600 sticky left-0 bg-white z-10 border-r border-slate-100">{k}</td>
                  {units.map((u) => (
                    <td key={u.key} className="px-1 py-1">
                      <input
                        value={u[field][k] ? String(u[field][k]) : ""}
                        onChange={(e) => setNum(u.key, field, k, e.target.value)}
                        inputMode="numeric"
                        className={numCls}
                      />
                    </td>
                  ))}
                  <td />
                </tr>
              ))}
              <tr className="border-t border-slate-200 bg-slate-50 font-extrabold text-slate-700">
                <td className="px-2 py-1.5 italic sticky left-0 bg-slate-50 z-10 border-r border-slate-200">Tổng</td>
                {units.map((u) => (
                  <td key={u.key} className="px-1 py-1.5 text-center italic">
                    {sumRecord(u[field])}
                  </td>
                ))}
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const h = (t: string) => <h4 className="text-[11px] font-extrabold uppercase tracking-wider text-[#005BAC] pt-2">{t}</h4>;

  return (
    <Modal title={`Báo cáo ngày ${formatDate(date)}`} onClose={onClose} xwide>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Field label="Ngày báo cáo">
          <TextInput type="date" value={date} max={todayVN()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </Field>
        <Field label="Thời tiết sáng">
          <Select value={weatherAm} onChange={(e) => setWeatherAm(e.target.value)}>
            <option value="">—</option>
            {DAILY_WEATHER.map((w) => (
              <option key={w}>{w}</option>
            ))}
          </Select>
        </Field>
        <Field label="Thời tiết chiều">
          <Select value={weatherPm} onChange={(e) => setWeatherPm(e.target.value)}>
            <option value="">—</option>
            {DAILY_WEATHER.map((w) => (
              <option key={w}>{w}</option>
            ))}
          </Select>
        </Field>
        <Field label="Hình thức thi công / Quản lý">
          <TextInput value={method} onChange={(e) => setMethod(e.target.value)} />
        </Field>
      </div>

      {!data ? (
        <div className="flex justify-center py-10">
          <Loader2 className="animate-spin text-[#005BAC]" size={22} />
        </div>
      ) : (
        <>
          <p className="flex items-start gap-1.5 text-[11px] text-slate-500 bg-blue-50/60 border border-blue-100 rounded-lg px-3 py-2">
            <Info size={13} className="mt-0.5 shrink-0 text-[#005BAC]" />
            <span>
              {copied ? (
                <>
                  Đã chép nguyên phiếu ngày {formatDate(copyFrom)} (cả ảnh) — sửa lại chỗ khác biệt rồi lưu.{" "}
                  {data.report && <b className="text-rose-600">Ngày {formatDate(date)} đã có phiếu — lưu sẽ GHI ĐÈ phiếu đó.</b>}
                </>
              ) : data.report ? "Đang sửa phiếu đã lưu của ngày này." : data.prevUnits ? "Phiếu mới — đơn vị, phạm vi, nhân sự, máy đã chép từ phiếu gần nhất." : "Phiếu mới."}{" "}
              Khối lượng hôm nay tự lấy từ <b>{data.logs.length}</b> dòng nhật ký sản lượng đã duyệt
              {data.pending > 0 && (
                <>
                  ; <b className="text-amber-600">{data.pending} dòng đang chờ QS duyệt</b> chưa vào báo cáo
                </>
              )}
              .
            </span>
          </p>

          {h("I. Đơn vị & phạm vi công việc")}
          <div className="space-y-1.5">
            {units.map((u) => (
              <div key={u.key} className="grid grid-cols-12 gap-2 items-center">
                <TextInput
                  className="col-span-3"
                  value={u.name}
                  disabled={u.key === "TNEC"}
                  placeholder="Tên đơn vị"
                  onChange={(e) => patch(u.key, { name: e.target.value })}
                />
                <Select
                  className="col-span-2"
                  value={u.group}
                  disabled={u.key === "TNEC"}
                  onChange={(e) => setUnits((xs) => sortUnits(xs.map((x) => (x.key === u.key ? { ...x, group: e.target.value as UnitGroup } : x))))}
                >
                  {(u.key === "TNEC" ? ["TNEC"] : ["NOMINAL", "NON_NOMINAL"]).map((g) => (
                    <option key={g} value={g}>
                      {UNIT_GROUP_LABEL[g as UnitGroup]}
                    </option>
                  ))}
                </Select>
                <TextInput
                  className="col-span-6"
                  value={u.scope}
                  disabled={u.key === "TNEC"}
                  placeholder={u.key === "TNEC" ? "(Lodeza EOP không ghi phạm vi ở mục I)" : "Phạm vi công việc, VD: Km2+280 ÷ Km3+287.65"}
                  onChange={(e) => patch(u.key, { scope: e.target.value })}
                />
                <div className="col-span-1 flex justify-center">
                  {/* Chỉ đơn vị thêm tay mới bỏ được; đơn vị theo HĐ B-B' luôn có mặt. */}
                  {u.key.startsWith("u-") && (
                    <button onClick={() => setUnits((xs) => xs.filter((x) => x.key !== u.key))} className="text-slate-300 hover:text-rose-500" title="Bỏ đơn vị khỏi phiếu">
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}
            <button onClick={addUnit} className="flex items-center gap-1 text-[11px] font-bold text-[#005BAC] hover:underline">
              <Plus size={12} /> Thêm nhà thầu
            </button>
          </div>

          {h("II. Nhân lực, thiết bị / máy móc")}
          {/* Xếp dọc (1 trên, 2 dưới) để bảng đủ rộng cho Lodeza EOP | NTP 1 | NTP 2 | … */}
          <div className="space-y-4">
            {matrix("1. Nhân sự", MANPOWER_ROLES, "manpower")}
            {matrix("2. Máy móc / thiết bị", EQUIPMENT_TYPES, "equipment")}
          </div>

          {h("III. Công việc thực hiện")}
          <div className="space-y-3">
            {units.map((u) => {
              const lines = auto.get(u.key) || [];
              return (
                <div key={u.key} className="border border-slate-100 rounded-xl p-3 space-y-2">
                  {u.key.startsWith("u-") ? (
                    // Nhà thầu tự do (không theo HĐ B-B'): sửa tên / nhóm / bỏ ngay tại đây.
                    <div className="flex flex-wrap items-center gap-2">
                      <TextInput
                        className="flex-1 min-w-[200px] font-extrabold"
                        value={u.name}
                        placeholder="Tên nhà thầu"
                        onChange={(e) => patch(u.key, { name: e.target.value })}
                      />
                      <Select
                        className="w-48"
                        value={u.group}
                        onChange={(e) => setUnits((xs) => sortUnits(xs.map((x) => (x.key === u.key ? { ...x, group: e.target.value as UnitGroup } : x))))}
                      >
                        {(["NOMINAL", "NON_NOMINAL"] as UnitGroup[]).map((g) => (
                          <option key={g} value={g}>
                            {UNIT_GROUP_LABEL[g]}
                          </option>
                        ))}
                      </Select>
                      <button onClick={() => setUnits((xs) => xs.filter((x) => x.key !== u.key))} className="text-slate-300 hover:text-rose-500" title="Bỏ nhà thầu khỏi phiếu">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ) : (
                    <p className="text-xs font-extrabold text-slate-800">{u.name || "?"}</p>
                  )}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <span className="block text-[10px] font-bold text-slate-500">Hôm nay ({formatDate(date)})</span>
                      {lines.length > 0 && (
                        <ul className="text-[11px] text-slate-600 bg-emerald-50/60 border border-emerald-100 rounded-lg px-3 py-1.5 space-y-0.5">
                          {lines.map((l, i) => (
                            <li key={i}>- {l}</li>
                          ))}
                          <li className="text-[10px] text-emerald-700 italic">↑ tự lấy từ nhật ký đã duyệt</li>
                        </ul>
                      )}
                      <textarea
                        value={u.today}
                        onChange={(e) => patch(u.key, { today: e.target.value })}
                        placeholder="Việc khác hôm nay — mỗi dòng 1 việc"
                        className={areaCls}
                      />
                    </div>
                    <div className="space-y-1">
                      <span className="block text-[10px] font-bold text-slate-500">Ngày mai</span>
                      <textarea
                        value={u.tomorrow}
                        onChange={(e) => patch(u.key, { tomorrow: e.target.value })}
                        placeholder="Kế hoạch ngày mai — mỗi dòng 1 việc"
                        className={areaCls}
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {u.photos.map((p) => (
                      <span key={p.path} className="flex items-center gap-1 text-[11px] font-semibold text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1">
                        <ImageIcon size={11} /> <span className="max-w-[160px] truncate">{p.name}</span>
                        <button onClick={() => patch(u.key, { photos: u.photos.filter((x) => x.path !== p.path) })} className="text-slate-400 hover:text-rose-500">
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                    <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 bg-white hover:bg-slate-50 border border-dashed border-slate-300 rounded-lg px-2.5 py-1.5 cursor-pointer">
                      {uploading === u.key ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />} Ảnh hiện trường (≤ 2MB)
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          addPhotos(u.key, e.target.files);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                </div>
              );
            })}
            <button onClick={addUnit} className="flex items-center gap-1 text-[11px] font-bold text-[#005BAC] hover:underline">
              <Plus size={12} /> Thêm nhà thầu
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Vướng mắc (mỗi dòng 1 ý)">
              <textarea value={issues} onChange={(e) => setIssues(e.target.value)} className={areaCls} />
            </Field>
            <Field label="Kiến nghị (mỗi dòng 1 ý)">
              <textarea value={proposals} onChange={(e) => setProposals(e.target.value)} className={areaCls} />
            </Field>
            <Field label="Người lập báo cáo">
              <TextInput value={reporterName} onChange={(e) => setReporterName(e.target.value)} placeholder="Phan Văn Quân" />
            </Field>
            <Field label="Chức danh">
              <TextInput value={reporterTitle} onChange={(e) => setReporterTitle(e.target.value)} placeholder="Giám sát hiện trường" />
            </Field>
          </div>
        </>
      )}

      <ErrorLine msg={err} />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="text-[11px] font-bold text-slate-600 px-3.5 py-2 rounded-lg border border-slate-200 hover:bg-slate-50">
          Huỷ
        </button>
        <PrimaryButton onClick={save} busy={saving} disabled={!data || !!uploading}>
          Lưu báo cáo ngày
        </PrimaryButton>
      </div>
    </Modal>
  );
}
