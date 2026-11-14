-- ============================================================
-- 168 — PHỤ CẤP TRONG CÀI ĐẶT CHUNG BẢNG LƯƠNG
--
-- YÊU CẦU (user chốt 14/11/2026):
--   * Tiền ăn = đơn giá/ngày (35.000) × số ngày ĐI LÀM thực tế (có mặt VP, gồm OL;
--     không tính phép, lễ, công tác).
--   * Xăng + điện thoại: mức CỐ ĐỊNH theo 3 cấp, không xét ngày công.
--     Cấp xếp tự động theo Chức vụ trong hồ sơ (hàm getEmployeeLevel dùng chung Phúc lợi):
--       senior = Điều hành cao cấp + Quản lý cấp cao (GĐ, PGĐ...)
--       mid    = Quản lý cấp trung (TP, PP, GĐ BĐH, CHT...)
--       staff  = còn lại (CBNV, Tổ trưởng, CHP...)
--   * Cấu hình 1 chỗ ở tab "Bảng lương & BHXH > Cài đặt chung". Tab cũ
--     "Chấm công > Phụ cấp cơm, xăng, dt..." (allowance_policies, 041) ẩn đi.
--
-- Mặc định = mức đang áp dụng (cơm 35.000/ngày, xăng & ĐT 100.000) — HCNS sửa theo cấp.
--
-- CÁCH CHẠY: Supabase Dashboard -> SQL Editor. An toàn chạy lại nhiều lần.
-- YÊU CẦU: đã chạy 167.
-- ============================================================

alter table public.payroll_settings add column if not exists lunch_per_day numeric not null default 35000;
alter table public.payroll_settings add column if not exists fuel_senior   numeric not null default 100000;
alter table public.payroll_settings add column if not exists phone_senior  numeric not null default 100000;
alter table public.payroll_settings add column if not exists fuel_mid      numeric not null default 100000;
alter table public.payroll_settings add column if not exists phone_mid     numeric not null default 100000;
alter table public.payroll_settings add column if not exists fuel_staff    numeric not null default 100000;
alter table public.payroll_settings add column if not exists phone_staff   numeric not null default 100000;

-- ─── KIỂM TRA ───
select lunch_per_day, fuel_senior, phone_senior, fuel_mid, phone_mid, fuel_staff, phone_staff
from public.payroll_settings where id = 1;
