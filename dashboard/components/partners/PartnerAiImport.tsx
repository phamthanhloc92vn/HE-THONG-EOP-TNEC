"use client";

// ============================================================
// Danh bạ đối tác > Nhập bằng AI (GPT-4o)
//
// Luồng: chọn nguồn (ảnh, PDF, mã QR trong ảnh, Excel/CSV, Word, văn bản dán) ->
// AI bóc tách -> danh sách đối tác để XEM LẠI -> tick rồi "Lưu", hoặc "Sửa" từng mục
// trong form đầy đủ. AI KHÔNG tự lưu. Mục trùng đối tác đã có bị khoá, MST bóc được
// tự tra tình trạng hoạt động (cờ đỏ) trong lúc người dùng xem lại.
// Khoá OpenAI nằm trong trình duyệt của người dùng (xem lib/partnerAi.ts).
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type PartnerRow, type PartnerInput, type PartnerKind,
  KIND_LABELS, KIND_ORDER, REGION_LABELS,
  createPartner, updatePartner, validateInput, lookupTax, taxLevel, taxStatusText, formatCheckedDate, cleanTaxCode,
} from "@/lib/partnerDirectory";
import {
  type AiSource, type AiItem, AI_MODELS, DEFAULT_AI_MODEL, MAX_SOURCE_BYTES,
  loadAiConfig, saveAiConfig, extractFromSource, findDup, dupPoolFromRows, sourceKindOf,
  findMatch, identityKey, mergeInputs, overlayOnRow, findTaxCodeByName, sameCompany, taxSearchArea,
} from "@/lib/partnerAi";
import {
  X, Sparkles, Settings2, Upload, FileText, Image as ImageIcon, FileSpreadsheet, Loader2, AlertCircle,
  AlertTriangle, ShieldCheck, Check, Eye, EyeOff, Pencil, Trash2, KeyRound,
} from "lucide-react";

const inputCls =
  "w-full text-base sm:text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 sm:py-2 focus:bg-white focus:outline-none focus:border-[#00AEEF]";

const FIELD_LABELS: Record<string, string> = {
  name: "tên", short_name: "tên gọi tắt", tax_code: "MST", address: "địa chỉ", website: "website",
  contact_name: "người liên hệ", contact_title: "chức danh", legal_rep_name: "người đại diện", legal_rep_title: "chức danh đại diện",
  phone: "SĐT", phone2: "SĐT 2", email: "email", zalo: "Zalo", viber: "Viber", whatsapp: "WhatsApp", telegram: "Telegram",
  regions: "khu vực", provinces: "tỉnh/thành", fields: "lĩnh vực", capability: "năng lực", kind: "loại", note: "ghi chú",
};

let seq = 0;
const uid = () => `ai-${Date.now().toString(36)}-${++seq}`;

function aiErrorMessage(e: unknown): string {
  const err = e as { status?: number; message?: string; code?: string };
  if (err?.status === 401) return "Khoá OpenAI không hợp lệ hoặc đã bị thu hồi. Bấm biểu tượng cài đặt để nhập lại.";
  if (err?.status === 429) return "OpenAI từ chối vì hết hạn mức hoặc gọi quá nhanh. Kiểm tra số dư tài khoản OpenAI rồi thử lại.";
  if (err?.status === 404) return "Tài khoản OpenAI chưa dùng được model đã chọn. Đổi model trong cài đặt.";
  if (err?.status === 413) return "Tệp quá lớn để AI đọc. Chia nhỏ hoặc nén tệp rồi thử lại.";
  return err?.message || "Lỗi không xác định khi gọi AI.";
}

export default function PartnerAiImport({
  existing, who, onOpenForm, onChanged, onClose,
}: {
  existing: PartnerRow[];
  who: string;
  // Mở form đầy đủ với dữ liệu AI điền sẵn; `done(id)` được gọi khi form lưu xong.
  // `partner` có giá trị = mở form SỬA đối tác đã có (chế độ ghi đè), không thì thêm mới.
  onOpenForm: (initial: PartnerInput, done: (savedId: string | null) => void, partner?: PartnerRow | null) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  // ─── Cấu hình khoá / model ───
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(DEFAULT_AI_MODEL);
  const [showCfg, setShowCfg] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [cfgSaved, setCfgSaved] = useState(false);
  useEffect(() => {
    const c = loadAiConfig();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setApiKey(c.apiKey);
    setModel(c.model);
    if (!c.apiKey) setShowCfg(true);
  }, []);
  const saveCfg = () => {
    saveAiConfig(apiKey, model);
    setCfgSaved(true);
    setTimeout(() => setCfgSaved(false), 2000);
    if (apiKey.trim()) setShowCfg(false);
  };

  // ─── Nguồn ───
  const [sources, setSources] = useState<AiSource[]>([]);
  const [pasted, setPasted] = useState("");
  const [kindHint, setKindHint] = useState<PartnerKind | "auto">("auto");
  // Excel/CSV mặc định đọc theo tiêu đề cột (không tốn API); tick để ép AI đọc.
  const [forceAiSheet, setForceAiSheet] = useState(false);
  // Khi đối tác trong tệp đã có trong danh bạ (cùng MST, hoặc đúng tên): chép đè hay thêm dòng mới.
  const [dupMode, setDupMode] = useState<"overwrite" | "add">("overwrite");
  const [runInfos, setRunInfos] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((list: File[]) => {
    setMsg(null);
    const ok: AiSource[] = [];
    const bad: string[] = [];
    for (const f of list) {
      const k = sourceKindOf(f);
      if (k === "unknown") bad.push(`"${f.name}": định dạng chưa hỗ trợ`);
      else if (k === "heic") bad.push(`"${f.name}": ảnh HEIC của iPhone, trình duyệt chưa đọc được — chụp lại ở chế độ "Tương thích nhất" hoặc chụp màn hình`);
      else if (f.size > MAX_SOURCE_BYTES) bad.push(`"${f.name}": lớn hơn ${MAX_SOURCE_BYTES / 1024 / 1024}MB`);
      else ok.push({ id: uid(), kind: "file", name: f.name || "Ảnh dán vào", file: f });
    }
    if (ok.length) setSources((p) => [...p, ...ok]);
    if (bad.length) setMsg(bad.join(" · "));
  }, []);

  // ─── Kết quả ───
  const [items, setItems] = useState<AiItem[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [runErrs, setRunErrs] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const cancelRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cancelRef.current = true;
    };
  }, []);

  const patchItem = useCallback((id: string, patch: Partial<AiItem> | ((it: AiItem) => Partial<AiItem>)) => {
    if (!aliveRef.current) return;
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...(typeof patch === "function" ? patch(it) : patch) } : it)));
  }, []);

  // Tự tra MST từng mục (tuần tự, nghỉ giữa các lần để không dồn dập vào nguồn miễn phí).
  // Mục thiếu MST ("searching"): AI tìm theo tên + khu vực, rồi CHỈ điền khi nguồn tra cứu
  // xác nhận MST đó đúng tên công ty; không chắc thì để trống.
  const runTaxChecks = useCallback(
    async (list: AiItem[], key: string, aiModel: string) => {
      for (const it of list) {
        if (!aliveRef.current || cancelRef.current) return;
        if (it.tax === "searching") {
          let aiErr = "";
          const found = await findTaxCodeByName(key, aiModel, it.input).catch((e) => {
            console.warn("[partner] AI tìm MST lỗi:", e);
            aiErr = aiErrorMessage(e);
            return "";
          });
          const r = found ? await lookupTax(found) : null;
          if (!aliveRef.current) return;
          const note = aiErr
            ? `AI tìm MST lỗi: ${aiErr}`
            : !found
              ? "AI không tìm được MST chắc chắn theo tên + khu vực."
              : !r?.ok
                ? `AI tìm được MST ${found} nhưng chưa tra lại được (${r?.error || "nguồn tra cứu lỗi"}), nên chưa điền.`
                : !r.found
                  ? `AI tìm được MST ${found} nhưng nguồn tra cứu không có, nên chưa điền.`
                  : `AI tìm được MST ${found} nhưng tên ở nguồn tra cứu là "${r.name || "?"}", không khớp, nên chưa điền.`;
          if (r?.ok && r.found && sameCompany(r.name, it.input.name))
            patchItem(it.id, (cur) =>
              cur.input.tax_code.trim()
                ? { tax: "none" } // người dùng đã tự gõ MST trong lúc chờ
                : {
                    tax: "done",
                    taxByAi: true,
                    input: {
                      ...cur.input,
                      tax_code: found,
                      tax_status: r.status || "",
                      tax_checked_at: r.status ? r.checkedAt : "",
                      address: cur.input.address.trim() ? cur.input.address : r.address || "",
                    },
                  }
            );
          else patchItem(it.id, { tax: "none", taxNote: note });
          await new Promise((res) => setTimeout(res, 350));
          continue;
        }
        const code = cleanTaxCode(it.input.tax_code);
        if (!code) continue;
        const r = await lookupTax(code);
        if (!aliveRef.current) return;
        if (!r.ok) patchItem(it.id, { tax: "error" });
        else if (!r.found) patchItem(it.id, { tax: "notfound" });
        else
          patchItem(it.id, (cur) => ({
            tax: "done",
            input: {
              ...cur.input,
              tax_status: r.status || "",
              tax_checked_at: r.status ? r.checkedAt : "",
              name: cur.input.name.trim() ? cur.input.name : r.name || "",
              address: cur.input.address.trim() ? cur.input.address : r.address || "",
            },
          }));
        await new Promise((res) => setTimeout(res, 350));
      }
    },
    [patchItem]
  );

  async function run() {
    setMsg(null);
    setRunErrs([]);
    setRunInfos([]);
    const all: AiSource[] = [...sources];
    if (pasted.trim()) all.push({ id: uid(), kind: "text", name: "Văn bản dán vào", text: pasted });
    if (all.length === 0) return setMsg("Chọn ít nhất một tệp, dán ảnh hoặc dán văn bản.");
    // Khoá OpenAI chỉ bắt buộc khi có nguồn cần AI (ảnh, PDF, Word, văn bản; Excel thì chỉ khi ép AI hoặc tiêu đề cột lạ).
    const needsKey = all.some((s) => s.kind === "text" || !["sheet"].includes(sourceKindOf(s.file)) || forceAiSheet);
    if (needsKey && !apiKey.trim()) {
      setShowCfg(true);
      return setMsg("Chưa có khoá OpenAI. Dán khoá vào ô bên trên rồi bấm Lưu cấu hình.");
    }

    cancelRef.current = false;
    setRunning(true);
    const errs: string[] = [];
    const infos: string[] = [];
    // Gom kết quả của mọi nguồn rồi mới đưa lên màn hình một lần (chế độ ghi đè còn gộp các dòng
    // trùng nhau giữa các sheet nên cần thấy toàn bộ trước).
    const gathered: { src: AiSource; input: PartnerInput; uncertain: string[] }[] = [];
    for (let i = 0; i < all.length; i++) {
      if (cancelRef.current) break;
      const src = all[i];
      const tag = `(${i + 1}/${all.length}) ${src.name}`;
      setProgress(tag);
      try {
        const out = await extractFromSource({ apiKey: apiKey.trim(), model, source: src, kindHint, forceAiForSheet: forceAiSheet, onProgress: (m) => aliveRef.current && setProgress(`${tag}: ${m}`) });
        if (out.items.length === 0) errs.push(`${src.name}: không tìm thấy đối tác nào trong nguồn này.`);
        else if (out.via === "local" && out.info) infos.push(`${src.name}: ${out.info}`);
        else if (out.via === "ai") infos.push(`${src.name}: AI đọc được ${out.items.length} đối tác`);
        for (const r of out.items) gathered.push({ src, input: r.input, uncertain: r.uncertain });
      } catch (e) {
        const m = aiErrorMessage(e);
        errs.push(`${src.name}: ${m}`);
        if (/Cần khoá OpenAI/.test(m)) setShowCfg(true);
        // Lỗi khoá / hạn mức: các nguồn sau cũng sẽ lỗi như vậy, dừng cho khỏi tốn thời gian.
        const st = (e as { status?: number })?.status;
        if (st === 401 || st === 429 || st === 404) break;
      }
    }
    if (!aliveRef.current) return;

    const overwrite = dupMode === "overwrite";
    const created: AiItem[] = [];
    const byKey = new Map<string, AiItem>();
    // Cảnh báo trùng: so với danh bạ đã có và với các mục đã xếp trước đó trong danh sách này.
    const pool = [...dupPoolFromRows(existing), ...items.map((i) => ({ name: i.input.name, tax_code: i.input.tax_code || null, phone: i.input.phone || null, phone2: i.input.phone2 || null, origin: "batch" as const }))];
    let mergedLines = 0;
    for (const g of gathered) {
      const key = identityKey(g.input);
      const first = overwrite ? byKey.get(key) : undefined;
      if (first) {
        // Cùng công ty xuất hiện ở sheet khác: gộp thông tin vào một mục.
        first.input = mergeInputs(first.input, g.input);
        first.merged += 1;
        first.uncertain = Array.from(new Set([...first.uncertain, ...g.uncertain]));
        mergedLines++;
        continue;
      }
      const item: AiItem = {
        id: uid(), source: g.src.name, input: g.input, uncertain: g.uncertain, dup: null, matchId: null, matchName: null, merged: 0,
        selected: true, status: "idle",
        tax: g.input.tax_code ? "pending" : apiKey.trim() && taxSearchArea(g.input) ? "searching" : "none",
        taxNote: !g.input.tax_code && apiKey.trim() && !taxSearchArea(g.input) ? "Chưa có địa chỉ/tỉnh thành nên AI không tìm MST." : undefined,
      };
      if (!overwrite) {
        item.dup = findDup(g.input, pool);
        pool.push({ name: g.input.name, tax_code: g.input.tax_code || null, phone: g.input.phone || null, phone2: g.input.phone2 || null, origin: "batch" });
      }
      created.push(item);
      byKey.set(key, item);
    }
    // Ghi đè: khớp từng mục với đối tác đã có (theo MST, hoặc đúng tên); số điện thoại chỉ cảnh báo.
    if (overwrite) {
      for (const it of created) {
        const row = findMatch(it.input, existing);
        if (row) {
          it.matchId = row.id;
          it.matchName = row.name;
        } else {
          it.dup = findDup(it.input, dupPoolFromRows(existing), { phoneOnly: true });
        }
      }
    }
    if (mergedLines > 0) infos.push(`Đã gộp ${mergedLines} dòng trùng nhau trong tệp (cùng công ty ở nhiều sheet) thành một mục.`);
    const upd = created.filter((c) => c.matchId).length;
    if (overwrite && upd > 0) infos.push(`${upd} mục khớp đối tác đã có trong danh bạ: sẽ chép đè ô có dữ liệu, ô tệp để trống thì giữ nguyên.`);

    setItems((prev) => [...prev, ...created]);
    setRunErrs(errs);
    setRunInfos(infos);
    setSources([]);
    setPasted("");
    setRunning(false);
    setProgress("");
    runTaxChecks(created.filter((c) => c.tax === "pending" || c.tax === "searching"), apiKey.trim(), model);
  }

  // ─── Lưu ───
  // Danh bạ là kho thu thập gốc: mục trùng chỉ CẢNH BÁO, vẫn tick và lưu được như mục thường.
  const selectable = (it: AiItem) => it.status !== "saved";
  const selectedItems = items.filter((i) => i.selected && selectable(i));

  async function saveSelected() {
    if (saving || selectedItems.length === 0) return;
    setSaving(true);
    for (const it of selectedItems) {
      if (!aliveRef.current) return;
      const row = it.matchId ? existing.find((r) => r.id === it.matchId) || null : null;
      // Ghi đè: ghép dữ liệu tệp lên bản cũ (ô trống của tệp giữ nguyên bản cũ) rồi mới kiểm tra.
      const finalInput = row ? overlayOnRow(row, it.input) : it.input;
      const bad = validateInput(finalInput);
      if (bad) {
        patchItem(it.id, { status: "error", error: `${bad} Bấm Sửa để bổ sung.` });
        continue;
      }
      patchItem(it.id, { status: "saving", error: undefined });
      const err = row ? await updatePartner(row.id, finalInput, who || null) : (await createPartner(it.input, who || null)).error;
      if (err) patchItem(it.id, { status: "error", error: err });
      else patchItem(it.id, { status: "saved", selected: false, error: undefined, action: row ? "updated" : "created" });
    }
    if (aliveRef.current) setSaving(false);
    onChanged();
  }

  const stats = useMemo(() => {
    const total = items.length;
    const dups = items.filter((i) => i.dup).length;
    const updates = items.filter((i) => i.matchId).length;
    const red = items.filter((i) => taxLevel(i.input.tax_status) === "red").length;
    const saved = items.filter((i) => i.status === "saved").length;
    return { total, dups, updates, red, saved };
  }, [items]);

  const allSelectable = items.filter(selectable);
  const allChecked = allSelectable.length > 0 && allSelectable.every((i) => i.selected);

  const hasInput = sources.length > 0 || pasted.trim().length > 0;

  return createPortal(
    <div className="fixed inset-0 z-[85] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center sm:p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        onPaste={(e) => {
          // Ctrl+V ảnh chụp màn hình / ảnh copy (ví dụ từ Zalo bản máy tính).
          const files = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith("image/"));
          if (files.length) {
            e.preventDefault();
            addFiles(files);
          }
        }}
        className="bg-white sm:rounded-2xl shadow-2xl w-full sm:max-w-5xl max-sm:h-full sm:max-h-[94vh] flex flex-col animate-in zoom-in-95 duration-150"
      >
        <div className="shrink-0 flex items-center gap-2 px-4 sm:px-6 py-4 border-b border-slate-100">
          <Sparkles size={18} className="text-[#005BAC]" />
          <h2 className="font-heading font-extrabold text-sm text-slate-800 flex-1">Nhập đối tác bằng AI</h2>
          <button
            type="button"
            onClick={() => setShowCfg((s) => !s)}
            title="Cấu hình khoá OpenAI"
            aria-label="Cấu hình khoá OpenAI"
            className={`flex items-center gap-1.5 text-xs sm:text-[11px] font-bold px-3 py-2 sm:py-1.5 rounded-lg cursor-pointer ${apiKey ? "text-slate-500 bg-slate-100 hover:bg-slate-200" : "text-amber-700 bg-amber-50 border border-amber-200"}`}
          >
            <Settings2 size={14} /> {apiKey ? "Cấu hình AI" : "Nhập khoá OpenAI"}
          </button>
          <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-rose-500 cursor-pointer" aria-label="Đóng"><X size={20} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-4">
          {showCfg && (
            <div className="border border-slate-200 bg-slate-50 rounded-xl p-4 space-y-3">
              <p className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider text-slate-500"><KeyRound size={13} /> Cấu hình OpenAI cho Danh bạ đối tác</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="block space-y-1 sm:col-span-2">
                  <span className="text-[10px] font-bold text-slate-500">OpenAI API Key</span>
                  <div className="flex gap-2">
                    <input
                      type={showKey ? "text" : "password"}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="sk-..."
                      autoComplete="off"
                      spellCheck={false}
                      className={inputCls}
                    />
                    <button type="button" onClick={() => setShowKey((s) => !s)} title={showKey ? "Ẩn khoá" : "Hiện khoá"} className="shrink-0 px-3 rounded-lg bg-white border border-slate-200 text-slate-400 hover:text-slate-700 cursor-pointer">
                      {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </label>
                <label className="block space-y-1">
                  <span className="text-[10px] font-bold text-slate-500">Model</span>
                  <select value={model} onChange={(e) => setModel(e.target.value)} className={inputCls}>
                    {AI_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>{m.id}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={saveCfg} className="text-xs sm:text-[11px] font-bold bg-[#005BAC] hover:bg-blue-700 text-white px-4 py-2 sm:py-1.5 rounded-lg cursor-pointer">Lưu cấu hình</button>
                {cfgSaved && <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-600"><Check size={13} /> Đã lưu</span>}
              </div>
            </div>
          )}

          {/* ─── Nguồn ─── */}
          <div className="space-y-3">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                addFiles(Array.from(e.dataTransfer.files || []));
              }}
              onClick={() => fileRef.current?.click()}
              className={`flex flex-col items-center justify-center gap-1.5 text-center rounded-xl border-2 border-dashed px-4 py-7 cursor-pointer transition-colors ${dragOver ? "border-[#00AEEF] bg-sky-50" : "border-slate-200 bg-slate-50/60 hover:border-[#00AEEF]"}`}
            >
              <Upload size={22} className="text-[#005BAC]" />
              <p className="text-xs font-bold text-slate-700">Kéo thả hoặc bấm để chọn tệp</p>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept="image/*,.pdf,.xlsx,.xls,.xlsm,.csv,.docx,.doc,.txt"
                className="hidden"
                onChange={(e) => {
                  addFiles(Array.from(e.target.files || []));
                  e.target.value = "";
                }}
              />
            </div>

            <label className="block space-y-1">
              <span className="text-[10px] font-bold text-slate-500">Hoặc dán văn bản (tin nhắn Zalo, email, thông tin liên hệ…)</span>
              <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={3} placeholder="VD: Công ty TNHH ABC, MST 0312345678, anh Tuấn 0903 123 456, chuyên bê tông thương phẩm khu vực Đồng Nai…" className={inputCls} />
            </label>

            {sources.length > 0 && (
              <ul className="divide-y divide-slate-100 border border-slate-100 rounded-xl overflow-hidden">
                {sources.map((s) => {
                  const k = s.kind === "file" ? sourceKindOf(s.file) : "text";
                  const Icon = k === "image" ? ImageIcon : k === "sheet" ? FileSpreadsheet : FileText;
                  return (
                    <li key={s.id} className="flex items-center gap-3 px-3 py-2">
                      <Icon size={16} className="text-[#005BAC] shrink-0" />
                      <p className="flex-1 min-w-0 text-xs font-bold text-slate-700 truncate">{s.name}</p>
                      <button type="button" onClick={() => setSources((p) => p.filter((x) => x.id !== s.id))} disabled={running} aria-label="Bỏ tệp này" className="p-1.5 rounded-lg text-slate-300 hover:text-rose-600 hover:bg-rose-50 cursor-pointer disabled:opacity-40"><X size={15} /></button>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-[11px] font-bold text-slate-500">
                Phân loại
                <select value={kindHint} onChange={(e) => setKindHint(e.target.value as PartnerKind | "auto")} className="text-base sm:text-[11px] font-semibold bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-slate-600 cursor-pointer">
                  <option value="auto">Để AI đoán</option>
                  {KIND_ORDER.map((k) => (
                    <option key={k} value={k}>{KIND_LABELS[k]}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-[11px] font-bold text-slate-500" title="Áp dụng khi đối tác trong tệp đã có trong danh bạ (cùng MST, hoặc đúng tên)">
                Nếu đã có trong danh bạ
                <select value={dupMode} onChange={(e) => setDupMode(e.target.value as "overwrite" | "add")} className="text-base sm:text-[11px] font-semibold bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-slate-600 cursor-pointer">
                  <option value="overwrite">Chép đè bằng dữ liệu tệp</option>
                  <option value="add">Thêm dòng mới (giữ cả hai)</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400 cursor-pointer" title="Chỉ cần khi tiêu đề cột trong Excel quá khác thường">
                <input type="checkbox" checked={forceAiSheet} onChange={(e) => setForceAiSheet(e.target.checked)} className="w-3.5 h-3.5 accent-[#005BAC]" />
                Excel: ép AI đọc
              </label>
              <div className="ml-auto flex items-center gap-2">
                {running && (
                  <button type="button" onClick={() => (cancelRef.current = true)} className="text-xs sm:text-[11px] font-bold text-slate-500 hover:bg-slate-100 px-3 py-2 rounded-lg cursor-pointer">Dừng</button>
                )}
                <button
                  type="button"
                  onClick={run}
                  disabled={running || !hasInput}
                  className="flex items-center gap-1.5 text-xs sm:text-[11px] font-bold bg-[#005BAC] hover:bg-blue-700 disabled:opacity-50 text-white px-5 py-2.5 sm:py-2 rounded-xl cursor-pointer"
                >
                  {running ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Phân tích bằng AI
                </button>
              </div>
            </div>
            {running && <p className="text-[11px] font-semibold text-slate-500 flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> {progress || "Đang xử lý…"}</p>}
            {msg && <p className="flex items-start gap-1.5 text-[11px] font-semibold text-rose-500"><AlertCircle size={13} className="mt-0.5 shrink-0" /> {msg}</p>}
            {runInfos.length > 0 && (
              <ul className="space-y-1">
                {runInfos.map((e, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-[11px] font-semibold text-sky-700 bg-sky-50 border border-sky-100 rounded-lg px-2.5 py-1.5"><Check size={13} className="mt-0.5 shrink-0" /> {e}</li>
                ))}
              </ul>
            )}
            {runErrs.length > 0 && (
              <ul className="space-y-1">
                {runErrs.map((e, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5"><AlertCircle size={13} className="mt-0.5 shrink-0" /> {e}</li>
                ))}
              </ul>
            )}
          </div>

          {/* ─── Kết quả ─── */}
          {items.length > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <label className="flex items-center gap-2 text-[11px] font-bold text-slate-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={(e) => setItems((p) => p.map((i) => (selectable(i) ? { ...i, selected: e.target.checked } : i)))}
                    className="w-4 h-4 accent-[#005BAC]"
                  />
                  Chọn tất cả
                </label>
                <p className="text-[11px] font-semibold text-slate-400">
                  {stats.total} đối tác
                  {stats.updates > 0 && <span className="text-sky-600"> · {stats.updates} sẽ ghi đè bản đã có</span>}
                  {stats.dups > 0 && <span className="text-amber-600"> · {stats.dups} có thể trùng (vẫn lưu)</span>}
                  {stats.red > 0 && <span className="text-rose-500"> · {stats.red} cờ đỏ MST</span>}
                  {stats.saved > 0 && <span className="text-emerald-600"> · đã lưu {stats.saved}</span>}
                </p>
              </div>

              <ul className="space-y-2">
                {items.map((it) => (
                  <ResultRow
                    key={it.id}
                    it={it}
                    selectable={selectable(it)}
                    onToggle={(v) => patchItem(it.id, { selected: v })}
                    onEdit={() => {
                      const row = it.matchId ? existing.find((r) => r.id === it.matchId) || null : null;
                      onOpenForm(
                        row ? overlayOnRow(row, it.input) : it.input,
                        (savedId) => {
                          if (savedId) patchItem(it.id, { status: "saved", selected: false, error: undefined, action: row ? "updated" : "created" });
                          onChanged();
                        },
                        row
                      );
                    }}
                    onRemove={() => setItems((p) => p.filter((x) => x.id !== it.id))}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>

        {items.length > 0 && (
          <div className="shrink-0 px-4 sm:px-6 py-3 border-t border-slate-100 flex flex-wrap items-center gap-2">
            <p className="text-[11px] text-slate-400 flex-1 min-w-[180px]">AI có thể đọc sai. Hãy soát tên, MST, số điện thoại trước khi lưu — mục thiếu thông tin bắt buộc bấm Sửa để bổ sung.</p>
            <button type="button" onClick={onClose} className="text-xs sm:text-[11px] font-bold text-slate-500 px-4 py-2.5 sm:py-2 rounded-lg hover:bg-slate-100 cursor-pointer">Đóng</button>
            <button
              type="button"
              onClick={saveSelected}
              disabled={saving || selectedItems.length === 0}
              className="flex items-center gap-1.5 bg-[#005BAC] hover:bg-blue-700 disabled:opacity-50 text-white text-xs sm:text-[11px] font-bold px-5 py-2.5 sm:py-2 rounded-lg cursor-pointer"
            >
              {saving && <Loader2 size={13} className="animate-spin" />} Lưu {selectedItems.length} mục đã chọn
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function ResultRow({ it, selectable, onToggle, onEdit, onRemove }: { it: AiItem; selectable: boolean; onToggle: (v: boolean) => void; onEdit: () => void; onRemove: () => void }) {
  const v = it.input;
  const lv = taxLevel(v.tax_status);
  const phones = [v.phone, v.phone2].filter(Boolean).join(" · ");
  const area = [...v.regions.map((r) => REGION_LABELS[r]), ...v.provinces].join(" · ");
  const saved = it.status === "saved";
  return (
    <li className={`rounded-xl border px-3 py-3 flex items-start gap-3 ${saved ? "border-emerald-200 bg-emerald-50/50" : it.dup ? "border-amber-200 bg-amber-50/40" : lv === "red" ? "border-rose-300 bg-white" : "border-slate-100 bg-white"}`}>
      <input
        type="checkbox"
        checked={it.selected}
        disabled={!selectable}
        onChange={(e) => onToggle(e.target.checked)}
        className="mt-1 w-4 h-4 accent-[#005BAC] shrink-0 disabled:opacity-40"
        aria-label={`Chọn ${v.name}`}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="font-heading font-extrabold text-sm text-slate-800 leading-snug">{v.name}</p>
          <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full border bg-slate-50 text-slate-500 border-slate-200">{KIND_LABELS[v.kind]}</span>
          {saved && <span className="flex items-center gap-1 text-[10px] font-extrabold text-emerald-600"><Check size={12} /> {it.action === "updated" ? "Đã cập nhật" : "Đã lưu"}</span>}
          {it.status === "saving" && <Loader2 size={13} className="animate-spin text-[#005BAC]" />}
        </div>
        <p className="text-[11px] font-semibold text-slate-500 break-words">
          {v.tax_code ? `MST ${v.tax_code}` : "Chưa có MST"}
          {(v.contact_name || phones) && " · "}
          {v.contact_name}{v.contact_title && ` (${v.contact_title})`}{phones && ` · ${phones}`}
          {v.email && ` · ${v.email}`}
        </p>
        {(area || v.fields.length > 0) && (
          <p className="text-[11px] text-slate-400 break-words">{[area, v.fields.join(", ")].filter(Boolean).join(" — ")}</p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {it.matchId && !saved && <span className="flex items-center gap-1 text-[11px] font-bold text-sky-700"><Pencil size={12} /> Chép đè lên đối tác đã có: {it.matchName}</span>}
          {it.merged > 0 && <span className="text-[11px] font-semibold text-slate-400">đã gộp {it.merged} dòng trùng trong tệp</span>}
          {it.dup && <span className="flex items-center gap-1 text-[11px] font-bold text-amber-600"><AlertTriangle size={12} /> Có thể trùng: {it.dup} — vẫn lưu được</span>}
          {lv === "red" && <span className="flex items-center gap-1 text-[11px] font-extrabold text-rose-600"><AlertTriangle size={12} /> Cờ đỏ MST — {taxStatusText(v.tax_status)}</span>}
          {lv === "ok" && <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-600"><ShieldCheck size={12} /> MST đang hoạt động{v.tax_checked_at && ` · ${formatCheckedDate(v.tax_checked_at)}`}</span>}
          {lv === "unknown" && v.tax_status && <span className="text-[11px] font-bold text-amber-600">MST: {taxStatusText(v.tax_status)}</span>}
          {it.taxByAi && <span className="text-[11px] font-semibold text-sky-600">MST do AI tìm theo tên + khu vực, đã đối chiếu tên</span>}
          {it.taxNote && <span className="text-[11px] font-semibold text-amber-600">{it.taxNote}</span>}
          {it.tax === "searching" &&<span className="flex items-center gap-1 text-[11px] font-semibold text-slate-400"><Loader2 size={11} className="animate-spin" /> AI đang tìm MST theo tên…</span>}
          {it.tax === "pending" &&<span className="flex items-center gap-1 text-[11px] font-semibold text-slate-400"><Loader2 size={11} className="animate-spin" /> Đang kiểm tra MST…</span>}
          {it.tax === "notfound" && <span className="text-[11px] font-semibold text-slate-400">Nguồn tra cứu không có MST này</span>}
          {it.tax === "error" && <span className="text-[11px] font-semibold text-slate-400">Chưa tra được MST</span>}
          {it.uncertain.length > 0 && (
            <span className="text-[11px] font-semibold text-amber-600">Cần kiểm tra: {it.uncertain.map((k) => FIELD_LABELS[k] || k).join(", ")}</span>
          )}
        </div>
        {it.status === "error" && it.error && (
          <p className="flex items-start gap-1.5 text-[11px] font-semibold text-rose-500"><AlertCircle size={12} className="mt-0.5 shrink-0" /> {it.error}</p>
        )}
        <p className="text-[10px] text-slate-300 font-semibold">Nguồn: {it.source}</p>
      </div>
      {!saved && (
        <div className="shrink-0 flex flex-col sm:flex-row items-center gap-1">
          <button type="button" onClick={onEdit} title="Xem và sửa trong form đầy đủ" className="flex items-center gap-1 text-xs sm:text-[11px] font-bold text-[#005BAC] bg-blue-50 hover:bg-blue-100 px-3 py-2 sm:py-1.5 rounded-lg cursor-pointer"><Pencil size={13} /> Sửa</button>
          <button type="button" onClick={onRemove} title="Bỏ mục này" aria-label="Bỏ mục này" className="p-2 rounded-lg text-slate-300 hover:text-rose-600 hover:bg-rose-50 cursor-pointer"><Trash2 size={14} /></button>
        </div>
      )}
    </li>
  );
}
