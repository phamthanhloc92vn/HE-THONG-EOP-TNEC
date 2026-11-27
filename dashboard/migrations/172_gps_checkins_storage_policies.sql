-- ============================================================
-- 172 — CHÍNH SÁCH KHO ẢNH "gps-checkins" (sửa lỗi chấm công GPS)
--
-- Migration 067 tạo các policy này trong khối DO ... exception -> raise warning,
-- nên khi thiếu quyền nó chỉ cảnh báo rồi BỎ QUA. Kết quả: storage.objects không
-- có policy nào cho bucket gps-checkins, upload ảnh bị chặn với lỗi
-- "new row violates row-level security policy" -> không ai chấm công GPS được.
--
-- File này tạo lại đúng 3 policy như 067, KHÔNG nuốt lỗi: nếu báo lỗi quyền thì
-- tạo tay ở Supabase > Storage > gps-checkins > Policies theo đúng nội dung dưới.
--
-- CÁCH CHẠY: Supabase Dashboard -> SQL Editor -> Run. An toàn chạy lại nhiều lần.
-- ============================================================

drop policy if exists "gps photo insert self" on storage.objects;
drop policy if exists "gps photo select self or hr" on storage.objects;
drop policy if exists "gps photo delete hr" on storage.objects;

-- Ghi ảnh: mọi tài khoản đăng nhập, chỉ vào bucket gps-checkins.
create policy "gps photo insert self" on storage.objects
  for insert to authenticated with check (bucket_id = 'gps-checkins');

-- Xem ảnh: chính chủ HOẶC Admin HOẶC người có cờ xem bảng công (HR).
create policy "gps photo select self or hr" on storage.objects
  for select to authenticated using (
    bucket_id = 'gps-checkins' and (
      owner = auth.uid()
      or exists (select 1 from public.allowed_users au where au.role = 'Admin' and au.email ilike auth.email())
      or exists (select 1 from public.approval_permissions ap
                 where ap.can_view_attendance_imports = true and ap.email ilike '%' || auth.email() || '%')));

-- Xoá ảnh: chỉ HR (Admin hoặc cờ xem bảng công).
create policy "gps photo delete hr" on storage.objects
  for delete to authenticated using (
    bucket_id = 'gps-checkins' and (
      exists (select 1 from public.allowed_users au where au.role = 'Admin' and au.email ilike auth.email())
      or exists (select 1 from public.approval_permissions ap
                 where ap.can_view_attendance_imports = true and ap.email ilike '%' || auth.email() || '%')));

-- KIỂM TRA: mong đợi 3 dòng.
select policyname, cmd from pg_policies
where schemaname = 'storage' and tablename = 'objects' and policyname like 'gps photo%';
