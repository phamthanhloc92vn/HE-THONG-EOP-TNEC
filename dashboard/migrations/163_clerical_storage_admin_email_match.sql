-- ============================================================
-- 163 — Sửa quyền xem/tải file Văn thư cho Admin có nhiều email
--
-- LỖI: hàm caller_can_view/manage_documents (migration 024) so khớp
--   allowed_users.email ILIKE auth.email()   -> khớp NGUYÊN CHUỖI.
-- Còn giao diện (lib/emailMatch.ts) tách cột email theo [khoảng trắng , ;]
-- rồi so từng email. Admin có nhiều email trong 1 ô (hoặc có khoảng trắng
-- thừa) thì giao diện vẫn hiện "Admin" nhưng Storage từ chối -> bấm xem /
-- tải file gốc báo "Không mở được tệp này".
--
-- SỬA: dùng đúng cách tách của giao diện. Vẫn khớp TUYỆT ĐỐI từng email
-- (không dùng chuỗi con) nên không cấp nhầm quyền.
-- An toàn chạy lại nhiều lần. Chạy trong Supabase > SQL Editor.
-- ============================================================

create or replace function public.caller_can_view_documents()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from public.allowed_users au
      where au.role = 'Admin'
        and lower(auth.email()) = any (regexp_split_to_array(lower(coalesce(au.email, '')), '[\s,;]+'))
    )
    or exists (
      select 1 from public.approval_permissions p
      where (p.can_view_documents = true or p.can_manage_documents = true)
        and lower(auth.email()) = any (regexp_split_to_array(lower(coalesce(p.email, '')), '[\s,;]+'))
    );
$$;

create or replace function public.caller_can_manage_documents()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from public.allowed_users au
      where au.role = 'Admin'
        and lower(auth.email()) = any (regexp_split_to_array(lower(coalesce(au.email, '')), '[\s,;]+'))
    )
    or exists (
      select 1 from public.approval_permissions p
      where p.can_manage_documents = true
        and lower(auth.email()) = any (regexp_split_to_array(lower(coalesce(p.email, '')), '[\s,;]+'))
    );
$$;

-- Kiểm tra: đăng nhập bằng tài khoản Admin rồi chạy -> phải ra true
-- select public.caller_can_view_documents();
