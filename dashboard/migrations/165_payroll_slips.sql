-- ============================================================
-- 165 — BẢNG LƯƠNG CỨNG: SỐ NGƯỜI PHỤ THUỘC + CHỐT LƯƠNG THÁNG
--
-- YÊU CẦU (user chốt 13/11/2026): tab "Bảng lương & BHXH > Tính lương" lấy ngày
-- công từ bảng công đã nạp + lương/HQCV trong HĐLĐ + định mức phụ cấp, rồi chốt
-- lương tháng và xuất phiếu lương. Công thức ở lib/payroll.ts.
--
-- THÊM GÌ:
--   contracts.dependents   số người phụ thuộc (giảm trừ gia cảnh 6,2tr/người).
--   bảng payroll_slips     1 dòng / (tháng, mã NV): số liệu đã chốt (jsonb) để
--                          phiếu lương không đổi khi HĐ sửa về sau.
--
-- QUYỀN: y hệt contracts (018 + 086) — Admin hoặc can_view_salary_caller().
--
-- CÁCH CHẠY: Supabase Dashboard -> SQL Editor. An toàn chạy lại nhiều lần.
-- YÊU CẦU: đã chạy 018 (hàm is_admin_caller, can_view_salary_caller).
-- ============================================================

alter table public.contracts add column if not exists dependents int not null default 0;

create table if not exists public.payroll_slips (
  month          text not null,             -- 'MM/YYYY', khớp attendance_imports.month
  employee_code  text not null,
  employee_name  text not null,
  department     text,
  data           jsonb not null,            -- đầu vào + kết quả computePayslip
  locked_by      text,
  updated_at     timestamptz not null default now(),
  primary key (month, employee_code)
);

alter table public.payroll_slips enable row level security;

drop policy if exists "payroll_slips salary team" on public.payroll_slips;
create policy "payroll_slips salary team"
  on public.payroll_slips for all to authenticated
  using (public.is_admin_caller() or public.can_view_salary_caller())
  with check (public.is_admin_caller() or public.can_view_salary_caller());

revoke all on public.payroll_slips from anon;
revoke all on public.payroll_slips from public;
grant select, insert, update, delete on public.payroll_slips to authenticated;

-- ─── KIỂM TRA ───
-- Đăng nhập app bằng NHÂN VIÊN THƯỜNG, Console:
--   await supabase.from('payroll_slips').select('*').limit(1)   -> PHẢI 0 dòng
select policyname, cmd from pg_policies
where schemaname = 'public' and tablename = 'payroll_slips';
