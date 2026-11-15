"use client";

// Tab E. Vật tư (M7, P5 — đặc tả 6.6, 7.7, 8.7):
// • Dự toán vật tư theo lý trình × hạng mục × vật tư (định mức, KL dự toán) — nhập
//   tay hoặc import Excel theo file mẫu.
// • Cấp phát theo phiếu (ngày, KL, nhà thầu nhận, NCC, số phiếu, đơn giá thực tế).
// • Tự tính: cấp phát LK, % đã cấp, KL cần theo SL, hao hụt, còn lại, còn cần,
//   thiếu hụt dự kiến, tồn công trường, ngày hết dự báo (tiêu thụ BQ 14 ngày).
// • Giá: đơn giá dự toán / thực tế / thị trường, % trượt giá, biến phí giá — chỉ
//   BLĐ / GĐDA / TC-KT / vai trò Vật tư thấy.

import { useCallback, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import { useConfirmBox } from "@/components/ConfirmDialog";
import {
  MATERIAL_GROUPS,
  fetchAllRows,
  formatDate,
  formatKm,
  formatMoneyShort,
  formatVnd,
  materialMetrics,
  parseVnd,
  pct,
  pcDelete,
  pcErrorMessage,
  pcUpdate,
  pcUpsert,
  todayVN,
  type PcAccess,
  type PcContract,
  type PcMaterial,
  type PcMaterialBudget,
  type PcMaterialIssue,
  type PcMaterialPrice,
  type PcMaterialStatus,
  type PcRiskConfig,
  type PcSegment,
  type PcSegmentWbs,
  type PcWbsItem,
} from "@/lib/projectControl";
import { Card, Field, TextInput, Select, MoneyInput, PrimaryButton, ErrorLine, Modal } from "./ui";
import { Plus, Pencil, Trash2, Loader2, Upload, Download, PackagePlus, AlertTriangle, Tag, Truck } from "lucide-react";

type Ctx = {
  segments: PcSegment[];
  catalog: PcWbsItem[];
  wbs: PcSegmentWbs[];
  contracts: PcContract[];
  materials: PcMaterial[];
  status: PcMaterialStatus[];
  budgets: PcMaterialBudget[];
  budgetPrice: Map<string, number | null>;
  issues: PcMaterialIssue[];
  issuePrice: Map<string, number | null>;
  market: Map<string, PcMaterialPrice>; // giá thị trường mới nhất theo vật tư
  cfg: Pick<PcRiskConfig, "mat_days_warn" | "mat_waste_warn" | "mat_price_warn"> | null;
};

type BudgetRow = PcMaterialBudget & { pc_material_budget_prices: unknown };
type IssueRow = PcMaterialIssue & { pc_material_issue_prices: unknown };

// Bảng con 1-1 PostgREST trả object hoặc mảng tuỳ cách nhận quan hệ -> đọc cả hai.
function embedded(v: unknown, key: string): number | null {
  const o = Array.isArray(v) ? v[0] : v;
  const x = o && typeof o === "object" ? (o as Record<string, unknown>)[key] : null;
  return x == null ? null : Number(x);
}

const num = (s: string) => {
  const v = parseFloat((s || "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(v) ? v : null;
};
const fmtQ = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(v) ? "—" : Number(v).toLocaleString("vi-VN", { maximumFractionDigits: d });

export default function MaterialTab({ projectId, access }: { projectId: string; access: PcAccess }) {
  const canEdit = access.can_edit_material;
  const canPrice = access.can_view_material_price;
  const { ask, confirmNode } = useConfirmBox();
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [segFilter, setSegFilter] = useState<string | null>(null);
  const [onlyProblem, setOnlyProblem] = useState(false);
  const [budgetEdit, setBudgetEdit] = useState<PcMaterialBudget | "new" | null>(null);
  const [issueFor, setIssueFor] = useState<{ budgetId: string | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);

  const load = useCallback(async () => {
    const [s, c, co, mt, st, bu, is, mp, cf] = await Promise.all([
      supabase.from("pc_segments").select("*").eq("project_id", projectId).order("km_start_m"),
      supabase.from("pc_wbs_items").select("*").order("sort_order"),
      supabase.from("pc_contracts").select("*").eq("project_id", projectId).eq("contract_type", "B_B1"),
      supabase.from("pc_materials").select("*").order("code"),
      fetchAllRows<PcMaterialStatus>((a, b) => supabase.from("pc_v_material_status").select("*").eq("project_id", projectId).order("material_budget_id").range(a, b)),
      // Nhúng bảng giá (RLS bảng con vẫn áp dụng: không có quyền -> giá rỗng). Không dùng
      // .in(hàng trăm id) vì URL quá dài.
      fetchAllRows<BudgetRow>((a, b) =>
        supabase.from("pc_material_budgets").select("*, pc_material_budget_prices(budget_unit_price)").eq("project_id", projectId).order("id").range(a, b)
      ),
      fetchAllRows<IssueRow>((a, b) =>
        supabase
          .from("pc_material_issues")
          .select("*, pc_material_issue_prices(actual_unit_price)")
          .eq("project_id", projectId)
          .order("issue_date", { ascending: false })
          .order("id")
          .range(a, b)
      ),
      supabase.from("pc_material_prices").select("*").order("effective_date", { ascending: false }).limit(1000),
      supabase.from("pc_risk_config").select("mat_days_warn, mat_waste_warn, mat_price_warn").eq("project_id", projectId).maybeSingle(),
    ]);
    const firstErr = [s, mt, st, bu, is].find((r) => r.error)?.error;
    setErr(firstErr ? pcErrorMessage(firstErr) : null);
    const segments = (s.data as PcSegment[]) || [];
    const { data: w } = segments.length ? await supabase.from("pc_segment_wbs").select("*").in("segment_id", segments.map((x) => x.id)) : { data: [] };
    const budgetPrice = new Map<string, number | null>();
    const issuePrice = new Map<string, number | null>();
    const budgets: PcMaterialBudget[] = bu.data.map((r) => {
      const v = embedded(r.pc_material_budget_prices, "budget_unit_price");
      if (canPrice && v != null) budgetPrice.set(r.id, v);
      const { pc_material_budget_prices: _drop, ...rest } = r;
      void _drop;
      return rest;
    });
    const issues: PcMaterialIssue[] = is.data.map((r) => {
      const v = embedded(r.pc_material_issue_prices, "actual_unit_price");
      if (canPrice && v != null) issuePrice.set(r.id, v);
      const { pc_material_issue_prices: _drop, ...rest } = r;
      void _drop;
      return rest;
    });
    const market = new Map<string, PcMaterialPrice>();
    const today = todayVN();
    ((mp.data as PcMaterialPrice[]) || []).forEach((p) => {
      if (p.effective_date <= today && !market.has(p.material_id)) market.set(p.material_id, p);
    });
    setCtx({
      segments,
      catalog: (c.data as PcWbsItem[]) || [],
      wbs: (w as PcSegmentWbs[]) || [],
      contracts: (co.data as PcContract[]) || [],
      materials: (mt.data as PcMaterial[]) || [],
      status: st.data,
      budgets,
      budgetPrice,
      issues,
      issuePrice,
      market,
      cfg: (cf.data as Ctx["cfg"]) || null,
    });
  }, [projectId, canPrice]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const rows = useMemo(() => {
    if (!ctx) return [];
    const segById = new Map(ctx.segments.map((s) => [s.id, s]));
    const swById = new Map(ctx.wbs.map((w) => [w.id, w]));
    const itemById = new Map(ctx.catalog.map((c) => [c.id, c]));
    const matById = new Map(ctx.materials.map((m) => [m.id, m]));
    const budById = new Map(ctx.budgets.map((b) => [b.id, b]));
    return ctx.status
      .map((x) => {
        const m = materialMetrics(x, ctx.cfg || undefined);
        const seg = segById.get(x.segment_id);
        const sw = swById.get(x.segment_wbs_id);
        const item = sw ? itemById.get(sw.wbs_item_id) : undefined;
        const mat = matById.get(x.material_id);
        // Giá: dự toán, thực tế bình quân gia quyền theo phiếu, thị trường mới nhất.
        const bp = ctx.budgetPrice.get(x.material_budget_id) ?? null;
        const iss = ctx.issues.filter((i) => i.material_budget_id === x.material_budget_id);
        const priced = iss.filter((i) => ctx.issuePrice.get(i.id) != null);
        const pricedQty = priced.reduce((a, i) => a + Number(i.qty), 0);
        const avgActual = pricedQty > 0 ? priced.reduce((a, i) => a + Number(i.qty) * Number(ctx.issuePrice.get(i.id)), 0) / pricedQty : null;
        const variance = bp != null ? priced.reduce((a, i) => a + (Number(ctx.issuePrice.get(i.id)) - bp) * Number(i.qty), 0) : null;
        const mk = ctx.market.get(x.material_id)?.price ?? null;
        const slip = bp && mk != null ? (mk - bp) / bp : null;
        return { x, m, seg, sw, item, mat, budget: budById.get(x.material_budget_id), bp, avgActual, variance, mk, slip };
      })
      .filter((r) => (!segFilter || r.x.segment_id === segFilter) && (!onlyProblem || r.m.problem))
      .sort((a, b) =>
        (a.seg?.km_start_m ?? 0) - (b.seg?.km_start_m ?? 0) || (a.item?.sort_order ?? 0) - (b.item?.sort_order ?? 0) || (a.mat?.code || "").localeCompare(b.mat?.code || "")
      );
  }, [ctx, segFilter, onlyProblem]);

  if (!ctx)
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="animate-spin text-[#005BAC]" size={26} />
      </div>
    );

  const allMetrics = ctx.status.map((x) => materialMetrics(x, ctx.cfg || undefined));
  const priceWarn = Number(ctx.cfg?.mat_price_warn ?? 0.1);
  const totalVariance = rows.reduce((a, r) => a + (r.variance || 0), 0);
  const segCodeOf = (budgetId: string) => {
    const x = ctx.status.find((s) => s.material_budget_id === budgetId);
    return ctx.segments.find((s) => s.id === x?.segment_id)?.code || "?";
  };
  const matOfBudget = (budgetId: string) => ctx.materials.find((m) => m.id === ctx.budgets.find((b) => b.id === budgetId)?.material_id);

  function removeBudget(b: PcMaterialBudget) {
    ask({
      title: "Xoá dòng dự toán vật tư này?",
      message: "Mọi phiếu cấp phát của dòng này cũng bị xoá.",
      onConfirm: async () => {
        const e = await pcDelete("pc_material_budgets", { id: b.id });
        if (e) setErr(e);
        load();
      },
    });
  }

  function removeIssue(i: PcMaterialIssue) {
    ask({
      title: `Xoá phiếu cấp phát ${i.doc_no || ""}?`,
      onConfirm: async () => {
        const e = await pcDelete("pc_material_issues", { id: i.id });
        if (e) setErr(e);
        load();
      },
    });
  }

  return (
    <div className="space-y-4">
      <ErrorLine msg={err} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Dòng dự toán vật tư" value={String(ctx.status.length)} />
        <Stat label="Dòng có vấn đề" value={String(allMetrics.filter((m) => m.problem).length)} tone={allMetrics.some((m) => m.problem) ? "text-amber-600" : undefined} />
        <Stat label="Sắp hết" value={String(allMetrics.filter((m) => m.runningOut).length)} tone={allMetrics.some((m) => m.runningOut) ? "text-rose-600" : undefined} />
        <Stat label="Biến phí giá (đã cấp)" value={canPrice ? formatMoneyShort(totalVariance) : "🔒"} tone={totalVariance > 0 ? "text-rose-600" : undefined} />
      </div>

      <Card
        title="Dự toán & tình hình vật tư"
        action={
          <div className="flex gap-2">
            {canEdit && (
              <>
                <button
                  onClick={() => setImporting(true)}
                  className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 border border-slate-200 bg-white rounded-lg px-3 py-1.5 hover:bg-slate-50"
                >
                  <Upload size={12} /> Import Excel
                </button>
                <button
                  onClick={() => setIssueFor({ budgetId: null })}
                  className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 border border-slate-200 bg-white rounded-lg px-3 py-1.5 hover:bg-slate-50"
                >
                  <Truck size={12} /> Cấp phát
                </button>
                <PrimaryButton onClick={() => setBudgetEdit("new")}>
                  <Plus size={13} /> Thêm dòng dự toán
                </PrimaryButton>
              </>
            )}
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          <Chip active={!segFilter} onClick={() => setSegFilter(null)}>
            Tất cả lý trình
          </Chip>
          {ctx.segments.map((s) => (
            <Chip key={s.id} active={segFilter === s.id} onClick={() => setSegFilter(s.id)}>
              {s.code}
            </Chip>
          ))}
          <label className="ml-auto flex items-center gap-1.5 text-[11px] font-bold text-slate-600">
            <input type="checkbox" checked={onlyProblem} onChange={(e) => setOnlyProblem(e.target.checked)} /> Chỉ dòng có vấn đề
          </label>
        </div>

        {rows.length === 0 ? (
          <p className="text-xs italic text-slate-400 text-center py-6">
            {ctx.status.length === 0 ? "Chưa có dự toán vật tư. Thêm tay hoặc Import Excel." : "Không có dòng phù hợp bộ lọc."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]" style={{ minWidth: canPrice ? 1700 : 1250 }}>
              <thead>
                <tr className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 text-right align-bottom">
                  <th className="py-1.5 text-left">LT</th>
                  <th className="px-2 text-left">Hạng mục</th>
                  <th className="px-2 text-left">Vật tư</th>
                  <th className="px-2">Định mức</th>
                  <th className="px-2">Dự toán</th>
                  <th className="px-2">Cấp phát LK</th>
                  <th className="px-2">Cần theo SL</th>
                  <th className="px-2">Hao hụt</th>
                  <th className="px-2">Còn lại DT</th>
                  <th className="px-2">Còn cần</th>
                  <th className="px-2">Thiếu hụt</th>
                  <th className="px-2">Tồn CT</th>
                  <th className="px-2">Hết dự báo</th>
                  {canPrice && <th className="px-2">ĐG dự toán</th>}
                  {canPrice && <th className="px-2">ĐG thực tế BQ</th>}
                  {canPrice && <th className="px-2">Giá thị trường</th>}
                  {canPrice && <th className="px-2">Trượt giá</th>}
                  {canPrice && <th className="px-2">Biến phí</th>}
                  {canEdit && <th className="px-2 w-20" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const u = r.mat?.unit || "";
                  return (
                    <tr key={r.x.material_budget_id} className={`border-t border-slate-100 text-right ${r.m.problem ? "bg-amber-50/40" : ""}`}>
                      <td className="py-1.5 text-left font-bold text-slate-700">{r.seg?.code}</td>
                      <td className="px-2 text-left text-slate-600 max-w-[160px] truncate" title={r.item?.name}>
                        {r.item?.code} {r.item?.name}
                      </td>
                      <td className="px-2 text-left max-w-[180px]">
                        <span className="font-semibold text-slate-700 truncate block" title={r.mat?.name}>
                          {r.mat?.is_critical && <span className="text-rose-500 mr-0.5">★</span>}
                          {r.mat?.name}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {r.mat?.code} · {u}
                        </span>
                      </td>
                      <td className="px-2 font-mono text-slate-500">{fmtQ(Number(r.x.norm_per_unit), 4)}</td>
                      <td className="px-2 font-mono">{fmtQ(r.m.budget)}</td>
                      <td className="px-2 font-mono">
                        {fmtQ(r.m.issued)}
                        <span className="block text-[10px] text-slate-400">{pct(r.m.issuedPct)}</span>
                      </td>
                      <td className="px-2 font-mono">{fmtQ(r.m.need)}</td>
                      <td className={`px-2 font-mono ${r.m.overuse ? "text-rose-600 font-bold" : ""}`}>
                        {fmtQ(r.m.waste)}
                        <span className="block text-[10px]">{r.m.wastePct != null ? pct(r.m.wastePct) : ""}</span>
                      </td>
                      <td className="px-2 font-mono">{fmtQ(r.m.remaining)}</td>
                      <td className="px-2 font-mono">{fmtQ(r.m.stillNeeded)}</td>
                      <td className={`px-2 font-mono ${r.m.shortage > 0 ? "text-rose-600 font-bold" : "text-slate-400"}`}>{r.m.shortage > 0 ? fmtQ(r.m.shortage) : "—"}</td>
                      <td className="px-2 font-mono">{fmtQ(r.m.stock)}</td>
                      <td className={`px-2 ${r.m.runningOut ? "text-rose-600 font-bold" : "text-slate-500"}`}>
                        {r.m.runOutDate ? formatDate(r.m.runOutDate) : "—"}
                        {r.m.daysLeft != null && r.m.runOutDate && <span className="block text-[10px]">{Math.floor(r.m.daysLeft)} ngày</span>}
                      </td>
                      {canPrice && <td className="px-2 font-mono">{r.bp != null ? formatVnd(r.bp) : "—"}</td>}
                      {canPrice && <td className="px-2 font-mono">{r.avgActual != null ? formatVnd(Math.round(r.avgActual)) : "—"}</td>}
                      {canPrice && <td className="px-2 font-mono">{r.mk != null ? formatVnd(r.mk) : "—"}</td>}
                      {canPrice && (
                        <td className={`px-2 font-bold ${r.slip != null && r.slip > priceWarn ? "text-rose-600" : r.slip != null && r.slip < 0 ? "text-emerald-600" : "text-slate-500"}`}>
                          {r.slip != null ? `${r.slip > 0 ? "+" : ""}${pct(r.slip)}` : "—"}
                        </td>
                      )}
                      {canPrice && (
                        <td className={`px-2 font-mono ${r.variance && r.variance > 0 ? "text-rose-600" : "text-slate-600"}`}>{r.variance != null ? formatMoneyShort(r.variance) : "—"}</td>
                      )}
                      {canEdit && (
                        <td className="px-2 whitespace-nowrap">
                          <button onClick={() => setIssueFor({ budgetId: r.x.material_budget_id })} className="text-slate-300 hover:text-[#005BAC] mr-1.5" title="Cấp phát">
                            <Truck size={12} />
                          </button>
                          {r.budget && (
                            <>
                              <button onClick={() => setBudgetEdit(r.budget!)} className="text-slate-300 hover:text-[#005BAC] mr-1.5" title="Sửa">
                                <Pencil size={12} />
                              </button>
                              <button onClick={() => removeBudget(r.budget!)} className="text-slate-300 hover:text-rose-500" title="Xoá">
                                <Trash2 size={12} />
                              </button>
                            </>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[10px] text-slate-400 mt-2">
          Cần theo SL = KL hạng mục đã duyệt × định mức · Hao hụt dương = dùng vượt định mức · Thiếu hụt = còn cần − còn lại dự toán · Tồn CT = cấp phát − cần theo
          SL · Hết dự báo theo tiêu thụ bình quân 14 ngày. ★ = vật tư chủ lực.
        </p>
      </Card>

      {/* ─── Phiếu cấp phát ─── */}
      <Card title={`Phiếu cấp phát (${ctx.issues.length})`}>
        {ctx.issues.length === 0 ? (
          <p className="text-xs italic text-slate-400">Chưa có phiếu cấp phát.</p>
        ) : (
          <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full min-w-[760px] text-[11px]">
            <thead>
              <tr className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 text-left">
                <th className="py-1.5">Ngày</th>
                <th className="px-2">Số phiếu</th>
                <th className="px-2">LT</th>
                <th className="px-2">Vật tư</th>
                <th className="px-2 text-right">KL</th>
                <th className="px-2">Nhà thầu nhận</th>
                <th className="px-2">NCC</th>
                {canPrice && <th className="px-2 text-right">Đơn giá TT</th>}
                {canEdit && <th className="w-8" />}
              </tr>
            </thead>
            <tbody>
              {ctx.issues.slice(0, 100).map((i) => {
                const mat = matOfBudget(i.material_budget_id);
                return (
                  <tr key={i.id} className="border-t border-slate-100">
                    <td className="py-1.5 text-slate-600">{formatDate(i.issue_date)}</td>
                    <td className="px-2 text-slate-600">{i.doc_no}</td>
                    <td className="px-2 font-bold text-slate-700">{segCodeOf(i.material_budget_id)}</td>
                    <td className="px-2 text-slate-700">{mat?.name}</td>
                    <td className="px-2 text-right font-mono">
                      {fmtQ(Number(i.qty))} {mat?.unit || ""}
                    </td>
                    <td className="px-2 text-slate-500">{ctx.contracts.find((c) => c.id === i.contract_id)?.partner_name || "—"}</td>
                    <td className="px-2 text-slate-500">{i.supplier}</td>
                    {canPrice && <td className="px-2 text-right font-mono">{ctx.issuePrice.get(i.id) != null ? formatVnd(ctx.issuePrice.get(i.id)!) : "—"}</td>}
                    {canEdit && (
                      <td className="text-right">
                        <button onClick={() => removeIssue(i)} className="text-slate-300 hover:text-rose-500">
                          <Trash2 size={11} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
        {ctx.issues.length > 100 && <p className="text-[10px] text-slate-400 mt-2">Hiện 100 phiếu gần nhất (tính toán vẫn dùng đủ {ctx.issues.length} phiếu).</p>}
      </Card>

      {/* ─── Danh mục vật tư & giá thị trường ─── */}
      <Card
        title={`Danh mục vật tư & giá thị trường (${ctx.materials.length})`}
        action={
          <button onClick={() => setCatalogOpen((o) => !o)} className="text-[11px] font-bold text-[#005BAC]">
            {catalogOpen ? "Thu gọn" : "Mở danh mục"}
          </button>
        }
      >
        {catalogOpen ? (
          <CatalogPanel materials={ctx.materials} market={ctx.market} canManage={access.can_manage_material_catalog} onChanged={load} />
        ) : (
          <p className="text-[11px] text-slate-400">Danh mục dùng chung mọi dự án. Giá thị trường (công bố giá tỉnh, báo giá NCC) dùng để tính trượt giá.</p>
        )}
      </Card>

      {budgetEdit && (
        <BudgetModal
          projectId={projectId}
          ctx={ctx}
          row={budgetEdit === "new" ? null : budgetEdit}
          defaultSegment={segFilter}
          canEditPrice={access.can_edit_material_price}
          onClose={() => setBudgetEdit(null)}
          onSaved={() => {
            setBudgetEdit(null);
            load();
          }}
        />
      )}
      {issueFor && (
        <IssueModal
          projectId={projectId}
          ctx={ctx}
          budgetId={issueFor.budgetId}
          canEditPrice={access.can_edit_material_price}
          onClose={() => setIssueFor(null)}
          onSaved={() => {
            setIssueFor(null);
            load();
          }}
        />
      )}
      {importing && (
        <ImportModal
          projectId={projectId}
          ctx={ctx}
          canCatalog={access.can_manage_material_catalog}
          canPrice={access.can_edit_material_price}
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            load();
          }}
        />
      )}
      {confirmNode}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm px-4 py-3">
      <p className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400">{label}</p>
      <p className={`text-base font-extrabold font-mono mt-1 ${tone || "text-slate-800"}`}>{value}</p>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`text-[11px] font-bold px-3 py-1.5 rounded-full border ${active ? "bg-[#005BAC] text-white border-transparent" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}
    >
      {children}
    </button>
  );
}

// ─── Thêm / sửa dòng dự toán ───
function BudgetModal({
  projectId,
  ctx,
  row,
  defaultSegment,
  canEditPrice,
  onClose,
  onSaved,
}: {
  projectId: string;
  ctx: Ctx;
  row: PcMaterialBudget | null;
  defaultSegment: string | null;
  canEditPrice: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initSw = row ? ctx.wbs.find((w) => w.id === row.segment_wbs_id) : null;
  const [segId, setSegId] = useState(initSw?.segment_id || defaultSegment || "");
  const [swId, setSwId] = useState(row?.segment_wbs_id || "");
  const [matId, setMatId] = useState(row?.material_id || "");
  const [norm, setNorm] = useState(row ? String(Number(row.norm_per_unit)) : "");
  const [qty, setQty] = useState(row ? String(Number(row.budget_qty)) : "");
  const [price, setPrice] = useState(row && ctx.budgetPrice.get(row.id) != null ? formatVnd(ctx.budgetPrice.get(row.id)!) : "");
  const [note, setNote] = useState(row?.note || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const itemById = new Map(ctx.catalog.map((c) => [c.id, c]));
  const swOptions = ctx.wbs.filter((w) => w.segment_id === segId && w.applicable);
  const sw = ctx.wbs.find((w) => w.id === swId);
  const mat = ctx.materials.find((m) => m.id === matId);
  const suggested = sw?.budget_qty != null && num(norm) != null ? Number(sw.budget_qty) * (num(norm) as number) : null;

  async function save() {
    if (!swId || !matId) return setErr("Chọn lý trình, hạng mục và vật tư.");
    const n = num(norm);
    const q = num(qty);
    if (n == null || n < 0) return setErr("Định mức không hợp lệ.");
    if (q == null || q < 0) return setErr("KL dự toán không hợp lệ.");
    setSaving(true);
    setErr(null);
    const payload = { segment_wbs_id: swId, material_id: matId, norm_per_unit: n, budget_qty: q, note: note.trim() || null };
    let id = row?.id || null;
    if (row) {
      const e = await pcUpdate("pc_material_budgets", { id: row.id }, payload);
      if (e) {
        setSaving(false);
        return setErr(e);
      }
    } else {
      const { data, error } = await supabase.from("pc_material_budgets").insert({ ...payload, project_id: projectId }).select("id").single();
      if (error || !data) {
        setSaving(false);
        return setErr(/duplicate/i.test(error?.message || "") ? "Vật tư này đã có trong dự toán của hạng mục — sửa dòng sẵn có." : pcErrorMessage(error));
      }
      id = data.id;
    }
    if (canEditPrice && id) {
      const e = await pcUpsert("pc_material_budget_prices", { material_budget_id: id, budget_unit_price: parseVnd(price) }, "material_budget_id");
      if (e) {
        setSaving(false);
        return setErr(`Đã lưu dự toán nhưng chưa lưu được đơn giá: ${e}`);
      }
    }
    setSaving(false);
    onSaved();
  }

  return (
    <Modal title={row ? "Sửa dòng dự toán vật tư" : "Thêm dòng dự toán vật tư"} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Lý trình">
          <Select
            value={segId}
            onChange={(e) => {
              setSegId(e.target.value);
              setSwId("");
            }}
          >
            <option value="">— Chọn —</option>
            {ctx.segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} ({formatKm(s.km_start_m)} – {formatKm(s.km_end_m)})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Hạng mục">
          <Select value={swId} onChange={(e) => setSwId(e.target.value)} disabled={!segId}>
            <option value="">— Chọn —</option>
            {swOptions.map((w) => (
              <option key={w.id} value={w.id}>
                {itemById.get(w.wbs_item_id)?.code} {itemById.get(w.wbs_item_id)?.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Vật tư" className="col-span-2">
          <Select value={matId} onChange={(e) => setMatId(e.target.value)}>
            <option value="">{ctx.materials.length ? "— Chọn vật tư —" : "Danh mục trống — thêm ở mục Danh mục vật tư bên dưới"}</option>
            {MATERIAL_GROUPS.map((g) => {
              const list = ctx.materials.filter((m) => m.active && (m.mat_group || "Khác") === g);
              if (!list.length) return null;
              return (
                <optgroup key={g} label={g}>
                  {list.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.code} — {m.name} ({m.unit || ""})
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </Select>
        </Field>
        <Field label={`Định mức (${mat?.unit || "ĐVT vật tư"} / 1 ${sw?.unit || "ĐVT hạng mục"})`}>
          <TextInput value={norm} onChange={(e) => setNorm(e.target.value)} inputMode="decimal" />
        </Field>
        <div className="space-y-1">
          <span className="block text-[10px] font-bold text-slate-500">KL dự toán ({mat?.unit || ""})</span>
          <TextInput value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" />
          {suggested != null && (
            <button type="button" onClick={() => setQty(String(Math.round(suggested * 1000) / 1000))} className="text-[10px] font-bold text-[#005BAC]">
              Gợi ý = KL HĐ × định mức = {fmtQ(suggested, 3)}
            </button>
          )}
        </div>
        {canEditPrice && (
          <Field label="Đơn giá dự toán">
            <MoneyInput value={price} onChange={setPrice} />
          </Field>
        )}
        <Field label="Ghi chú" className={canEditPrice ? "" : "col-span-2"}>
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
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

// ─── Phiếu cấp phát ───
function IssueModal({
  projectId,
  ctx,
  budgetId,
  canEditPrice,
  onClose,
  onSaved,
}: {
  projectId: string;
  ctx: Ctx;
  budgetId: string | null;
  canEditPrice: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [bId, setBId] = useState(budgetId || "");
  const [date, setDate] = useState(todayVN());
  const [qty, setQty] = useState("");
  const [conId, setConId] = useState("");
  const [supplier, setSupplier] = useState("");
  const [docNo, setDocNo] = useState("");
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const label = (b: PcMaterialBudget) => {
    const sw = ctx.wbs.find((w) => w.id === b.segment_wbs_id);
    const seg = ctx.segments.find((s) => s.id === sw?.segment_id);
    const it = ctx.catalog.find((c) => c.id === sw?.wbs_item_id);
    const mat = ctx.materials.find((m) => m.id === b.material_id);
    return `${seg?.code} · ${it?.code} · ${mat?.name} (${mat?.unit || ""})`;
  };
  const st = ctx.status.find((s) => s.material_budget_id === bId);
  const m = st ? materialMetrics(st) : null;
  const unit = ctx.materials.find((x) => x.id === ctx.budgets.find((b) => b.id === bId)?.material_id)?.unit || "";

  async function save() {
    if (!bId) return setErr("Chọn dòng dự toán.");
    const q = num(qty);
    if (q == null || q <= 0) return setErr("KL cấp phát phải lớn hơn 0.");
    if (date > todayVN()) return setErr("Không cấp phát ngày tương lai.");
    setSaving(true);
    setErr(null);
    const { data, error } = await supabase
      .from("pc_material_issues")
      .insert({
        project_id: projectId,
        material_budget_id: bId,
        contract_id: conId || null,
        issue_date: date,
        qty: q,
        supplier: supplier.trim() || null,
        doc_no: docNo.trim() || null,
        note: note.trim() || null,
      })
      .select("id")
      .single();
    if (error || !data) {
      setSaving(false);
      return setErr(pcErrorMessage(error));
    }
    const p = parseVnd(price);
    if (canEditPrice && p != null) {
      const e = await pcUpsert("pc_material_issue_prices", { issue_id: data.id, actual_unit_price: p }, "issue_id");
      if (e) {
        setSaving(false);
        return setErr(`Đã lưu phiếu nhưng chưa lưu được đơn giá: ${e}`);
      }
    }
    setSaving(false);
    onSaved();
  }

  return (
    <Modal title="Phiếu cấp phát vật tư" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Dòng dự toán (lý trình · hạng mục · vật tư)" className="col-span-2">
          <Select value={bId} onChange={(e) => setBId(e.target.value)}>
            <option value="">— Chọn —</option>
            {ctx.budgets.map((b) => (
              <option key={b.id} value={b.id}>
                {label(b)}
              </option>
            ))}
          </Select>
          {m && (
            <span className="block text-[10px] text-slate-400">
              Đã cấp {fmtQ(m.issued)} / dự toán {fmtQ(m.budget)} {unit} · còn lại {fmtQ(m.remaining)} · tồn công trường {fmtQ(m.stock)}
            </span>
          )}
        </Field>
        <Field label="Ngày cấp phát">
          <TextInput type="date" value={date} max={todayVN()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label={`Khối lượng (${unit})`}>
          <TextInput value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Nhà thầu nhận">
          <Select value={conId} onChange={(e) => setConId(e.target.value)}>
            <option value="">— Lodeza EOP tự thi công —</option>
            {ctx.contracts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.partner_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Số phiếu xuất">
          <TextInput value={docNo} onChange={(e) => setDocNo(e.target.value)} />
        </Field>
        <Field label="Nhà cung cấp">
          <TextInput value={supplier} onChange={(e) => setSupplier(e.target.value)} />
        </Field>
        {canEditPrice && (
          <Field label="Đơn giá thực tế">
            <MoneyInput value={price} onChange={setPrice} />
          </Field>
        )}
        <Field label="Ghi chú" className="col-span-2">
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      {m && num(qty) != null && (num(qty) as number) > m.remaining && m.remaining >= 0 && (
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-600">
          <AlertTriangle size={12} /> Cấp phát này vượt phần còn lại của dự toán.
        </p>
      )}
      <ErrorLine msg={err} />
      <div className="flex justify-end">
        <PrimaryButton onClick={save} busy={saving}>
          Lưu phiếu
        </PrimaryButton>
      </div>
    </Modal>
  );
}

// ─── Danh mục vật tư + giá thị trường ───
function CatalogPanel({
  materials,
  market,
  canManage,
  onChanged,
}: {
  materials: PcMaterial[];
  market: Map<string, PcMaterialPrice>;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [edit, setEdit] = useState<PcMaterial | "new" | null>(null);
  const [priceFor, setPriceFor] = useState<PcMaterial | null>(null);
  return (
    <div className="space-y-3">
      {canManage && (
        <div className="flex justify-end">
          <PrimaryButton onClick={() => setEdit("new")}>
            <PackagePlus size={13} /> Thêm vật tư
          </PrimaryButton>
        </div>
      )}
      {materials.length === 0 ? (
        <p className="text-xs italic text-slate-400">Danh mục trống.</p>
      ) : (
        <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full min-w-[640px] text-[11px]">
          <thead>
            <tr className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 text-left">
              <th className="py-1.5">Mã</th>
              <th className="px-2">Tên</th>
              <th className="px-2">Nhóm</th>
              <th className="px-2">ĐVT</th>
              <th className="px-2 text-right">Giá thị trường</th>
              <th className="px-2">Ngày giá · nguồn</th>
              {canManage && <th className="w-16" />}
            </tr>
          </thead>
          <tbody>
            {materials.map((m) => {
              const p = market.get(m.id);
              return (
                <tr key={m.id} className={`border-t border-slate-100 ${m.active ? "" : "opacity-50"}`}>
                  <td className="py-1.5 font-mono font-bold text-slate-700">{m.code}</td>
                  <td className="px-2 text-slate-700">
                    {m.is_critical && <span className="text-rose-500 mr-0.5">★</span>}
                    {m.name}
                  </td>
                  <td className="px-2 text-slate-500">{m.mat_group}</td>
                  <td className="px-2 text-slate-500">{m.unit}</td>
                  <td className="px-2 text-right font-mono">{p ? formatVnd(p.price) : "—"}</td>
                  <td className="px-2 text-slate-400">{p ? `${formatDate(p.effective_date)}${p.source ? ` · ${p.source}` : ""}` : ""}</td>
                  {canManage && (
                    <td className="text-right whitespace-nowrap">
                      <button onClick={() => setPriceFor(m)} className="text-slate-300 hover:text-[#005BAC] mr-1.5" title="Cập nhật giá thị trường">
                        <Tag size={12} />
                      </button>
                      <button onClick={() => setEdit(m)} className="text-slate-300 hover:text-[#005BAC]" title="Sửa">
                        <Pencil size={12} />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
      {edit && (
        <MaterialModal
          row={edit === "new" ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            onChanged();
          }}
        />
      )}
      {priceFor && (
        <MarketPriceModal
          material={priceFor}
          onClose={() => setPriceFor(null)}
          onSaved={() => {
            setPriceFor(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function MaterialModal({ row, onClose, onSaved }: { row: PcMaterial | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState(() => ({
    code: row?.code || "",
    name: row?.name || "",
    unit: row?.unit || "",
    mat_group: row?.mat_group || "Khác",
    is_critical: row?.is_critical ?? false,
    active: row?.active ?? true,
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!f.code.trim() || !f.name.trim()) return setErr("Nhập mã và tên vật tư.");
    setSaving(true);
    const payload = { ...f, code: f.code.trim().toUpperCase(), name: f.name.trim(), unit: f.unit.trim() || null };
    let e: string | null = null;
    if (row) e = await pcUpdate("pc_materials", { id: row.id }, payload);
    else {
      const { error } = await supabase.from("pc_materials").insert(payload);
      if (error) e = /duplicate/i.test(error.message) ? "Mã vật tư đã tồn tại." : pcErrorMessage(error);
    }
    setSaving(false);
    if (e) return setErr(e);
    onSaved();
  }

  return (
    <Modal title={row ? "Sửa vật tư" : "Thêm vật tư vào danh mục"} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Mã vật tư">
          <TextInput value={f.code} onChange={(e) => setF((x) => ({ ...x, code: e.target.value }))} placeholder="THEP-CB400" />
        </Field>
        <Field label="Đơn vị tính">
          <TextInput value={f.unit} onChange={(e) => setF((x) => ({ ...x, unit: e.target.value }))} placeholder="tấn, m³, bao…" />
        </Field>
        <Field label="Tên vật tư" className="col-span-2">
          <TextInput value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} />
        </Field>
        <Field label="Nhóm">
          <Select value={f.mat_group} onChange={(e) => setF((x) => ({ ...x, mat_group: e.target.value }))}>
            {MATERIAL_GROUPS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-col justify-end gap-1.5 text-[11px] font-semibold text-slate-600">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.is_critical} onChange={(e) => setF((x) => ({ ...x, is_critical: e.target.checked }))} /> Vật tư chủ lực
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.active} onChange={(e) => setF((x) => ({ ...x, active: e.target.checked }))} /> Đang dùng
          </label>
        </div>
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

function MarketPriceModal({ material, onClose, onSaved }: { material: PcMaterial; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(todayVN());
  const [price, setPrice] = useState("");
  const [source, setSource] = useState("");
  const [province, setProvince] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    const p = parseVnd(price);
    if (p == null) return setErr("Nhập giá.");
    setSaving(true);
    const { error } = await supabase
      .from("pc_material_prices")
      .insert({ material_id: material.id, effective_date: date, price: p, source: source.trim() || null, province: province.trim() || null });
    setSaving(false);
    if (error) return setErr(pcErrorMessage(error));
    onSaved();
  }

  return (
    <Modal title={`Giá thị trường — ${material.name} (${material.unit || ""})`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Ngày áp dụng">
          <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Giá">
          <MoneyInput value={price} onChange={setPrice} />
        </Field>
        <Field label="Nguồn">
          <TextInput value={source} onChange={(e) => setSource(e.target.value)} placeholder="Công bố giá tỉnh / báo giá NCC" />
        </Field>
        <Field label="Tỉnh / khu vực">
          <TextInput value={province} onChange={(e) => setProvince(e.target.value)} />
        </Field>
      </div>
      <ErrorLine msg={err} />
      <div className="flex justify-end">
        <PrimaryButton onClick={save} busy={saving}>
          Lưu giá
        </PrimaryButton>
      </div>
    </Modal>
  );
}

// ─── Import dự toán từ Excel (xem trước rồi mới ghi) ───
const TEMPLATE_HEAD = ["Lý trình", "Mã hạng mục", "Mã vật tư", "Tên vật tư", "ĐVT", "Nhóm", "Định mức", "KL dự toán", "Đơn giá dự toán"];

type ImportRow = {
  line: number;
  segCode: string;
  itemCode: string;
  matCode: string;
  matName: string;
  unit: string;
  group: string;
  norm: number | null;
  qty: number | null;
  price: number | null;
  swId: string | null;
  matId: string | null;
  problem: string | null;
};

function ImportModal({
  projectId,
  ctx,
  canCatalog,
  canPrice,
  onClose,
  onDone,
}: {
  projectId: string;
  ctx: Ctx;
  canCatalog: boolean;
  canPrice: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  function downloadTemplate() {
    const sample = ctx.segments[0]?.code || "LT01";
    const ws = XLSX.utils.aoa_to_sheet([
      TEMPLATE_HEAD,
      [sample, "T-2", "XM-PCB40", "Xi măng PCB40", "tấn", "Xi măng", 0.35, 120, 1650000],
      [sample, "T-3", "DA-1x2", "Đá 1x2", "m³", "Đá", 0.87, 900, 380000],
    ]);
    ws["!cols"] = TEMPLATE_HEAD.map((h) => ({ wch: Math.max(12, h.length + 4) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "DuToanVatTu");
    XLSX.writeFile(wb, "Mau_du_toan_vat_tu.xlsx");
  }

  async function readFile(file: File) {
    setErr(null);
    setResult(null);
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, { header: 1, defval: null });
      const head = (aoa[0] || []).map((h) => String(h || "").trim().toLowerCase());
      const col = (name: string) => head.indexOf(name.toLowerCase());
      const idx = TEMPLATE_HEAD.map(col);
      if (idx.slice(0, 3).some((i) => i < 0)) return setErr(`Thiếu cột bắt buộc. Dòng tiêu đề phải có: ${TEMPLATE_HEAD.join(" | ")}`);
      const segByCode = new Map(ctx.segments.map((s) => [s.code.trim().toUpperCase(), s]));
      const itemByCode = new Map(ctx.catalog.map((c) => [c.code.trim().toUpperCase(), c]));
      const matByCode = new Map(ctx.materials.map((m) => [m.code.trim().toUpperCase(), m]));
      const cell = (r: (string | number | null)[], i: number) => (i >= 0 && r[i] != null ? String(r[i]).trim() : "");
      const out: ImportRow[] = [];
      aoa.slice(1).forEach((r, k) => {
        if (!r || r.every((v) => v == null || String(v).trim() === "")) return;
        const segCode = cell(r, idx[0]).toUpperCase();
        const itemCode = cell(r, idx[1]).toUpperCase();
        const matCode = cell(r, idx[2]).toUpperCase();
        const seg = segByCode.get(segCode);
        const item = itemByCode.get(itemCode);
        const sw = seg && item ? ctx.wbs.find((w) => w.segment_id === seg.id && w.wbs_item_id === item.id) : undefined;
        const mat = matByCode.get(matCode);
        let problem: string | null = null;
        if (!seg) problem = `Không có lý trình "${segCode}"`;
        else if (!item) problem = `Không có mã hạng mục "${itemCode}"`;
        else if (!sw) problem = `${segCode} chưa gán hạng mục ${itemCode}`;
        else if (!matCode) problem = "Thiếu mã vật tư";
        else if (!mat && !canCatalog) problem = `Vật tư "${matCode}" chưa có trong danh mục (không có quyền thêm)`;
        else if (!mat && !cell(r, idx[3])) problem = `Vật tư mới "${matCode}" thiếu tên`;
        out.push({
          line: k + 2,
          segCode,
          itemCode,
          matCode,
          matName: cell(r, idx[3]) || mat?.name || "",
          unit: cell(r, idx[4]) || mat?.unit || "",
          group: cell(r, idx[5]) || mat?.mat_group || "Khác",
          norm: num(cell(r, idx[6])),
          qty: num(cell(r, idx[7])),
          price: parseVnd(cell(r, idx[8])),
          swId: sw?.id || null,
          matId: mat?.id || null,
          problem,
        });
      });
      setRows(out);
    } catch (e) {
      setErr(e instanceof Error ? `Không đọc được file: ${e.message}` : "Không đọc được file.");
    }
  }

  async function commit() {
    if (!rows) return;
    const ok = rows.filter((r) => !r.problem);
    if (!ok.length) return setErr("Không có dòng hợp lệ để nhập.");
    setSaving(true);
    setErr(null);
    // 1. Vật tư mới vào danh mục (trùng mã trong file chỉ tạo 1 lần).
    const newMats = new Map<string, ImportRow>();
    ok.filter((r) => !r.matId).forEach((r) => newMats.set(r.matCode, r));
    const createdIds = new Map<string, string>();
    for (const [code, r] of newMats) {
      const { data, error } = await supabase
        .from("pc_materials")
        .insert({ code, name: r.matName, unit: r.unit || null, mat_group: MATERIAL_GROUPS.includes(r.group) ? r.group : "Khác" })
        .select("id")
        .single();
      if (error || !data) {
        setSaving(false);
        return setErr(`Dòng ${r.line}: không thêm được vật tư ${code} — ${pcErrorMessage(error)}`);
      }
      createdIds.set(code, data.id);
    }
    // 2. Dự toán (ghi đè dòng trùng lý trình-hạng mục-vật tư).
    let n = 0;
    for (const r of ok) {
      const matId = r.matId || createdIds.get(r.matCode)!;
      const { data, error } = await supabase
        .from("pc_material_budgets")
        .upsert(
          { project_id: projectId, segment_wbs_id: r.swId, material_id: matId, norm_per_unit: r.norm ?? 0, budget_qty: r.qty ?? 0 },
          { onConflict: "segment_wbs_id,material_id" }
        )
        .select("id")
        .single();
      if (error || !data) {
        setSaving(false);
        return setErr(`Dòng ${r.line}: ${pcErrorMessage(error)} (đã nhập ${n} dòng trước đó)`);
      }
      if (canPrice && r.price != null) {
        const e = await pcUpsert("pc_material_budget_prices", { material_budget_id: data.id, budget_unit_price: r.price }, "material_budget_id");
        if (e) {
          setSaving(false);
          return setErr(`Dòng ${r.line}: lưu đơn giá lỗi — ${e}`);
        }
      }
      n++;
    }
    setSaving(false);
    setResult(`Đã nhập ${n} dòng dự toán${createdIds.size ? `, thêm ${createdIds.size} vật tư mới vào danh mục` : ""}.`);
    setRows(null);
  }

  const bad = rows?.filter((r) => r.problem).length || 0;

  return (
    <Modal title="Import dự toán vật tư từ Excel" onClose={result ? onDone : onClose} wide>
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={downloadTemplate} className="flex items-center gap-1.5 text-[11px] font-bold text-[#005BAC] border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50">
          <Download size={12} /> Tải file mẫu
        </button>
        <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 border border-dashed border-slate-300 rounded-lg px-3 py-1.5 cursor-pointer hover:bg-slate-50">
          <Upload size={12} /> Chọn file .xlsx
          <input
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) readFile(f);
              e.target.value = "";
            }}
          />
        </label>
        <span className="text-[10px] text-slate-400">Cột: {TEMPLATE_HEAD.join(" | ")}. Dòng trùng lý trình-hạng mục-vật tư sẽ được ghi đè.</span>
      </div>

      {rows && (
        <>
          <p className="text-[11px] font-semibold text-slate-600">
            {rows.length} dòng · <span className="text-emerald-600">{rows.length - bad} hợp lệ</span>
            {bad > 0 && <span className="text-rose-600"> · {bad} lỗi (sẽ bỏ qua)</span>}
          </p>
          <div className="max-h-80 overflow-auto border border-slate-100 rounded-lg">
            <div className="overflow-x-auto -mx-1 px-1">
            <table className="w-full min-w-[720px] text-[11px]">
              <thead className="sticky top-0 bg-white">
                <tr className="text-[10px] font-extrabold uppercase text-slate-400 text-left">
                  <th className="px-2 py-1.5">Dòng</th>
                  <th className="px-2">LT</th>
                  <th className="px-2">HM</th>
                  <th className="px-2">Vật tư</th>
                  <th className="px-2 text-right">Định mức</th>
                  <th className="px-2 text-right">KL DT</th>
                  {canPrice && <th className="px-2 text-right">Đơn giá</th>}
                  <th className="px-2">Kiểm tra</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.line} className={`border-t border-slate-100 ${r.problem ? "bg-rose-50/60" : ""}`}>
                    <td className="px-2 py-1 text-slate-400">{r.line}</td>
                    <td className="px-2 font-bold">{r.segCode}</td>
                    <td className="px-2">{r.itemCode}</td>
                    <td className="px-2">
                      {r.matCode} — {r.matName} {!r.matId && !r.problem && <span className="text-[10px] font-bold text-[#005BAC]">(mới)</span>}
                    </td>
                    <td className="px-2 text-right font-mono">{fmtQ(r.norm, 4)}</td>
                    <td className="px-2 text-right font-mono">{fmtQ(r.qty)}</td>
                    {canPrice && <td className="px-2 text-right font-mono">{r.price != null ? formatVnd(r.price) : "—"}</td>}
                    <td className={`px-2 ${r.problem ? "text-rose-600 font-semibold" : "text-emerald-600"}`}>{r.problem || "OK"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
          <div className="flex justify-end">
            <PrimaryButton onClick={commit} busy={saving} disabled={rows.length === bad}>
              Nhập {rows.length - bad} dòng hợp lệ
            </PrimaryButton>
          </div>
        </>
      )}
      {result && <p className="text-xs font-bold text-emerald-600">{result}</p>}
      <ErrorLine msg={err} />
    </Modal>
  );
}
