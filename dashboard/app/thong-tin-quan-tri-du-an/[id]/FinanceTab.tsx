"use client";

// Tab D. Tài chính (M6, P3) — chỉ BLĐ / GĐDA / TC-KT (mọi bảng ở đây là bảng tiền):
// • Tiến độ theo lý trình tại ngày t: GT HĐ, KH lũy kế (nội suy trong tháng), SL thực
//   tế, %KH, %TT, ΔP + nhãn, SPI, dự báo ngày hoàn thành (đặc tả 8.2, 8.4).
// • Tổng hợp A-B: nghiệm thu, đã thanh toán, phải thu CĐT, còn lại HĐ, tỷ lệ giải ngân.
// • Bảng B-B' theo nhà thầu: GTHĐ, %SL, %TT, SL chưa TT, OK / NOT OK (ngưỡng dự án).
// • Biểu đồ S-curve 4 đường lũy kế theo tháng.
// • Kế hoạch sản lượng / giải ngân theo tháng, có bản baseline + điều chỉnh.
// • Nghiệm thu & thanh toán theo hợp đồng.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useConfirmBox } from "@/components/ConfirmDialog";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  ACCEPTANCE_STATUS,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
  currentPlan,
  forecast,
  formatDate,
  formatMoneyShort,
  formatVnd,
  monthLabel,
  monthStart,
  monthsBetween,
  parseVnd,
  pct,
  pcDelete,
  pcErrorMessage,
  pcUpdate,
  planCumAt,
  progressLabel,
  todayVN,
  type PcAcceptance,
  type PcAccess,
  type PcAddendum,
  type PcContract,
  type PcContractFinance,
  type PcPayment,
  type PcPlanEntry,
  type PcProject,
  type PcProjectFinance,
  type PcSegment,
  type PcValueRow,
  fetchAllRows,
} from "@/lib/projectControl";
import { Card, Field, TextInput, Select, MoneyInput, PrimaryButton, ErrorLine, Modal } from "./ui";
import { Plus, Trash2, Loader2, Pencil, Lock, Copy } from "lucide-react";

type Data = {
  segments: PcSegment[];
  segValue: Map<string, number>; // GT HĐ A-B theo lý trình = Σ giá trị hạng mục
  contracts: PcContract[];
  cfin: Map<string, PcContractFinance>;
  addenda: PcAddendum[];
  values: PcValueRow[];
  plan: PcPlanEntry[];
  acceptances: PcAcceptance[];
  payments: PcPayment[];
};

export default function FinanceTab({
  project,
  finance,
  access,
}: {
  project: PcProject;
  finance: PcProjectFinance | null;
  access: PcAccess;
}) {
  const canEdit = access.can_edit_finance;
  const { ask, confirmNode } = useConfirmBox();
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [t, setT] = useState(todayVN());
  const [accFor, setAccFor] = useState<{ contract: PcContract; row: PcAcceptance | null } | null>(null);
  const [payFor, setPayFor] = useState<{ contract: PcContract; row: PcPayment | null } | null>(null);

  const load = useCallback(async () => {
    const pid = project.id;
    const [s, c, v, pl, ac, pa] = await Promise.all([
      supabase.from("pc_segments").select("*").eq("project_id", pid).order("km_start_m"),
      supabase.from("pc_contracts").select("*").eq("project_id", pid).order("created_at"),
      fetchAllRows<PcValueRow>((a, b) => supabase.from("pc_v_progress_value").select("*").eq("project_id", pid).order("id").range(a, b)),
      supabase.from("pc_plan_entries").select("*").eq("project_id", pid),
      supabase.from("pc_acceptances").select("*").eq("project_id", pid).order("period_no"),
      supabase.from("pc_payments").select("*").eq("project_id", pid).order("request_date"),
    ]);
    const firstErr = [s, c, v, pl, ac, pa].find((r) => r.error)?.error;
    setErr(firstErr ? pcErrorMessage(firstErr) : null);
    const segments = (s.data as PcSegment[]) || [];
    const contracts = (c.data as PcContract[]) || [];
    const segValue = new Map<string, number>();
    if (segments.length) {
      const { data: sw } = await supabase.from("pc_segment_wbs").select("id, segment_id, applicable").in("segment_id", segments.map((x) => x.id));
      const rows = (sw as { id: string; segment_id: string; applicable: boolean }[]) || [];
      if (rows.length) {
        const { data: f } = await supabase.from("pc_segment_wbs_finance").select("segment_wbs_id, budget_value").in("segment_wbs_id", rows.map((r) => r.id));
        const bySw = new Map(((f as { segment_wbs_id: string; budget_value: number | null }[]) || []).map((x) => [x.segment_wbs_id, Number(x.budget_value || 0)]));
        rows.forEach((r) => {
          if (r.applicable) segValue.set(r.segment_id, (segValue.get(r.segment_id) || 0) + (bySw.get(r.id) || 0));
        });
      }
    }
    const cfin = new Map<string, PcContractFinance>();
    let addenda: PcAddendum[] = [];
    if (contracts.length) {
      const ids = contracts.map((x) => x.id);
      const [f, a] = await Promise.all([
        supabase.from("pc_contract_finance").select("*").in("contract_id", ids),
        supabase.from("pc_contract_addenda").select("*").in("contract_id", ids),
      ]);
      ((f.data as PcContractFinance[]) || []).forEach((x) => cfin.set(x.contract_id, x));
      addenda = (a.data as PcAddendum[]) || [];
    }
    setData({
      segments,
      segValue,
      contracts,
      cfin,
      addenda,
      values: (v.data as PcValueRow[]) || [],
      plan: (pl.data as PcPlanEntry[]) || [],
      acceptances: (ac.data as PcAcceptance[]) || [],
      payments: (pa.data as PcPayment[]) || [],
    });
  }, [project.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const plan = useMemo(() => (data ? currentPlan(data.plan) : []), [data]);

  if (!access.can_view_finance)
    return (
      <div className="bg-white rounded-2xl border border-slate-100 p-10 text-center">
        <Lock size={26} className="mx-auto text-slate-300 mb-3" />
        <p className="text-sm font-bold text-slate-600">Chỉ Ban lãnh đạo, Giám đốc dự án và TC-KT xem được phần tài chính.</p>
      </div>
    );

  if (!data)
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="animate-spin text-[#005BAC]" size={26} />
      </div>
    );

  const upTo = (d: string) => d <= t;
  // Thu hồi tạm ứng TRỪ vào tổng đã thanh toán; các loại khác cộng.
  const paidAmt = (p: PcPayment) => (p.payment_type === "ADVANCE_RECOVERY" ? -1 : 1) * Number(p.paid_value || 0);
  const contractValue = (c: PcContract) =>
    Number(data.cfin.get(c.id)?.value_pre_vat || 0) +
    data.addenda.filter((a) => a.contract_id === c.id).reduce((s, a) => s + Number(a.value_change || 0), 0);

  // ─── Tiến độ theo lý trình tại ngày t ───
  const segRows = data.segments.map((s) => {
    const gt = data.segValue.get(s.id) || 0;
    const segPlan = plan.filter((p) => p.segment_id === s.id);
    const kh = planCumAt(segPlan, t);
    const vr = data.values.filter((r) => r.segment_id === s.id);
    const actual = vr.filter((r) => upTo(r.log_date)).reduce((a, r) => a + Number(r.value_a || 0), 0);
    const pKH = gt > 0 ? kh / gt : null;
    const pTT = gt > 0 ? actual / gt : null;
    const dp = pKH !== null && pTT !== null && segPlan.length ? pTT - pKH : null;
    const fc = forecast({
      rows: vr.map((r) => ({ log_date: r.log_date, v: Number(r.value_a || 0) })),
      t,
      contractValue: gt,
      actual,
      finishDate: s.planned_finish || project.finish_date,
    });
    return { s, gt, kh, actual, pKH, pTT, dp, spi: kh > 0 ? actual / kh : null, fc };
  });
  const tot = segRows.reduce(
    (a, r) => ({ gt: a.gt + r.gt, kh: a.kh + r.kh, actual: a.actual + r.actual }),
    { gt: 0, kh: 0, actual: 0 }
  );
  const totDp = tot.gt > 0 && plan.some((p) => p.segment_id) ? tot.actual / tot.gt - tot.kh / tot.gt : null;

  // ─── A-B ───
  const abIds = new Set(data.contracts.filter((c) => c.contract_type === "A_B").map((c) => c.id));
  const abValue = data.contracts.filter((c) => abIds.has(c.id)).reduce((a, c) => a + contractValue(c), 0) || Number(finance?.contract_value_pre_vat || 0);
  const accApproved = data.acceptances.filter((x) => abIds.has(x.contract_id) && x.status === "APPROVED").reduce((a, x) => a + Number(x.accepted_value || 0), 0);
  const paidIn = data.payments.filter((p) => p.direction === "IN" && p.status === "PAID" && (!p.paid_date || upTo(p.paid_date))).reduce((a, p) => a + paidAmt(p), 0);
  const paidOut = data.payments.filter((p) => p.direction === "OUT" && p.status === "PAID" && (!p.paid_date || upTo(p.paid_date))).reduce((a, p) => a + paidAmt(p), 0);
  const disbPlan = planCumAt(plan.filter((p) => !p.segment_id), t, "planned_disbursement");

  // ─── B-B' theo nhà thầu ───
  const threshold = Number(finance?.payment_threshold ?? 4000000000);
  const bbRows = data.contracts
    .filter((c) => c.contract_type === "B_B1")
    .map((c) => {
      const gt = contractValue(c);
      const sl = data.values.filter((r) => r.contract_id === c.id && upTo(r.log_date)).reduce((a, r) => a + Number(r.value_b || 0), 0);
      const paid = data.payments
        .filter((p) => p.contract_id === c.id && p.direction === "OUT" && p.status === "PAID" && (!p.paid_date || upTo(p.paid_date)))
        .reduce((a, p) => a + paidAmt(p), 0);
      const unpaid = sl - paid;
      return { c, gt, sl, paid, unpaid, ok: unpaid < threshold };
    });

  // ─── S-curve theo tháng ───
  const start = project.start_date || data.values.map((r) => r.log_date).sort()[0] || t;
  const end = project.finish_date && project.finish_date > t ? project.finish_date : t;
  const months = monthsBetween(start, end);
  const curve = months.map((m) => {
    const endOfMonth = lastDay(m);
    const cutoff = endOfMonth > t ? t : endOfMonth;
    const future = m > monthStart(t);
    return {
      month: monthLabel(m),
      "LK KH sản lượng": Math.round(planCumAt(plan.filter((p) => p.segment_id), endOfMonth) / 1e6) / 1000,
      "LK KH giải ngân": Math.round(planCumAt(plan.filter((p) => !p.segment_id), endOfMonth, "planned_disbursement") / 1e6) / 1000,
      "LK thực tế": future
        ? null
        : Math.round(data.values.filter((r) => r.log_date <= cutoff).reduce((a, r) => a + Number(r.value_a || 0), 0) / 1e6) / 1000,
      "LK thanh toán": future
        ? null
        : Math.round(
            data.payments
              .filter((p) => p.direction === "IN" && p.status === "PAID" && (p.paid_date || "") <= cutoff)
              .reduce((a, p) => a + paidAmt(p), 0) / 1e6
          ) / 1000,
    };
  });

  return (
    <div className="space-y-4">
      <ErrorLine msg={err} />

      <div className="flex items-center gap-2">
        <span className="text-[11px] font-bold text-slate-500">Số liệu tính đến ngày</span>
        <input
          type="date"
          value={t}
          onChange={(e) => e.target.value && setT(e.target.value)}
          className="text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg px-3 py-1.5"
        />
        {t !== todayVN() && (
          <button onClick={() => setT(todayVN())} className="text-[11px] font-bold text-[#005BAC]">
            Về hôm nay
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat label="GT HĐ A-B (hiện hành)" value={formatMoneyShort(abValue)} />
        <Stat label="Sản lượng lũy kế" value={formatMoneyShort(tot.actual)} sub={abValue ? pct(tot.actual / abValue) : undefined} />
        <Stat label="CĐT đã thanh toán" value={formatMoneyShort(paidIn)} sub={disbPlan ? `Giải ngân ${pct(paidIn / disbPlan)} KH` : undefined} />
        <Stat label="Phải thu CĐT" value={formatMoneyShort(accApproved - paidIn)} sub={`NT duyệt ${formatMoneyShort(accApproved)}`} />
        <Stat label="Đã trả nhà thầu" value={formatMoneyShort(paidOut)} sub={`Dòng tiền ròng ${formatMoneyShort(paidIn - paidOut)}`} />
      </div>

      {/* ─── Tiến độ theo lý trình ─── */}
      <Card title="Tiến độ sản lượng theo lý trình">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-[11px]">
            <thead>
              <tr className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 text-right">
                <th className="py-1.5 text-left">Lý trình</th>
                <th className="px-2">GT HĐ</th>
                <th className="px-2">KH lũy kế</th>
                <th className="px-2">SL thực tế</th>
                <th className="px-2">%KH</th>
                <th className="px-2">%TT</th>
                <th className="px-2 text-left">Đánh giá</th>
                <th className="px-2">SPI</th>
                <th className="px-2">Tốc độ 28 ngày</th>
                <th className="px-2">HT dự báo</th>
              </tr>
            </thead>
            <tbody>
              {segRows.map((r) => {
                const lb = progressLabel(r.dp);
                return (
                  <tr key={r.s.id} className="border-t border-slate-100 text-right">
                    <td className="py-1.5 text-left font-bold text-slate-700">{r.s.code}</td>
                    <td className="px-2 font-mono">{r.gt ? formatMoneyShort(r.gt) : <span className="text-slate-300">chưa có đơn giá</span>}</td>
                    <td className="px-2 font-mono">{formatMoneyShort(r.kh)}</td>
                    <td className="px-2 font-mono font-semibold">{formatMoneyShort(r.actual)}</td>
                    <td className="px-2">{pct(r.pKH)}</td>
                    <td className="px-2">{pct(r.pTT)}</td>
                    <td className="px-2 text-left">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${lb.cls}`}>{lb.label}</span>
                    </td>
                    <td className="px-2">{r.spi !== null ? r.spi.toFixed(2) : "—"}</td>
                    <td className="px-2 font-mono">{r.fc.speed > 0 ? `${formatMoneyShort(r.fc.speed)}/ngày` : "—"}</td>
                    <td className="px-2">
                      {r.fc.forecastDate ? formatDate(r.fc.forecastDate) : "—"}
                      {r.fc.delayDays !== null && r.fc.delayDays > 0 && <span className="block text-[10px] font-bold text-rose-600">trễ {r.fc.delayDays} ngày</span>}
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t-2 border-slate-200 text-right font-bold">
                <td className="py-1.5 text-left">Cả dự án</td>
                <td className="px-2 font-mono">{formatMoneyShort(tot.gt)}</td>
                <td className="px-2 font-mono">{formatMoneyShort(tot.kh)}</td>
                <td className="px-2 font-mono">{formatMoneyShort(tot.actual)}</td>
                <td className="px-2">{tot.gt ? pct(tot.kh / tot.gt) : "—"}</td>
                <td className="px-2">{tot.gt ? pct(tot.actual / tot.gt) : "—"}</td>
                <td className="px-2 text-left">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${progressLabel(totDp).cls}`}>{progressLabel(totDp).label}</span>
                </td>
                <td colSpan={3} />
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-[10px] text-slate-400 mt-2">
          GT HĐ lý trình = Σ (KL HĐ × đơn giá A-B) các hạng mục · KH lũy kế nội suy theo ngày trong tháng · Chỉ nhật ký ĐÃ DUYỆT.
        </p>
      </Card>

      {/* ─── S-curve ─── */}
      <Card title="Biểu đồ lũy kế (tỷ đồng)">
        {months.length < 2 ? (
          <p className="text-xs italic text-slate-400">Cần ngày khởi công / hoàn thành ở tab Tổng quan để dựng trục thời gian.</p>
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={curve} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v) => (v == null ? "—" : `${Number(v).toLocaleString("vi-VN")} tỷ`)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="LK KH sản lượng" stroke="#94a3b8" strokeDasharray="5 4" dot={false} />
                <Line type="monotone" dataKey="LK KH giải ngân" stroke="#f59e0b" strokeDasharray="5 4" dot={false} />
                <Line type="monotone" dataKey="LK thực tế" stroke="#005BAC" strokeWidth={2} dot={false} connectNulls={false} />
                <Line type="monotone" dataKey="LK thanh toán" stroke="#10b981" strokeWidth={2} dot={false} connectNulls={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* ─── B-B' theo nhà thầu ─── */}
      <Card title={`Thanh toán B-B' theo nhà thầu — ngưỡng cảnh báo ${formatMoneyShort(threshold)}`}>
        {bbRows.length === 0 ? (
          <p className="text-xs italic text-slate-400">Chưa có HĐ B-B&apos;.</p>
        ) : (
          <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full min-w-[720px] text-[11px]">
            <thead>
              <tr className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 text-right">
                <th className="py-1.5 text-left">Nhà thầu</th>
                <th className="px-2">GT HĐ</th>
                <th className="px-2">Sản lượng</th>
                <th className="px-2">% SL</th>
                <th className="px-2">Đã thanh toán</th>
                <th className="px-2">% TT</th>
                <th className="px-2">SL chưa TT</th>
                <th className="px-2 text-center">Cờ</th>
              </tr>
            </thead>
            <tbody>
              {bbRows.map((r) => (
                <tr key={r.c.id} className="border-t border-slate-100 text-right">
                  <td className="py-1.5 text-left font-semibold text-slate-700">{r.c.partner_name}</td>
                  <td className="px-2 font-mono">{formatMoneyShort(r.gt)}</td>
                  <td className="px-2 font-mono">{formatMoneyShort(r.sl)}</td>
                  <td className="px-2">{r.gt ? pct(r.sl / r.gt) : "—"}</td>
                  <td className="px-2 font-mono">{formatMoneyShort(r.paid)}</td>
                  <td className="px-2">{r.gt ? pct(r.paid / r.gt) : "—"}</td>
                  <td className="px-2 font-mono font-semibold">{formatMoneyShort(r.unpaid)}</td>
                  <td className="px-2 text-center">
                    <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${r.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                      {r.ok ? "OK" : "NOT OK"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        <p className="text-[10px] text-slate-400 mt-2">
          Sản lượng B-B&apos; = KL đã duyệt × đơn giá B-B&apos; (nhập ở tab Nhà thầu &amp; Hợp đồng). Ngưỡng đổi ở tab Tổng quan.
        </p>
      </Card>

      <PlanEditor project={project} entries={data.plan} segments={data.segments} canEdit={canEdit} onSaved={load} />

      {/* ─── Nghiệm thu & thanh toán ─── */}
      <Card title="Nghiệm thu & thanh toán theo hợp đồng">
        {data.contracts.length === 0 ? (
          <p className="text-xs italic text-slate-400">Chưa có hợp đồng.</p>
        ) : (
          <div className="space-y-3">
            {data.contracts.map((c) => {
              const accs = data.acceptances.filter((a) => a.contract_id === c.id);
              const pays = data.payments.filter((p) => p.contract_id === c.id);
              return (
                <div key={c.id} className="border border-slate-100 rounded-xl p-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 shrink-0">
                      {c.contract_type === "A_B" ? "A-B" : "B-B'"}
                    </span>
                    <span className="text-xs font-extrabold text-slate-800 flex-1 min-w-0">{c.partner_name}</span>
                    <div className="flex items-center gap-3 basis-full sm:basis-auto sm:shrink-0">
                      <span className="text-[11px] font-mono text-slate-500 shrink-0">GT {formatMoneyShort(contractValue(c))}</span>
                      {canEdit && (
                        <>
                          <button onClick={() => setAccFor({ contract: c, row: null })} className="text-[10px] font-bold text-[#005BAC] flex items-center gap-0.5 shrink-0">
                            <Plus size={11} /> Nghiệm thu
                          </button>
                          <button onClick={() => setPayFor({ contract: c, row: null })} className="text-[10px] font-bold text-[#005BAC] flex items-center gap-0.5 shrink-0">
                            <Plus size={11} /> Thanh toán
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {accs.map((a) => (
                    <div key={a.id} className="flex items-center gap-2 text-[11px] pl-2">
                      <span className="w-24 font-semibold text-slate-600">NT đợt {a.period_no ?? "?"}</span>
                      <span className="w-44 text-slate-400">
                        {formatDate(a.period_from)} – {formatDate(a.period_to)}
                      </span>
                      <span className="w-28 font-mono text-right">{formatMoneyShort(a.accepted_value)}</span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${ACCEPTANCE_STATUS[a.status].cls}`}>{ACCEPTANCE_STATUS[a.status].label}</span>
                      <span className="flex-1 truncate text-slate-400">{a.note}</span>
                      {canEdit && (
                        <RowActions
                          onEdit={() => setAccFor({ contract: c, row: a })}
                          onDelete={() => ask({ title: "Xoá đợt nghiệm thu này?", onConfirm: async () => { const e = await pcDelete("pc_acceptances", { id: a.id }); if (e) setErr(e); load(); } })}
                        />
                      )}
                    </div>
                  ))}
                  {pays.map((p) => (
                    <div key={p.id} className="flex items-center gap-2 text-[11px] pl-2">
                      <span className="w-24 font-semibold text-slate-600 truncate">{PAYMENT_TYPES[p.payment_type]}</span>
                      <span className="w-44 text-slate-400">
                        ĐN {formatDate(p.request_date)}
                        {p.paid_date ? ` · TT ${formatDate(p.paid_date)}` : ""}
                      </span>
                      <span className="w-28 font-mono text-right">{formatMoneyShort(p.status === "PAID" ? p.paid_value : p.request_value)}</span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${PAYMENT_STATUS[p.status].cls}`}>{PAYMENT_STATUS[p.status].label}</span>
                      <span className="flex-1 truncate text-slate-400">{p.note}</span>
                      {canEdit && (
                        <RowActions
                          onEdit={() => setPayFor({ contract: c, row: p })}
                          onDelete={() => ask({ title: "Xoá khoản thanh toán này?", onConfirm: async () => { const e = await pcDelete("pc_payments", { id: p.id }); if (e) setErr(e); load(); } })}
                        />
                      )}
                    </div>
                  ))}
                  {accs.length === 0 && pays.length === 0 && <p className="text-[11px] italic text-slate-400 pl-2">Chưa có nghiệm thu / thanh toán.</p>}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {accFor && (
        <AcceptanceModal
          projectId={project.id}
          contract={accFor.contract}
          row={accFor.row}
          nextNo={data.acceptances.filter((a) => a.contract_id === accFor.contract.id).reduce((m, a) => Math.max(m, a.period_no || 0), 0) + 1}
          onClose={() => setAccFor(null)}
          onSaved={() => {
            setAccFor(null);
            load();
          }}
        />
      )}
      {payFor && (
        <PaymentModal
          projectId={project.id}
          contract={payFor.contract}
          row={payFor.row}
          acceptances={data.acceptances.filter((a) => a.contract_id === payFor.contract.id)}
          onClose={() => setPayFor(null)}
          onSaved={() => {
            setPayFor(null);
            load();
          }}
        />
      )}
      {confirmNode}
    </div>
  );
}

function lastDay(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${m.slice(0, 8)}${String(d).padStart(2, "0")}`;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm px-4 py-3">
      <p className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="text-base font-extrabold font-mono text-slate-800 mt-1">{value}</p>
      {sub && <p className="text-[10px] text-slate-400 font-semibold">{sub}</p>}
    </div>
  );
}

function RowActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <span className="flex gap-1.5">
      <button onClick={onEdit} className="text-slate-300 hover:text-[#005BAC]">
        <Pencil size={11} />
      </button>
      <button onClick={onDelete} className="text-slate-300 hover:text-rose-500">
        <Trash2 size={11} />
      </button>
    </span>
  );
}

// ─── Kế hoạch theo tháng: hàng = lý trình (KH sản lượng) + 1 hàng KH giải ngân cả dự án ───
function PlanEditor({
  project,
  entries,
  segments,
  canEdit,
  onSaved,
}: {
  project: PcProject;
  entries: PcPlanEntry[];
  segments: PcSegment[];
  canEdit: boolean;
  onSaved: () => void;
}) {
  const maxVersion = entries.reduce((m, e) => Math.max(m, e.version), 0);
  const [version, setVersion] = useState(maxVersion);
  const [cells, setCells] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const start = project.start_date || todayVN();
  const end = project.finish_date && project.finish_date > start ? project.finish_date : `${Number(start.slice(0, 4)) + 1}${start.slice(4)}`;
  const months = monthsBetween(start, end);

  const inVersion = entries.filter((e) => e.version === version);
  const key = (seg: string | null, m: string) => `${seg || "P"}|${m}`;
  const stored = (seg: string | null, m: string) => {
    const e = inVersion.find((x) => (x.segment_id || null) === seg && x.period_month === m);
    if (!e) return "";
    const v = seg ? e.planned_value : e.planned_disbursement;
    return v != null ? formatVnd(v) : "";
  };
  const cellVal = (seg: string | null, m: string) => cells[key(seg, m)] ?? stored(seg, m);

  async function save() {
    setSaving(true);
    setErr(null);
    setMsg(null);
    for (const [k, raw] of Object.entries(cells)) {
      const [segPart, m] = k.split("|");
      const seg = segPart === "P" ? null : segPart;
      const v = parseVnd(raw);
      const existing = inVersion.find((x) => (x.segment_id || null) === seg && x.period_month === m);
      const patch = seg ? { planned_value: v } : { planned_disbursement: v };
      let e: string | null = null;
      if (existing) e = await pcUpdate("pc_plan_entries", { id: existing.id }, patch);
      else if (v != null) {
        const { error } = await supabase
          .from("pc_plan_entries")
          .insert({ project_id: project.id, segment_id: seg, period_month: m, version, ...patch });
        if (error) e = pcErrorMessage(error);
      }
      if (e) {
        setSaving(false);
        return setErr(e);
      }
    }
    setSaving(false);
    setCells({});
    setMsg("Đã lưu kế hoạch.");
    onSaved();
  }

  // Bản điều chỉnh mới = chép toàn bộ bản đang xem sang version + 1.
  async function newRevision() {
    const next = maxVersion + 1;
    setSaving(true);
    setErr(null);
    const rows = inVersion.map((e) => ({
      project_id: project.id,
      segment_id: e.segment_id,
      period_month: e.period_month,
      planned_value: e.planned_value,
      planned_disbursement: e.planned_disbursement,
      version: next,
    }));
    if (rows.length) {
      const { error } = await supabase.from("pc_plan_entries").insert(rows);
      if (error) {
        setSaving(false);
        return setErr(pcErrorMessage(error));
      }
    }
    setSaving(false);
    setVersion(next);
    setMsg(`Đã tạo Điều chỉnh ${next}. Sửa số rồi bấm Lưu.`);
    onSaved();
  }

  const versions = Array.from({ length: maxVersion + 1 }, (_, i) => i);
  const rowsDef: { seg: string | null; label: string }[] = [
    ...segments.map((s) => ({ seg: s.id, label: s.code })),
    { seg: null, label: "KH giải ngân (cả dự án)" },
  ];

  return (
    <Card
      title="Kế hoạch sản lượng & giải ngân theo tháng"
      action={
        <div className="flex flex-wrap items-center gap-2 basis-full sm:basis-auto">
          <select
            value={version}
            onChange={(e) => {
              setVersion(Number(e.target.value));
              setCells({});
            }}
            className="text-[11px] font-bold text-slate-600 bg-white border border-slate-200 rounded-lg px-2 py-1"
          >
            {versions.map((v) => (
              <option key={v} value={v}>
                {v === 0 ? "Baseline" : `Điều chỉnh ${v}`}
                {v === maxVersion ? " (hiện hành)" : ""}
              </option>
            ))}
          </select>
          {canEdit && (
            <>
              <button
                onClick={newRevision}
                disabled={saving}
                className="flex items-center gap-1 text-[11px] font-bold text-slate-600 border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-slate-50"
              >
                <Copy size={11} /> Tạo bản điều chỉnh
              </button>
              <PrimaryButton onClick={save} busy={saving} disabled={Object.keys(cells).length === 0}>
                Lưu kế hoạch
              </PrimaryButton>
            </>
          )}
        </div>
      }
    >
      {segments.length === 0 ? (
        <p className="text-xs italic text-slate-400">Chưa có lý trình.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="text-[11px] border-collapse">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-white text-left text-[10px] font-extrabold uppercase text-slate-400 px-2 py-1.5 min-w-[160px]">
                  Lý trình / tháng
                </th>
                {months.map((m) => (
                  <th key={m} className="text-[10px] font-extrabold text-slate-400 px-1 py-1.5 min-w-[110px]">
                    {monthLabel(m)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowsDef.map((r) => (
                <tr key={r.seg || "P"} className="border-t border-slate-100">
                  <td className={`sticky left-0 z-10 bg-white px-2 py-1 font-bold ${r.seg ? "text-slate-700" : "text-amber-700"}`}>{r.label}</td>
                  {months.map((m) => (
                    <td key={m} className="px-1 py-1">
                      <input
                        value={cellVal(r.seg, m)}
                        disabled={!canEdit || version !== maxVersion}
                        onChange={(e) => setCells((c) => ({ ...c, [key(r.seg, m)]: e.target.value.replace(/[^\d.]/g, "") }))}
                        onBlur={(e) => {
                          const d = e.target.value.replace(/\D/g, "");
                          if (key(r.seg, m) in cells) setCells((c) => ({ ...c, [key(r.seg, m)]: d ? formatVnd(parseInt(d, 10)) : "" }));
                        }}
                        className="w-full text-right font-mono text-[11px] bg-slate-50 border border-slate-100 rounded px-1.5 py-1 focus:outline-none focus:border-[#00AEEF] disabled:text-slate-500"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[10px] text-slate-400 mt-2">
        Đơn vị: đồng. Chỉ sửa được bản hiện hành; bản cũ giữ để so sánh. Muốn điều chỉnh kế hoạch thì bấm &quot;Tạo bản điều chỉnh&quot;.
      </p>
      <ErrorLine msg={err} />
      {msg && <p className="text-[11px] font-semibold text-emerald-600">{msg}</p>}
    </Card>
  );
}

function AcceptanceModal({
  projectId,
  contract,
  row,
  nextNo,
  onClose,
  onSaved,
}: {
  projectId: string;
  contract: PcContract;
  row: PcAcceptance | null;
  nextNo: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState(() => ({
    period_no: String(row?.period_no ?? nextNo),
    period_from: row?.period_from || "",
    period_to: row?.period_to || "",
    value: row ? formatVnd(row.accepted_value) : "",
    status: row?.status || "DRAFT",
    note: row?.note || "",
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function save() {
    const v = parseVnd(f.value);
    if (v == null) return setErr("Nhập giá trị nghiệm thu.");
    setSaving(true);
    const payload = {
      period_no: f.period_no ? parseInt(f.period_no, 10) : null,
      period_from: f.period_from || null,
      period_to: f.period_to || null,
      accepted_value: v,
      status: f.status,
      note: f.note.trim() || null,
    };
    let e: string | null = null;
    if (row) e = await pcUpdate("pc_acceptances", { id: row.id }, payload);
    else {
      const { error } = await supabase.from("pc_acceptances").insert({ ...payload, project_id: projectId, contract_id: contract.id });
      if (error) e = pcErrorMessage(error);
    }
    setSaving(false);
    if (e) return setErr(e);
    onSaved();
  }

  return (
    <Modal title={`${row ? "Sửa" : "Thêm"} nghiệm thu — ${contract.partner_name}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Đợt">
          <TextInput value={f.period_no} onChange={set("period_no")} inputMode="numeric" />
        </Field>
        <Field label="Trạng thái">
          <Select value={f.status} onChange={set("status")}>
            {Object.entries(ACCEPTANCE_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Từ ngày">
          <TextInput type="date" value={f.period_from} onChange={set("period_from")} />
        </Field>
        <Field label="Đến ngày">
          <TextInput type="date" value={f.period_to} onChange={set("period_to")} />
        </Field>
        <Field label="Giá trị nghiệm thu" className="col-span-2">
          <MoneyInput value={f.value} onChange={(v) => setF((x) => ({ ...x, value: v }))} />
        </Field>
        <Field label="Ghi chú" className="col-span-2">
          <TextInput value={f.note} onChange={set("note")} />
        </Field>
      </div>
      <ErrorLine msg={err} />
      <div className="flex justify-end">
        <PrimaryButton onClick={save} busy={saving}>
          Lưu
        </PrimaryButton>
      </div>
    </Modal>
  );
}

function PaymentModal({
  projectId,
  contract,
  row,
  acceptances,
  onClose,
  onSaved,
}: {
  projectId: string;
  contract: PcContract;
  row: PcPayment | null;
  acceptances: PcAcceptance[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState(() => ({
    payment_type: row?.payment_type || "PROGRESS",
    acceptance_id: row?.acceptance_id || "",
    request_date: row?.request_date || todayVN(),
    request_value: row?.request_value != null ? formatVnd(row.request_value) : "",
    paid_date: row?.paid_date || "",
    paid_value: row?.paid_value != null ? formatVnd(row.paid_value) : "",
    status: row?.status || "REQUESTED",
    note: row?.note || "",
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function save() {
    if (f.status === "PAID" && (!f.paid_date || parseVnd(f.paid_value) == null))
      return setErr("Đã thanh toán thì phải có ngày và số tiền thực trả.");
    setSaving(true);
    const payload = {
      payment_type: f.payment_type,
      acceptance_id: f.acceptance_id || null,
      direction: contract.contract_type === "A_B" ? "IN" : "OUT",
      request_date: f.request_date || null,
      request_value: parseVnd(f.request_value),
      paid_date: f.paid_date || null,
      paid_value: parseVnd(f.paid_value),
      status: f.status,
      note: f.note.trim() || null,
    };
    let e: string | null = null;
    if (row) e = await pcUpdate("pc_payments", { id: row.id }, payload);
    else {
      const { error } = await supabase.from("pc_payments").insert({ ...payload, project_id: projectId, contract_id: contract.id });
      if (error) e = pcErrorMessage(error);
    }
    setSaving(false);
    if (e) return setErr(e);
    onSaved();
  }

  return (
    <Modal
      title={`${row ? "Sửa" : "Thêm"} thanh toán ${contract.contract_type === "A_B" ? "(CĐT trả Lodeza EOP)" : "(Lodeza EOP trả nhà thầu)"} — ${contract.partner_name}`}
      onClose={onClose}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Loại">
          <Select value={f.payment_type} onChange={set("payment_type")}>
            {Object.entries(PAYMENT_TYPES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Theo nghiệm thu">
          <Select value={f.acceptance_id} onChange={set("acceptance_id")}>
            <option value="">—</option>
            {acceptances.map((a) => (
              <option key={a.id} value={a.id}>
                Đợt {a.period_no} ({formatMoneyShort(a.accepted_value)})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Ngày đề nghị">
          <TextInput type="date" value={f.request_date} onChange={set("request_date")} />
        </Field>
        <Field label="Giá trị đề nghị">
          <MoneyInput value={f.request_value} onChange={(v) => setF((x) => ({ ...x, request_value: v }))} />
        </Field>
        <Field label="Trạng thái">
          <Select value={f.status} onChange={set("status")}>
            {Object.entries(PAYMENT_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </Field>
        <div />
        <Field label="Ngày thực thanh toán">
          <TextInput type="date" value={f.paid_date} onChange={set("paid_date")} />
        </Field>
        <Field label="Số tiền thực thanh toán">
          <MoneyInput value={f.paid_value} onChange={(v) => setF((x) => ({ ...x, paid_value: v }))} />
        </Field>
        <Field label="Ghi chú" className="col-span-2">
          <TextInput value={f.note} onChange={set("note")} />
        </Field>
      </div>
      <p className="text-[10px] text-slate-400">Loại &quot;Thu hồi tạm ứng&quot; được tự trừ vào tổng đã thanh toán.</p>
      <ErrorLine msg={err} />
      <div className="flex justify-end">
        <PrimaryButton onClick={save} busy={saving}>
          Lưu
        </PrimaryButton>
      </div>
    </Modal>
  );
}
