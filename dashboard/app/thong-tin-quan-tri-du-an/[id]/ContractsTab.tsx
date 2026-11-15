"use client";

// Tab Nhà thầu & Hợp đồng (M3):
// • HĐ A-B (CĐT ↔ Lodeza EOP) và B-B' (Lodeza EOP ↔ nhà thầu), chính danh / không chính danh,
//   chính / phụ, phạm vi theo lý trình × hạng mục, phụ lục phát sinh.
// • Nhà thầu lấy từ danh mục đối tác CHUNG của Kế hoạch thu chi (finance_partners)
//   qua RPC pc_partner_list / pc_partner_create — số tài khoản vẫn quản lý ở đó.
// • Ô chọn nhà thầu: ô tìm + danh sách thả xuống (cùng kiểu ô chọn nhân sự ở tab Thành viên).
// • Kỹ sư (không quyền tài chính) vẫn thấy ai làm lý trình nào, không thấy số tiền.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useConfirmBox } from "@/components/ConfirmDialog";
import {
  CONTRACT_STATUS,
  formatDate,
  formatVnd,
  formatMoneyShort,
  parseVnd,
  pctToRate,
  rateToPct,
  pcErrorMessage,
  pcUpdate,
  pcDelete,
  pcUpsert,
  type PcAccess,
  type PcAddendum,
  type PcContract,
  type PcContractFinance,
  type PcScope,
  type PcSegment,
  type PcWbsItem,
} from "@/lib/projectControl";
import { Card, Field, TextInput, Select, MoneyInput, PrimaryButton, GhostButton, ErrorLine, Modal } from "./ui";
import { Plus, Pencil, Trash2, AlertTriangle, Loader2, FileSignature, Layers, Search, X, Building2, Tag } from "lucide-react";

type Partner = { id: string; name: string; short_name: string | null; party_type: string; tax_code: string | null };

const PARTY_LABEL: Record<string, string> = {
  nha_thau_phu: "Nhà thầu",
  nha_cung_cap: "Nhà cung cấp",
  chu_dau_tu: "Chủ đầu tư",
  ca_nhan: "Cá nhân",
};

// Bỏ dấu để gõ "cong minh" vẫn ra "Công Minh".
function fold(s: string): string {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");
}

export default function ContractsTab({ projectId, access }: { projectId: string; access: PcAccess }) {
  // Thông tin HĐ + phạm vi: quyền Chỉnh sửa (migration 113). Tiền (giá trị, phụ lục,
  // đơn giá) và XOÁ HĐ/phạm vi (kéo theo xoá tiền) chỉ người có quyền tài chính.
  const canEdit = access.can_edit_structure || access.can_edit_finance;
  const canEditFin = access.can_edit_finance;
  const canFin = access.can_view_finance;
  const { ask, confirmNode } = useConfirmBox();
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [contracts, setContracts] = useState<PcContract[]>([]);
  const [fin, setFin] = useState<Record<string, PcContractFinance>>({});
  const [scopes, setScopes] = useState<PcScope[]>([]);
  const [scopeVal, setScopeVal] = useState<Record<string, number | null>>({});
  const [addenda, setAddenda] = useState<PcAddendum[]>([]);
  const [segments, setSegments] = useState<PcSegment[]>([]);
  const [catalog, setCatalog] = useState<PcWbsItem[]>([]);
  const [editing, setEditing] = useState<PcContract | "new-ab" | "new-bb" | null>(null);
  const [scopeFor, setScopeFor] = useState<PcContract | null>(null);
  const [addendumFor, setAddendumFor] = useState<PcContract | null>(null);
  const [priceFor, setPriceFor] = useState<PcContract | null>(null);

  const load = useCallback(async () => {
    const [cRes, sRes, wRes] = await Promise.all([
      supabase.from("pc_contracts").select("*").eq("project_id", projectId).order("created_at"),
      supabase.from("pc_segments").select("*").eq("project_id", projectId).order("km_start_m"),
      supabase.from("pc_wbs_items").select("*").order("sort_order"),
    ]);
    if (cRes.error) setErr(pcErrorMessage(cRes.error));
    const cons = (cRes.data as PcContract[]) || [];
    setContracts(cons);
    setSegments((sRes.data as PcSegment[]) || []);
    setCatalog((wRes.data as PcWbsItem[]) || []);
    const ids = cons.map((c) => c.id);
    if (ids.length) {
      const { data: sc } = await supabase.from("pc_contract_scopes").select("*").in("contract_id", ids);
      const scs = (sc as PcScope[]) || [];
      setScopes(scs);
      if (canFin) {
        const [fRes, aRes, svRes] = await Promise.all([
          supabase.from("pc_contract_finance").select("*").in("contract_id", ids),
          supabase.from("pc_contract_addenda").select("*").in("contract_id", ids).order("sign_date"),
          scs.length
            ? supabase.from("pc_contract_scope_finance").select("*").in("scope_id", scs.map((s) => s.id))
            : Promise.resolve({ data: [] as { scope_id: string; value: number | null }[] }),
        ]);
        const fm: Record<string, PcContractFinance> = {};
        ((fRes.data as PcContractFinance[]) || []).forEach((f) => (fm[f.contract_id] = f));
        setFin(fm);
        setAddenda((aRes.data as PcAddendum[]) || []);
        const sv: Record<string, number | null> = {};
        ((svRes.data as { scope_id: string; value: number | null }[]) || []).forEach((v) => (sv[v.scope_id] = v.value));
        setScopeVal(sv);
      }
    } else {
      setScopes([]);
    }
    setLoading(false);
  }, [projectId, canFin]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const segById = useMemo(() => new Map(segments.map((s) => [s.id, s])), [segments]);
  const itemById = useMemo(() => new Map(catalog.map((c) => [c.id, c])), [catalog]);

  // Giá trị hiện hành = GT HĐ trước thuế + Σ phụ lục.
  const currentValue = (c: PcContract): number | null => {
    const base = fin[c.id]?.value_pre_vat;
    if (base == null) return null;
    return Number(base) + addenda.filter((a) => a.contract_id === c.id).reduce((s, a) => s + Number(a.value_change || 0), 0);
  };

  const ab = contracts.filter((c) => c.contract_type === "A_B");
  const bb = contracts.filter((c) => c.contract_type === "B_B1");

  // Lý trình chưa có nhà thầu B-B' nào -> cảnh báo vàng (đặc tả 7.3).
  const segNoContractor = segments.filter(
    (s) => !scopes.some((sc) => sc.segment_id === s.id && bb.some((c) => c.id === sc.contract_id))
  );

  // Tổng B-B' vượt A-B -> cảnh báo lỗ.
  const abTotal = ab.reduce((s, c) => s + (currentValue(c) || 0), 0);
  const bbTotal = bb.reduce((s, c) => s + (currentValue(c) || 0), 0);

  function removeContract(c: PcContract) {
    ask({
      title: `Xoá hợp đồng ${c.contract_no || c.partner_name || ""}?`,
      message: "Phạm vi, giá trị và phụ lục của hợp đồng này cũng bị xoá.",
      onConfirm: async () => {
        const e = await pcDelete("pc_contracts", { id: c.id });
        if (e) setErr(e);
        load();
      },
    });
  }

  async function removeScope(s: PcScope) {
    const e = await pcDelete("pc_contract_scopes", { id: s.id });
    if (e) setErr(e);
    load();
  }

  async function removeAddendum(a: PcAddendum) {
    const e = await pcDelete("pc_contract_addenda", { id: a.id });
    if (e) setErr(e);
    load();
  }

  if (loading)
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="animate-spin text-[#005BAC]" size={26} />
      </div>
    );

  const renderContract = (c: PcContract) => {
    const f = fin[c.id];
    const cur = currentValue(c);
    const st = CONTRACT_STATUS[c.status];
    const myScopes = scopes.filter((s) => s.contract_id === c.id);
    const myAdd = addenda.filter((a) => a.contract_id === c.id);
    const parent = c.parent_contract_id ? contracts.find((x) => x.id === c.parent_contract_id) : null;
    return (
      <div key={c.id} className="border border-slate-100 rounded-xl p-3.5 space-y-2.5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-extrabold text-slate-800">{c.partner_name || "(chưa chọn đơn vị)"}</span>
              {st && <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>}
              {c.contract_type === "B_B1" && c.contractor_role && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-50 text-[#005BAC]">
                  {c.contractor_role === "MAIN" ? "Nhà thầu chính" : "Nhà thầu phụ"}
                </span>
              )}
              {c.legal_status && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
                  {c.legal_status === "NOMINAL" ? "Chính danh" : "Không chính danh"}
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {c.contract_no ? `Số HĐ ${c.contract_no}` : "Chưa có số HĐ"}
              {c.sign_date ? ` · ký ${formatDate(c.sign_date)}` : ""}
              {parent ? ` · theo HĐ A-B ${parent.contract_no || parent.partner_name || ""}` : ""}
            </p>
            {c.note && <p className="text-[11px] text-slate-400 italic mt-0.5">{c.note}</p>}
          </div>
          {(canFin || canEdit) && (
            <div className="flex items-start justify-between gap-2 sm:justify-end shrink-0">
              {canFin && (
                <div className="text-left sm:text-right">
                  <p className="text-sm font-extrabold font-mono text-slate-800">{cur != null ? formatMoneyShort(cur) : "—"}</p>
                  <p className="text-[10px] text-slate-400">
                    trước VAT{myAdd.length ? ` · gồm ${myAdd.length} phụ lục` : ""}
                    {f?.advance_rate != null ? ` · TƯ ${rateToPct(f.advance_rate)}%` : ""}
                    {f?.retention_rate != null ? ` · giữ lại ${rateToPct(f.retention_rate)}%` : ""}
                  </p>
                </div>
              )}
              {canEdit && (
                <div className="flex shrink-0">
                  <GhostButton onClick={() => setEditing(c)}>
                    <Pencil size={12} />
                  </GhostButton>
                  {canEditFin && (
                    <GhostButton danger onClick={() => removeContract(c)}>
                      <Trash2 size={12} />
                    </GhostButton>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="bg-slate-50/60 rounded-lg px-3 py-2 space-y-1">
          <div className="flex items-center gap-2">
            <Layers size={12} className="text-slate-400" />
            <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 flex-1">Phạm vi</span>
            {canFin && c.contract_type === "B_B1" && myScopes.length > 0 && (
              <button onClick={() => setPriceFor(c)} className="text-[10px] font-bold text-[#005BAC] hover:text-blue-700 flex items-center gap-0.5 mr-2">
                <Tag size={11} /> Đơn giá hạng mục
              </button>
            )}
            {canEdit && (
              <button onClick={() => setScopeFor(c)} className="text-[10px] font-bold text-[#005BAC] hover:text-blue-700 flex items-center gap-0.5">
                <Plus size={11} /> Thêm phạm vi
              </button>
            )}
          </div>
          {myScopes.length === 0 ? (
            <p className="text-[11px] italic text-slate-400">Chưa gán lý trình.</p>
          ) : (
            myScopes.map((s) => {
              const seg = segById.get(s.segment_id);
              const it = s.wbs_item_id ? itemById.get(s.wbs_item_id) : null;
              return (
                <div key={s.id} className="flex items-center gap-2 text-[11px]">
                  <span className="font-bold text-slate-700 w-12 shrink-0">{seg?.code || "?"}</span>
                  <span className="text-slate-500 flex-1 min-w-0 truncate">
                    {it ? `${it.code} ${it.name}` : "Cả lý trình"}
                    {s.scope_desc ? ` — ${s.scope_desc}` : ""}
                  </span>
                  {canFin && <span className="font-mono text-slate-600">{scopeVal[s.id] != null ? formatMoneyShort(scopeVal[s.id]) : ""}</span>}
                  {canEditFin && (
                    <button onClick={() => removeScope(s)} className="text-slate-300 hover:text-rose-500">
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>

        {canFin && (myAdd.length > 0 || canEditFin) && (
          <div className="bg-slate-50/60 rounded-lg px-3 py-2 space-y-1">
            <div className="flex items-center gap-2">
              <FileSignature size={12} className="text-slate-400" />
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 flex-1">Phụ lục / phát sinh</span>
              {canEditFin && (
                <button onClick={() => setAddendumFor(c)} className="text-[10px] font-bold text-[#005BAC] hover:text-blue-700 flex items-center gap-0.5">
                  <Plus size={11} /> Thêm phụ lục
                </button>
              )}
            </div>
            {myAdd.map((a) => (
              <div key={a.id} className="flex items-center gap-2 text-[11px]">
                <span className="font-bold text-slate-700 w-20 shrink-0 truncate">{a.addendum_no || "PL"}</span>
                <span className="text-slate-400 w-20 shrink-0">{formatDate(a.sign_date)}</span>
                <span className="text-slate-500 flex-1 min-w-0 truncate">{a.reason}</span>
                <span className={`font-mono font-semibold ${Number(a.value_change) < 0 ? "text-rose-600" : "text-emerald-600"}`}>
                  {Number(a.value_change) > 0 ? "+" : ""}
                  {formatMoneyShort(a.value_change)}
                </span>
                {canEditFin && (
                  <button onClick={() => removeAddendum(a)} className="text-slate-300 hover:text-rose-500">
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <ErrorLine msg={err} />

      {(segNoContractor.length > 0 || (canFin && abTotal > 0 && bbTotal > abTotal)) && (
        <div className="space-y-2">
          {segNoContractor.length > 0 && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-700 text-[11px] font-semibold px-3 py-2 rounded-lg">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              Chưa có thông tin nhà thầu (HĐ B-B&apos;) cho lý trình: {segNoContractor.map((s) => s.code).join(", ")}
            </div>
          )}
          {canFin && abTotal > 0 && bbTotal > abTotal && (
            <div className="flex items-start gap-2 bg-rose-50 border border-rose-200 text-rose-600 text-[11px] font-semibold px-3 py-2 rounded-lg">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              Tổng giá trị HĐ B-B&apos; ({formatMoneyShort(bbTotal)}) vượt HĐ A-B ({formatMoneyShort(abTotal)}) — nguy cơ lỗ.
            </div>
          )}
        </div>
      )}

      <Card
        title={`Hợp đồng A-B — Chủ đầu tư ↔ Lodeza EOP (${ab.length})`}
        action={
          canEdit ? (
            <PrimaryButton onClick={() => setEditing("new-ab")}>
              <Plus size={13} /> Thêm HĐ A-B
            </PrimaryButton>
          ) : null
        }
      >
        <div className="space-y-2">
          {ab.length === 0 ? <p className="text-xs italic text-slate-400 text-center py-4">Chưa có HĐ A-B.</p> : ab.map(renderContract)}
        </div>
      </Card>

      <Card
        title={`Hợp đồng B-B' — Lodeza EOP ↔ nhà thầu (${bb.length})${canFin && bbTotal ? ` · tổng ${formatMoneyShort(bbTotal)}` : ""}`}
        action={
          canEdit ? (
            <PrimaryButton onClick={() => setEditing("new-bb")}>
              <Plus size={13} /> Thêm HĐ B-B&apos;
            </PrimaryButton>
          ) : null
        }
      >
        <div className="space-y-2">
          {bb.length === 0 ? <p className="text-xs italic text-slate-400 text-center py-4">Chưa có HĐ B-B&apos;.</p> : bb.map(renderContract)}
        </div>
      </Card>

      {editing && (
        <ContractModal
          projectId={projectId}
          contract={typeof editing === "string" ? null : editing}
          type={typeof editing === "string" ? (editing === "new-ab" ? "A_B" : "B_B1") : editing.contract_type}
          abContracts={ab}
          finance={typeof editing === "string" ? null : fin[editing.id] || null}
          canFin={canFin}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {scopeFor && (
        <ScopeModal
          contract={scopeFor}
          segments={segments}
          catalog={catalog}
          canFin={canFin}
          onClose={() => setScopeFor(null)}
          onSaved={() => {
            setScopeFor(null);
            load();
          }}
        />
      )}
      {priceFor && (
        <BbPriceModal
          contract={priceFor}
          scopes={scopes.filter((x) => x.contract_id === priceFor.id)}
          segments={segments}
          catalog={catalog}
          canEdit={canEditFin}
          onClose={() => setPriceFor(null)}
        />
      )}
      {addendumFor && (
        <AddendumModal
          contract={addendumFor}
          onClose={() => setAddendumFor(null)}
          onSaved={() => {
            setAddendumFor(null);
            load();
          }}
        />
      )}
      {confirmNode}
    </div>
  );
}

function ContractModal({
  projectId,
  contract,
  type,
  abContracts,
  finance,
  canFin,
  onClose,
  onSaved,
}: {
  projectId: string;
  contract: PcContract | null;
  type: "A_B" | "B_B1";
  abContracts: PcContract[];
  finance: PcContractFinance | null;
  canFin: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [partnerErr, setPartnerErr] = useState<string | null>(null);
  const [f, setF] = useState(() => ({
    partnerName: contract?.partner_name || "",
    parent: contract?.parent_contract_id || (type === "B_B1" && abContracts.length === 1 ? abContracts[0].id : ""),
    legal: contract?.legal_status || "",
    role: contract?.contractor_role || (type === "B_B1" ? "MAIN" : ""),
    no: contract?.contract_no || "",
    date: contract?.sign_date || "",
    status: contract?.status || "NEGOTIATING",
    note: contract?.note || "",
    value: finance?.value_pre_vat != null ? formatVnd(finance.value_pre_vat) : "",
    vat: rateToPct(finance?.vat_rate ?? 0.08),
    advance: rateToPct(finance?.advance_rate),
    retention: rateToPct(finance?.retention_rate),
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc("pc_partner_list");
      if (error) setPartnerErr(pcErrorMessage(error));
      setPartners((data as Partner[]) || []);
    })();
  }, []);

  async function save() {
    const name = f.partnerName.trim();
    if (!name) return setErr(type === "A_B" ? "Nhập tên Chủ đầu tư." : "Nhập tên nhà thầu.");
    setSaving(true);
    setErr(null);

    // Khớp tên với danh mục chung; chưa có thì thêm mới vào danh mục đó.
    let partnerId = partners.find((p) => p.name.toLowerCase() === name.toLowerCase())?.id || null;
    if (!partnerId) {
      const { data, error } = await supabase.rpc("pc_partner_create", {
        p_name: name,
        p_short_name: null,
        p_party_type: type === "A_B" ? "chu_dau_tu" : "nha_thau_phu",
        p_tax_code: null,
      });
      if (error) {
        setSaving(false);
        return setErr(pcErrorMessage(error));
      }
      partnerId = data as string;
    }

    const row = {
      contract_type: type,
      parent_contract_id: type === "B_B1" ? f.parent || null : null,
      partner_id: partnerId,
      partner_name: name,
      legal_status: f.legal || null,
      contractor_role: type === "B_B1" ? f.role || null : null,
      contract_no: f.no.trim() || null,
      sign_date: f.date || null,
      status: f.status,
      note: f.note.trim() || null,
    };

    let id = contract?.id || null;
    if (contract) {
      const e = await pcUpdate("pc_contracts", { id: contract.id }, row);
      if (e) {
        setSaving(false);
        return setErr(e);
      }
    } else {
      const { data, error } = await supabase
        .from("pc_contracts")
        .insert({ ...row, project_id: projectId })
        .select("id")
        .single();
      if (error || !data) {
        setSaving(false);
        return setErr(pcErrorMessage(error));
      }
      id = data.id;
    }

    if (canFin && id) {
      const vat = pctToRate(f.vat);
      const e = await pcUpsert(
        "pc_contract_finance",
        {
          contract_id: id,
          value_pre_vat: parseVnd(f.value),
          vat_rate: vat ?? 0.08,
          advance_rate: pctToRate(f.advance),
          retention_rate: pctToRate(f.retention),
        },
        "contract_id"
      );
      if (e) {
        setSaving(false);
        return setErr(`Đã lưu hợp đồng nhưng chưa lưu được giá trị: ${e}`);
      }
    }
    setSaving(false);
    onSaved();
  }

  const title = `${contract ? "Sửa" : "Thêm"} hợp đồng ${type === "A_B" ? "A-B" : "B-B'"}`;

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="md:col-span-2 space-y-1">
          <span className="block text-[10px] font-bold text-slate-500">{type === "A_B" ? "Chủ đầu tư" : "Nhà thầu"}</span>
          <PartnerPicker
            partners={partners}
            value={f.partnerName}
            preferType={type === "A_B" ? "chu_dau_tu" : "nha_thau_phu"}
            onChange={(name) => setF((x) => ({ ...x, partnerName: name }))}
          />
          <span className="block text-[10px] text-slate-400">
            Dùng chung danh mục đối tác (Hồ sơ trình ký &gt; Kế hoạch thu chi). Tên mới sẽ được thêm vào danh mục; số tài khoản nhập ở đó.
          </span>
          <ErrorLine msg={partnerErr} />
        </div>
        {type === "B_B1" && (
          <Field label="Theo HĐ A-B">
            <Select value={f.parent} onChange={set("parent")}>
              <option value="">— Không chọn —</option>
              {abContracts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.contract_no || a.partner_name || a.id.slice(0, 8)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {type === "B_B1" && (
          <Field label="Vai trò">
            <Select value={f.role} onChange={set("role")}>
              <option value="MAIN">Nhà thầu chính</option>
              <option value="SUB">Nhà thầu phụ</option>
            </Select>
          </Field>
        )}
        <Field label="Tư cách pháp lý">
          <Select value={f.legal} onChange={set("legal")}>
            <option value="">—</option>
            <option value="NOMINAL">Chính danh</option>
            <option value="NON_NOMINAL">Không chính danh</option>
          </Select>
        </Field>
        <Field label="Trạng thái">
          <Select value={f.status} onChange={set("status")}>
            {Object.entries(CONTRACT_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Số hợp đồng">
          <TextInput value={f.no} onChange={set("no")} />
        </Field>
        <Field label="Ngày ký">
          <TextInput type="date" value={f.date} onChange={set("date")} />
        </Field>
        <Field label="Ghi chú" className="md:col-span-2">
          <TextInput value={f.note} onChange={set("note")} />
        </Field>
        {canFin && (
          <>
            <div className="md:col-span-2 border-t border-slate-100 pt-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-400">
              Giá trị (chỉ BLĐ / GĐDA / TC-KT thấy)
            </div>
            <Field label="GT HĐ trước thuế">
              <MoneyInput value={f.value} onChange={(v) => setF((x) => ({ ...x, value: v }))} />
            </Field>
            <Field label="Thuế VAT (%)">
              <TextInput value={f.vat} onChange={set("vat")} />
            </Field>
            <Field label="Tạm ứng (%)">
              <TextInput value={f.advance} onChange={set("advance")} />
            </Field>
            <Field label="Giữ lại bảo hành (%)">
              <TextInput value={f.retention} onChange={set("retention")} />
            </Field>
          </>
        )}
      </div>
      <ErrorLine msg={err} />
      <div className="flex justify-end">
        <PrimaryButton onClick={save} busy={saving}>
          Lưu hợp đồng
        </PrimaryButton>
      </div>
    </Modal>
  );
}

function ScopeModal({
  contract,
  segments,
  catalog,
  canFin,
  onClose,
  onSaved,
}: {
  contract: PcContract;
  segments: PcSegment[];
  catalog: PcWbsItem[];
  canFin: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [segIds, setSegIds] = useState<string[]>([]);
  const [wbsId, setWbsId] = useState("");
  const [desc, setDesc] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!segIds.length) return setErr("Chọn ít nhất một lý trình.");
    setSaving(true);
    setErr(null);
    const { data, error } = await supabase
      .from("pc_contract_scopes")
      .insert(segIds.map((sid) => ({ contract_id: contract.id, segment_id: sid, wbs_item_id: wbsId || null, scope_desc: desc.trim() || null })))
      .select("id");
    if (error || !data) {
      setSaving(false);
      return setErr(pcErrorMessage(error));
    }
    // Giá trị chỉ gán khi thêm ĐÚNG MỘT lý trình (chia nhiều lý trình thì nhập riêng từng dòng).
    const v = parseVnd(value);
    if (canFin && v != null && data.length === 1) {
      const e = await pcUpsert("pc_contract_scope_finance", { scope_id: data[0].id, value: v }, "scope_id");
      if (e) {
        setSaving(false);
        return setErr(e);
      }
    }
    setSaving(false);
    onSaved();
  }

  return (
    <Modal title={`Thêm phạm vi — ${contract.partner_name || ""}`} onClose={onClose}>
      {segments.length === 0 ? (
        <p className="text-xs text-slate-500">Dự án chưa có lý trình. Thêm ở tab Lý trình & Hạng mục trước.</p>
      ) : (
        <>
          <Field label="Lý trình (chọn được nhiều)">
            <div className="flex flex-wrap gap-1.5">
              {segments.map((s) => {
                const on = segIds.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSegIds((x) => (on ? x.filter((i) => i !== s.id) : [...x, s.id]))}
                    className={`text-[11px] font-bold px-2.5 py-1 rounded-lg border ${
                      on ? "bg-[#005BAC] text-white border-transparent" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    {s.code}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="Hạng mục (để trống = cả lý trình)">
            <Select value={wbsId} onChange={(e) => setWbsId(e.target.value)}>
              <option value="">Cả lý trình</option>
              {catalog.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Mô tả phạm vi">
            <TextInput value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Tuyến + HTKT / Cây xanh, ATGT, chiếu sáng…" />
          </Field>
          {canFin && (
            <Field label="Giá trị phần phạm vi (chỉ khi chọn 1 lý trình)">
              <MoneyInput value={value} onChange={setValue} disabled={segIds.length > 1} />
            </Field>
          )}
          <ErrorLine msg={err} />
          <div className="flex justify-end">
            <PrimaryButton onClick={save} busy={saving}>
              Thêm phạm vi
            </PrimaryButton>
          </div>
        </>
      )}
    </Modal>
  );
}

function AddendumModal({ contract, onClose, onSaved }: { contract: PcContract; onClose: () => void; onSaved: () => void }) {
  const [no, setNo] = useState("");
  const [date, setDate] = useState("");
  const [sign, setSign] = useState<"+" | "-">("+");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    const v = parseVnd(value);
    if (v == null) return setErr("Nhập giá trị tăng/giảm.");
    setSaving(true);
    setErr(null);
    const { error } = await supabase.from("pc_contract_addenda").insert({
      contract_id: contract.id,
      addendum_no: no.trim() || null,
      sign_date: date || null,
      value_change: sign === "-" ? -Math.abs(v) : Math.abs(v),
      reason: reason.trim() || null,
    });
    setSaving(false);
    if (error) return setErr(pcErrorMessage(error));
    onSaved();
  }

  return (
    <Modal title={`Thêm phụ lục — ${contract.partner_name || ""}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Số phụ lục">
          <TextInput value={no} onChange={(e) => setNo(e.target.value)} placeholder="PL01" />
        </Field>
        <Field label="Ngày ký">
          <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Tăng / giảm">
          <Select value={sign} onChange={(e) => setSign(e.target.value as "+" | "-")}>
            <option value="+">Tăng giá trị (+)</option>
            <option value="-">Giảm giá trị (−)</option>
          </Select>
        </Field>
        <Field label="Giá trị">
          <MoneyInput value={value} onChange={setValue} />
        </Field>
        <Field label="Lý do" className="col-span-2">
          <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Phát sinh thiết kế, điều chỉnh giá…" />
        </Field>
      </div>
      <ErrorLine msg={err} />
      <div className="flex justify-end">
        <PrimaryButton onClick={save} busy={saving}>
          Thêm phụ lục
        </PrimaryButton>
      </div>
    </Modal>
  );
}

// Ô chọn Chủ đầu tư / Nhà thầu: tìm không dấu, danh sách có biểu tượng + dòng phụ
// (tên gọi tắt • loại đối tác • MST). Gõ tên chưa có -> dòng "Thêm mới" lên đầu.
function PartnerPicker({
  partners,
  value,
  preferType,
  onChange,
}: {
  partners: Partner[];
  value: string;
  preferType: string;
  onChange: (name: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const options = useMemo(() => {
    const q = fold(search.trim());
    const list = q
      ? partners.filter((p) => fold(`${p.name} ${p.short_name || ""} ${p.tax_code || ""}`).includes(q))
      : partners;
    // Đúng loại (CĐT cho HĐ A-B, nhà thầu cho B-B') lên đầu.
    return [...list].sort((a, b) => Number(b.party_type === preferType) - Number(a.party_type === preferType)).slice(0, 60);
  }, [partners, search, preferType]);

  const typed = search.trim();
  const exact = partners.some((p) => p.name.toLowerCase() === typed.toLowerCase());
  const selected = value ? partners.find((p) => p.name.toLowerCase() === value.toLowerCase()) : null;

  const sub = (p: Partner) =>
    [p.short_name, PARTY_LABEL[p.party_type] || p.party_type, p.tax_code ? `MST ${p.tax_code}` : ""].filter(Boolean).join(" • ");

  return (
    <div className="relative" ref={ref}>
      {value ? (
        <div className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg flex items-center gap-2">
          <PartnerIcon />
          <span className="flex-1 min-w-0">
            <span className="block text-[11px] font-bold text-slate-700 truncate">{value}</span>
            <span className="block text-[10px] text-slate-400 font-semibold truncate">
              {selected ? sub(selected) : "Đối tác mới — sẽ thêm vào danh mục khi lưu"}
            </span>
          </span>
          <button
            type="button"
            onClick={() => {
              onChange("");
              setSearch("");
              setOpen(true);
            }}
            title="Chọn đơn vị khác"
            className="text-slate-400 hover:text-rose-500 shrink-0"
          >
            <X size={13} />
          </button>
        </div>
      ) : (
        <div className="w-full px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg flex items-center gap-1.5 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500/40">
          <Search size={12} className="text-slate-400 shrink-0" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder="Tìm tên, tên gọi tắt hoặc mã số thuế…"
            className="flex-1 min-w-0 outline-none text-[11px] font-semibold placeholder:font-normal bg-transparent text-slate-800"
          />
        </div>
      )}

      {open && !value && (
        <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-xl z-40 max-h-64 overflow-y-auto animate-in fade-in duration-150">
          {typed && !exact && (
            <button
              type="button"
              onClick={() => {
                onChange(typed);
                setOpen(false);
              }}
              className="w-full flex items-center gap-2.5 text-left px-3 py-2 hover:bg-slate-50 border-b border-slate-100"
            >
              <span className="w-7 h-7 rounded-lg bg-blue-50 text-[#005BAC] flex items-center justify-center shrink-0">
                <Plus size={13} />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[11px] font-bold text-[#005BAC] truncate">Thêm mới: &quot;{typed}&quot;</span>
                <span className="block text-[10px] text-slate-400 font-semibold">Chưa có trong danh mục đối tác</span>
              </span>
            </button>
          )}
          {options.length === 0 ? (
            !typed && <p className="text-center text-slate-400 text-[11px] italic py-4">Danh mục đối tác đang trống.</p>
          ) : (
            options.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onChange(p.name);
                  setOpen(false);
                  setSearch("");
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 text-left"
              >
                <PartnerIcon />
                <span className="flex-1 min-w-0">
                  <span className="block text-[11px] font-bold text-slate-700 truncate">{p.name}</span>
                  <span className="block text-[10px] text-slate-400 font-semibold truncate">{sub(p)}</span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function PartnerIcon() {
  return (
    <span className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-400 text-white flex items-center justify-center shrink-0">
      <Building2 size={13} />
    </span>
  );
}

// Đơn giá B-B' theo từng hạng mục trong phạm vi HĐ (P3). Hiện đơn giá A-B bên cạnh
// để thấy ngay chênh lệch (lãi gộp). Để trống = xoá đơn giá.
function BbPriceModal({
  contract,
  scopes,
  segments,
  catalog,
  canEdit,
  onClose,
}: {
  contract: PcContract;
  scopes: PcScope[];
  segments: PcSegment[];
  catalog: PcWbsItem[];
  canEdit: boolean;
  onClose: () => void;
}) {
  type Row = { swId: string; segCode: string; item: string; unit: string | null; qty: number | null; priceA: number | null };
  const [rows, setRows] = useState<Row[] | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [orig, setOrig] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      const segIds = [...new Set(scopes.map((x) => x.segment_id))];
      const { data: sw } = await supabase.from("pc_segment_wbs").select("*").in("segment_id", segIds);
      const all = ((sw as { id: string; segment_id: string; wbs_item_id: string; applicable: boolean; unit: string | null; budget_qty: number | null }[]) || [])
        .filter((w) => w.applicable)
        // Thuộc phạm vi: đúng hạng mục, hoặc phạm vi "cả lý trình".
        .filter((w) => scopes.some((x) => x.segment_id === w.segment_id && (!x.wbs_item_id || x.wbs_item_id === w.wbs_item_id)));
      const ids = all.map((w) => w.id);
      const [fa, fb] = await Promise.all([
        ids.length ? supabase.from("pc_segment_wbs_finance").select("segment_wbs_id, unit_price").in("segment_wbs_id", ids) : Promise.resolve({ data: [] }),
        supabase.from("pc_bb_unit_prices").select("segment_wbs_id, unit_price").eq("contract_id", contract.id),
      ]);
      const aMap = new Map(((fa.data as { segment_wbs_id: string; unit_price: number | null }[]) || []).map((x) => [x.segment_wbs_id, x.unit_price]));
      const bList = (fb.data as { segment_wbs_id: string; unit_price: number }[]) || [];
      const segCode = new Map(segments.map((x) => [x.id, x.code]));
      const itemMap = new Map(catalog.map((c) => [c.id, c]));
      setRows(
        all
          .map((w) => ({
            swId: w.id,
            segCode: segCode.get(w.segment_id) || "?",
            item: `${itemMap.get(w.wbs_item_id)?.code || ""} ${itemMap.get(w.wbs_item_id)?.name || ""}`,
            unit: w.unit,
            qty: w.budget_qty,
            priceA: aMap.get(w.id) ?? null,
            sort: itemMap.get(w.wbs_item_id)?.sort_order ?? 0,
          }))
          .sort((a, b) => (a.segCode === b.segCode ? a.sort - b.sort : a.segCode < b.segCode ? -1 : 1))
      );
      const o: Record<string, number> = {};
      const pr: Record<string, string> = {};
      bList.forEach((x) => {
        o[x.segment_wbs_id] = x.unit_price;
        pr[x.segment_wbs_id] = formatVnd(x.unit_price);
      });
      setOrig(o);
      setPrices(pr);
    })();
    // Chỉ nạp khi mở / đổi hợp đồng: `scopes` là mảng lọc mới mỗi lần trang cha vẽ
    // lại — đưa vào deps sẽ nạp lại và xoá mất số đang nhập dở.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract.id]);

  async function save() {
    if (!rows) return;
    setSaving(true);
    setErr(null);
    for (const r of rows) {
      const v = parseVnd(prices[r.swId] || "");
      const before = orig[r.swId];
      if (v === (before ?? null)) continue;
      let e: string | null = null;
      if (v == null) e = await pcDelete("pc_bb_unit_prices", { contract_id: contract.id, segment_wbs_id: r.swId });
      else e = await pcUpsert("pc_bb_unit_prices", { contract_id: contract.id, segment_wbs_id: r.swId, unit_price: v }, "contract_id,segment_wbs_id");
      if (e) {
        setSaving(false);
        return setErr(`${r.segCode} ${r.item}: ${e}`);
      }
    }
    const o: Record<string, number> = {};
    rows.forEach((r) => {
      const v = parseVnd(prices[r.swId] || "");
      if (v != null) o[r.swId] = v;
    });
    setOrig(o);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <Modal title={`Đơn giá B-B' theo hạng mục — ${contract.partner_name}`} onClose={onClose} wide>
      {!rows ? (
        <div className="flex justify-center py-8">
          <Loader2 className="animate-spin text-[#005BAC]" size={22} />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-xs text-slate-500">Phạm vi HĐ chưa trùng hạng mục nào. Gán hạng mục cho lý trình ở tab Lý trình &amp; Hạng mục trước.</p>
      ) : (
        <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full min-w-[720px] text-[11px]">
          <thead>
            <tr className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 text-left">
              <th className="py-1.5">Lý trình</th>
              <th className="px-2">Hạng mục</th>
              <th className="px-2 text-right">KL HĐ</th>
              <th className="px-2 text-right">Đơn giá A-B</th>
              <th className="px-2 w-44">Đơn giá B-B&apos;</th>
              <th className="px-2 text-right">Chênh lệch</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const b = parseVnd(prices[r.swId] || "");
              const margin = r.priceA && b != null ? (r.priceA - b) / r.priceA : null;
              return (
                <tr key={r.swId} className="border-t border-slate-100">
                  <td className="py-1.5 font-bold text-slate-700">{r.segCode}</td>
                  <td className="px-2 text-slate-600">{r.item}</td>
                  <td className="px-2 text-right text-slate-500">
                    {r.qty != null ? Number(r.qty).toLocaleString("vi-VN") : "—"} {r.unit || ""}
                  </td>
                  <td className="px-2 text-right font-mono text-slate-500">{r.priceA != null ? formatVnd(r.priceA) : "—"}</td>
                  <td className="px-2">
                    <MoneyInput value={prices[r.swId] || ""} disabled={!canEdit} onChange={(v) => setPrices((p) => ({ ...p, [r.swId]: v }))} />
                  </td>
                  <td className={`px-2 text-right font-bold ${margin === null ? "text-slate-300" : margin < 0 ? "text-rose-600" : "text-emerald-600"}`}>
                    {margin === null ? "—" : `${(margin * 100).toFixed(1)}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
      <p className="text-[10px] text-slate-400">Chênh lệch âm (đỏ) = đơn giá B-B&apos; cao hơn A-B, hạng mục đang lỗ. Để trống ô = xoá đơn giá.</p>
      <ErrorLine msg={err} />
      {canEdit && rows && rows.length > 0 && (
        <div className="flex justify-end">
          <PrimaryButton onClick={save} busy={saving}>
            {saved ? "Đã lưu" : "Lưu đơn giá"}
          </PrimaryButton>
        </div>
      )}
    </Modal>
  );
}
