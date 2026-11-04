"use client";

// Link ngoài của mục "PDF edit 1 click": bảng sidebar_links, key 'pdf_edit'
// (migration 161). XEM: mọi tài khoản. SỬA: Admin / cờ can_manage_news (RLS).

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export function usePdfEditLink(): { url: string; loading: boolean; save: (u: string) => Promise<boolean> } {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    supabase
      .from("sidebar_links")
      .select("url")
      .eq("key", "pdf_edit")
      .maybeSingle()
      .then(({ data }) => {
        if (!alive) return;
        setUrl(data?.url || "");
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  const save = async (u: string) => {
    const { data: { session } } = await supabase.auth.getSession();
    const { data, error } = await supabase
      .from("sidebar_links")
      .upsert({ key: "pdf_edit", url: u, updated_by: session?.user.email || null, updated_at: new Date().toISOString() })
      .select("url");
    // RLS chặn thì Supabase trả 0 dòng chứ không báo lỗi.
    if (error || !data?.length) return false;
    setUrl(u);
    return true;
  };
  return { url, loading, save };
}
