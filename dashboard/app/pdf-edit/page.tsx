"use client";

// ============================================================
// /pdf-edit — trang cấu hình link mục "PDF EDIT 1 CLICK".
// Chỉ Admin / cờ can_manage_news được đưa vào trang này từ sidebar (người khác
// bấm mục là mở thẳng link ở tab mới). Ai lạc vào đây mà không có quyền thì
// chỉ thấy nút mở link.
// ============================================================

import { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import Header from "@/components/Header";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { usePdfEditLink } from "@/lib/pdfEditLink";
import { FilePen, ExternalLink, Loader2 } from "lucide-react";

export default function PdfEditPage() {
  const user = useCurrentUser();
  const canManage = user.isAdmin || user.perms.canManageNews;
  const { url, loading, save } = usePdfEditLink();

  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setDraft(url), [url]);

  const onSave = async () => {
    setSaving(true);
    setMsg(null);
    const ok = await save(draft.trim());
    setSaving(false);
    setMsg(ok ? { ok: true, text: "Đã lưu link." } : { ok: false, text: "Không lưu được link (thiếu quyền hoặc chưa chạy migration 161)." });
  };

  return (
    <div className="flex min-h-screen bg-[#F7F9FC] relative">
      <Sidebar />
      <div className="ml-60 flex-1 flex flex-col min-w-0">
        <Header title="PDF EDIT 1 CLICK" />

        <main className="flex-1 p-8 space-y-6 overflow-y-auto">
          <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-4 border border-slate-200/60 rounded-2xl shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#005BAC] to-[#00AEEF] flex items-center justify-center text-white">
                <FilePen size={18} />
              </div>
              <p className="text-sm font-black text-slate-800">PDF EDIT 1 CLICK</p>
            </div>
            <a
              href={url || "#"}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => !url && e.preventDefault()}
              className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold text-white bg-gradient-to-r from-[#005BAC] to-[#00AEEF] rounded-xl shadow-md shadow-blue-500/20 hover:shadow-lg transition-all active:scale-[0.99] ${url ? "cursor-pointer" : "opacity-50 cursor-not-allowed"}`}
            >
              <ExternalLink size={14} />
              Mở PDF EDIT
            </a>
          </div>

          {canManage && (
            <div className="bg-white p-6 border border-slate-200/60 rounded-2xl shadow-sm space-y-3">
              <label className="block text-xs font-bold text-slate-600">Link ngoài</label>
              {loading ? (
                <Loader2 className="animate-spin text-[#005BAC]" size={20} />
              ) : (
                <div className="flex flex-wrap gap-2">
                  <input
                    type="url"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="https://..."
                    className="flex-1 min-w-[260px] px-4 py-2.5 text-xs border border-slate-200 rounded-xl focus:outline-none focus:border-[#00AEEF]"
                  />
                  <button
                    onClick={onSave}
                    disabled={saving || draft.trim() === url}
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold text-white bg-gradient-to-r from-[#005BAC] to-[#00AEEF] rounded-xl shadow-md shadow-blue-500/20 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                  >
                    {saving && <Loader2 className="animate-spin" size={14} />}
                    Lưu
                  </button>
                </div>
              )}
              {msg && (
                <p className={`text-xs font-semibold ${msg.ok ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</p>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
