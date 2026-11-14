-- ============================================================
-- 169 — PHỤ CẤP XĂNG/ĐT: THÊM CẤP "QUẢN LÝ SƠ CẤP"
--
-- YÊU CẦU (user chốt 14/11/2026): 4 cấp phụ cấp thay vì 3:
--   Cấp cao (BLĐ, GĐ, PGĐ) · Quản lý cấp trung (TP/PP) · Quản lý sơ cấp (Tổ trưởng) · Nhân viên
-- Xếp cấp vẫn tự động theo Chức vụ trong hồ sơ (getEmployeeLevel, dùng chung Phúc lợi).
-- Mặc định 100.000 như các cấp khác — HCNS sửa ở Cài đặt chung.
--
-- CÁCH CHẠY: Supabase Dashboard -> SQL Editor. An toàn chạy lại nhiều lần.
-- YÊU CẦU: đã chạy 168.
-- ============================================================

alter table public.payroll_settings add column if not exists fuel_junior  numeric not null default 100000;
alter table public.payroll_settings add column if not exists phone_junior numeric not null default 100000;

select fuel_senior, phone_senior, fuel_mid, phone_mid, fuel_junior, phone_junior, fuel_staff, phone_staff
from public.payroll_settings where id = 1;
