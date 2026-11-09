-- ============================================================
-- 162_lock_all_accounts.sql
-- Công tắc "Khoá tất cả tài khoản" (trang Danh sách nhân viên, chỉ Admin).
--
-- Bật -> mọi tài khoản không phải Admin bị đăng xuất, màn hình đăng nhập
-- hiện "Hệ thống đang bảo trì". Tắt -> mọi thứ như cũ.
--
-- Khoá này BẮT BUỘC mở cho anon: màn hình đăng nhập chưa có session mà vẫn
-- phải biết đang bảo trì hay không. Không nhạy cảm — chỉ là true/false.
--
-- CÁCH CHẠY: Supabase Dashboard -> SQL Editor -> New query -> dán và Run.
-- ============================================================

-- ─── 1. SEED KHOÁ MỚI (mặc định TẮT) ───
insert into tenant_config (key, value, description) values
  ('lock_all_accounts', 'false', 'Khoá tất cả tài khoản trừ Admin (bảo trì hệ thống)')
on conflict (key) do nothing;

-- ─── 2. MỞ RỘNG POLICY ANON ĐỌC TENANT_CONFIG ───
-- Giữ nguyên danh sách khoá của migration 083, chỉ thêm lock_all_accounts.
drop policy if exists "anon_read_brand_config" on tenant_config;
create policy "anon_read_brand_config" on tenant_config
  for select to anon
  using (key in (
    'company_name', 'company_short', 'system_title', 'system_subtitle',
    'login_subtitle', 'logo_text', 'logo_url',
    'email_sender_name', 'chairman_name', 'site_url',
    'lock_all_accounts'
  ));

-- ─── 3. KIỂM TRA KẾT QUẢ ───
select key, value from tenant_config where key = 'lock_all_accounts';
