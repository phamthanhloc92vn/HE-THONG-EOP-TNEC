-- ============================================================
-- 161 — LINK NGOÀI TRÊN SIDEBAR (mục "PDF EDIT 1 CLICK")
--
-- Mỗi dòng = một link ngoài, nhận biết bằng `key` (hiện chỉ có 'pdf_edit').
--
-- QUYỀN:
--   XEM   — mọi tài khoản đã đăng nhập (bấm là mở link ở tab mới).
--   GHI   — Admin hoặc cờ can_manage_news (dùng lại hàm caller_can_manage_news
--           của migration 023, không thêm cờ mới).
--
-- CÁCH CHẠY: Supabase Dashboard > SQL Editor. An toàn chạy lại nhiều lần.
-- ============================================================

create table if not exists public.sidebar_links (
  key        text primary key,
  url        text not null default '',
  updated_by text,
  updated_at timestamptz not null default now()
);

insert into public.sidebar_links (key) values ('pdf_edit')
on conflict (key) do nothing;

alter table public.sidebar_links enable row level security;

-- Xoá sạch policy cũ (không đoán tên) rồi dựng whitelist.
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'sidebar_links'
  loop
    execute format('drop policy if exists %I on public.sidebar_links;', pol.policyname);
  end loop;
end $$;

create policy "sidebar_links select authenticated"
  on public.sidebar_links for select to authenticated
  using (true);

create policy "sidebar_links insert editor"
  on public.sidebar_links for insert to authenticated
  with check (public.caller_can_manage_news());

create policy "sidebar_links update editor"
  on public.sidebar_links for update to authenticated
  using (public.caller_can_manage_news())
  with check (public.caller_can_manage_news());

-- Bảng mới phải tự cấp quyền (Supabase thôi tự grant từ 30/10/2026).
revoke all on public.sidebar_links from anon, public;
grant select, insert, update on public.sidebar_links to authenticated;
grant all on public.sidebar_links to service_role;

-- Kiểm tra: phải ra đúng 3 dòng
select policyname, cmd from pg_policies
where schemaname = 'public' and tablename = 'sidebar_links'
order by cmd;
