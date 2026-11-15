"use client";

// Bản xem / in BÁO CÁO NGÀY theo đúng bố cục mẫu công ty (tab Báo cáo > Báo cáo ngày).
// Cùng mô hình với tệp Excel (buildDailyModel) nên màn hình và Excel luôn khớp nhau.

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDate, pcErrorMessage, type PcAccess, type PcProject } from "@/lib/projectControl";
import { resolveLogPhotoUrl } from "@/lib/projectLogPhotos";
import {
  COMPANY_NAME,
  EQUIPMENT_TYPES,
  MANPOWER_ROLES,
  bdhTitle,
  buildDailyModel,
  exportDailyReportXlsx,
  loadDailyData,
  splitLines,
  sumRecord,
  type DailyData,
  type DailyUnit,
} from "@/lib/projectDailyReport";
import DailyReportModal from "./DailyReportModal";
import { ErrorLine } from "./ui";
import { Loader2, FileSpreadsheet, PencilLine } from "lucide-react";

const GREEN = "bg-[#92D050]";

export default function DailyReportView({
  project,
  access,
  date,
  onSaved,
}: {
  project: PcProject;
  access: PcAccess;
  date: string;
  onSaved?: () => void;
}) {
  const [data, setData] = useState<DailyData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setData(null);
    const d = await loadDailyData(project.id, date);
    setErr(d.error ? pcErrorMessage(d.error) : null);
    setData(d);
    const paths = (d.report?.units || []).flatMap((u) => (Array.isArray(u.photos) ? u.photos.map((p) => p.path) : []));
    const entries = await Promise.all(paths.map(async (p) => [p, await resolveLogPhotoUrl(p)] as const));
    setPhotoUrls(Object.fromEntries(entries.filter(([, u]) => u)) as Record<string, string>);
  }, [project.id, date]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const m = useMemo(
    () => (data ? buildDailyModel(project, date, data.report, data.prevUnits, data.logs, data.ctx) : null),
    [data, project, date]
  );

  async function doExport() {
    if (!m) return;
    setExporting(true);
    try {
      await exportDailyReportXlsx(m);
    } catch (e) {
      setErr(`Không xuất được Excel: ${e instanceof Error ? e.message : String(e)}`);
    }
    setExporting(false);
  }

  if (!m || !data)
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="animate-spin text-[#005BAC]" size={26} />
      </div>
    );

  const rep = m.report;
  const K = Math.max(8, m.units.length + (m.units.length % 2));
  const half = K / 2;
  const td = "border border-slate-800 px-1.5 py-1 align-middle";
  const pad = (n: number, text = "") => Array.from({ length: Math.max(0, n) }, (_, i) => <td key={`p${i}`} className={`${td} text-center font-bold`}>{text}</td>);
  const nom = m.subs.filter((u) => u.group === "NOMINAL").length;
  const non = m.subs.length - nom;
  const st = m.stats;

  const matrixRows = (title: string, keys: string[], pick: (u: DailyUnit) => Record<string, number>, grand: number) => {
    const extra = new Set<string>();
    m.units.forEach((u) => Object.keys(pick(u) || {}).forEach((k) => !keys.includes(k) && Number(pick(u)[k]) && extra.add(k)));
    return (
      <>
        <tr>
          <td colSpan={K} className={`${td} text-center font-bold`}>
            {title}
          </td>
          <td className={`${td} text-center font-bold italic`}>{grand}</td>
        </tr>
        {[...keys, ...extra].map((k) => (
          <tr key={k}>
            <td className={`${td} text-center`}>{k}</td>
            {m.units.map((u) => (
              <td key={u.key} className={`${td} text-center`}>
                {Number(pick(u)?.[k] || 0) || ""}
              </td>
            ))}
            {pad(K - m.units.length)}
          </tr>
        ))}
        <tr className="font-bold italic">
          <td className={`${td} text-center`}>Tổng</td>
          {m.units.map((u) => (
            <td key={u.key} className={`${td} text-center`}>
              {sumRecord(pick(u))}
            </td>
          ))}
          {pad(K - m.units.length, "0")}
        </tr>
      </>
    );
  };

  const iss = splitLines(rep?.issues);
  const pro = splitLines(rep?.proposals);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <p className="text-[11px] text-slate-500 flex-1 min-w-[200px]">
          {rep ? (
            <>
              Phiếu đã lập{rep.updated_by ? ` · cập nhật bởi ${rep.updated_by.split("@")[0]}` : ""}.
            </>
          ) : (
            <span className="text-amber-600 font-semibold">Chưa lập phiếu báo cáo ngày này — đang hiện số liệu tự động từ nhật ký.</span>
          )}{" "}
          {data.pending > 0 && <span className="text-amber-600">{data.pending} dòng nhật ký đang chờ QS duyệt chưa vào báo cáo.</span>}
        </p>
        {access.can_log && (
          <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-[#005BAC] border border-blue-200 text-[11px] font-bold px-3.5 py-2 rounded-lg"
          >
            <PencilLine size={13} /> {rep ? "Sửa báo cáo ngày" : "Lập báo cáo ngày"}
          </button>
        )}
        <button
          onClick={doExport}
          disabled={exporting}
          className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-[11px] font-bold px-3.5 py-2 rounded-lg"
        >
          {exporting ? <Loader2 size={13} className="animate-spin" /> : <FileSpreadsheet size={13} />} Xuất Excel theo mẫu
        </button>
      </div>
      <ErrorLine msg={err} />

      {/* Tờ giấy theo mẫu: luôn nền trắng mực đen kể cả dark mode (lớp .paper-sheet trong globals.css). */}
      <div className="paper-sheet overflow-x-auto rounded-2xl shadow-sm p-4 print:p-0 print:shadow-none">
        <table className="w-full min-w-[820px] border-collapse text-[11px] text-slate-900 table-fixed" style={{ fontFamily: "Arial, sans-serif" }}>
          <colgroup>
            <col style={{ width: "13%" }} />
            {Array.from({ length: K }, (_, i) => (
              <col key={i} />
            ))}
          </colgroup>
          <tbody>
            {/* Đầu trang */}
            <tr>
              <td rowSpan={3} className={`${td} text-center`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/logo-tnec.png" alt="" className="h-12 w-auto mx-auto" />
              </td>
              <td rowSpan={3} colSpan={3} className={`${td} text-center font-bold text-[#1F3864]`}>
                {COMPANY_NAME}
              </td>
              <td colSpan={K - 5} className={`${td} text-center font-bold text-lg`}>
                BÁO CÁO NGÀY
              </td>
              <td colSpan={2} className={`${td} text-center font-bold`}>
                THỜI TIẾT
              </td>
            </tr>
            <tr>
              <td rowSpan={2} colSpan={K - 5} className={`${td} text-center font-bold text-base`}>
                {formatDate(m.date)}
              </td>
              <td className={`${td} font-bold`}>Sáng:</td>
              <td className={`${td} text-center`}>{rep?.weather_am || ""}</td>
            </tr>
            <tr>
              <td className={`${td} font-bold`}>Chiều:</td>
              <td className={`${td} text-center`}>{rep?.weather_pm || ""}</td>
            </tr>
            {[
              ["Dự án :", project.name],
              ["Gói thầu :", project.package_name || ""],
              ["Địa điểm :", project.location || ""],
              ["Hình thức thi công/Quản lý", rep?.method || ""],
            ].map(([a, b]) => (
              <tr key={a}>
                <td colSpan={2} className={`${td} font-bold`}>
                  {a}
                </td>
                <td colSpan={K - 1} className={`${td} font-bold`}>
                  {b || "...."}
                </td>
              </tr>
            ))}

            {/* I. Nhà thầu phụ */}
            <tr>
              <td colSpan={K + 1} className={`${td} ${GREEN} text-center font-bold`}>
                I. NHÀ THẦU PHỤ
              </td>
            </tr>
            <tr>
              <td rowSpan={2} className={`${td} text-center font-bold`}>
                Tên đơn vị
              </td>
              {nom > 0 && (
                <td colSpan={nom} className={`${td} text-center font-bold`}>
                  THẦU PHỤ CHÍNH DANH
                </td>
              )}
              {non > 0 && (
                <td colSpan={non} className={`${td} text-center font-bold`}>
                  THẦU PHỤ Lodeza EOP
                </td>
              )}
              {K - m.subs.length > 0 && (
                <td colSpan={K - m.subs.length} className={`${td} text-center italic`}>
                  {m.subs.length ? "" : "Chưa có hợp đồng B-B'"}
                </td>
              )}
            </tr>
            <tr>
              {m.subs.map((u) => (
                <td key={u.key} className={`${td} text-center font-bold`}>
                  {u.name}
                </td>
              ))}
              {pad(K - m.subs.length, "…")}
            </tr>
            <tr>
              <td className={`${td} text-center font-bold`}>Phạm vi công việc</td>
              {m.subs.map((u) => (
                <td key={u.key} className={`${td} whitespace-pre-wrap break-words`}>
                  {u.scope}
                </td>
              ))}
              {pad(K - m.subs.length)}
            </tr>
            <tr className="font-bold">
              <td colSpan={2} className={`${td} text-center`}>
                Thời gian thi công
              </td>
              <td className={`${td} text-center`}>
                {project.start_date && project.finish_date ? (
                  <>
                    Từ {formatDate(project.start_date)}
                    <br />
                    Đến {formatDate(project.finish_date)}
                  </>
                ) : (
                  "Chưa có ngày KC/HT"
                )}
              </td>
              <td className={td}>Thời gian còn lại:</td>
              <td className={`${td} text-center`}>{st?.remaining ?? ""}</td>
              <td className={td}>Thời gian thực hiện :</td>
              <td className={`${td} text-center`}>{st?.elapsed ?? ""}</td>
              <td className={td}>Tỷ lệ thời gian thực hiện :</td>
              <td colSpan={K - 7} className={`${td} text-center`}>
                {st ? `${(st.ratio * 100).toFixed(2).replace(".", ",")}%` : ""}
              </td>
            </tr>

            {/* II. Nhân lực, máy */}
            <tr>
              <td colSpan={K + 1} className={`${td} ${GREEN} text-center font-bold`}>
                II. NHÂN LỰC, THIẾT BỊ/MÁY MÓC
              </td>
            </tr>
            <tr>
              <td className={`${td} text-center font-bold`}>Nội dung</td>
              {m.units.map((u) => (
                <td key={u.key} className={`${td} text-center font-bold`}>
                  {u.name}
                </td>
              ))}
              {pad(K - m.units.length, "…")}
            </tr>
            {matrixRows("1. Nhân sự", MANPOWER_ROLES, (u) => u.manpower, m.manpowerTotal)}
            {matrixRows("2. Máy móc / thiết bị", EQUIPMENT_TYPES, (u) => u.equipment, m.equipmentTotal)}

            {/* III. Công việc */}
            <tr>
              <td colSpan={K + 1} className={`${td} ${GREEN} text-center font-bold`}>
                III. CÔNG VIỆC THỰC HIỆN
              </td>
            </tr>
            <tr className={`${GREEN} font-bold`}>
              <td className={td}>Đơn vị</td>
              <td colSpan={Math.floor(half / 2)} className={td}>
                Hôm nay:
              </td>
              <td colSpan={half - Math.floor(half / 2)} className={`${td} text-center`}>
                {formatDate(m.date)}
              </td>
              <td colSpan={Math.floor(half / 2)} className={td}>
                Ngày mai:
              </td>
              <td colSpan={half - Math.floor(half / 2)} className={`${td} text-center`}>
                {formatDate(m.tomorrow)}
              </td>
            </tr>
            {m.units.map((u) => {
              const tl = m.todayLines.get(u.key) || [];
              const tm = m.tomorrowLines.get(u.key) || [];
              const n = Math.max(1, tl.length, tm.length);
              const photos = u.photos.filter((p) => photoUrls[p.path]);
              const pr = Math.ceil(photos.length / 2);
              return Array.from({ length: n + pr }, (_, i) => (
                <tr key={`${u.key}-${i}`}>
                  {i === 0 && (
                    <td rowSpan={n + pr} className={`${td} text-center font-bold text-[#1F3864]`}>
                      {u.name}
                    </td>
                  )}
                  {i < n ? (
                    <>
                      <td colSpan={half} className={`${td} ${!tl.length && i === 0 ? "text-center" : ""}`}>
                        {tl[i] ?? (i === 0 ? "…" : "")}
                      </td>
                      <td colSpan={half} className={`${td} ${!tm.length && i === 0 ? "text-center" : ""}`}>
                        {tm[i] ?? (i === 0 ? "…" : "")}
                      </td>
                    </>
                  ) : (
                    [photos[(i - n) * 2], photos[(i - n) * 2 + 1]].map((p, j) => (
                      <td key={j} colSpan={half} className={`${td} text-center p-1`}>
                        {p && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={photoUrls[p.path]} alt={p.name} className="max-h-48 w-auto mx-auto object-contain" />
                        )}
                      </td>
                    ))
                  )}
                </tr>
              ));
            })}

            {/* Vướng mắc / Kiến nghị */}
            <tr className={`${GREEN} font-bold`}>
              <td colSpan={half + 1} className={`${td} text-center`}>
                VƯỚNG MẮC
              </td>
              <td colSpan={half} className={`${td} text-center`}>
                KIẾN NGHỊ
              </td>
            </tr>
            {Array.from({ length: Math.max(1, iss.length, pro.length) }, (_, i) => (
              <tr key={`ip${i}`}>
                <td colSpan={half + 1} className={td}>
                  {iss[i] || ""}
                </td>
                <td colSpan={half} className={td}>
                  {pro[i] || ""}
                </td>
              </tr>
            ))}

            {/* Chữ ký */}
            <tr>
              <td colSpan={half} className="border-l border-b border-slate-800" />
              <td colSpan={half + 1} className="border-r border-b border-slate-800 text-center italic pt-4 pb-3">
                {bdhTitle(project)}
                <br />
                Người lập báo cáo
                <div className="h-16" />
                {[rep?.reporter_name, rep?.reporter_title ? `(${rep.reporter_title})` : ""].filter(Boolean).join(" ")}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {editing && (
        <DailyReportModal
          projectId={project.id}
          initialDate={date}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            load();
            onSaved?.();
          }}
        />
      )}
    </div>
  );
}
