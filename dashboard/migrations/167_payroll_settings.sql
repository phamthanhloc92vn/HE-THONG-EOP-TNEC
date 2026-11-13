-- ============================================================
-- 167 — CÀI ĐẶT CHUNG BẢNG LƯƠNG (thông số theo luật / chính sách)
--
-- YÊU CẦU (user chốt 13/11/2026): các số theo luật (giảm trừ gia cảnh, % bảo
-- hiểm, biểu thuế TNCN, công chuẩn) sửa 1 lần trên giao diện tab
-- "Bảng lương & BHXH > Cài đặt chung", áp cho toàn bộ — không sửa code.
-- Giá trị mặc định = đúng số đang dùng (khớp phiếu lương mẫu T9/2026).
--
-- tax_brackets: mảng [{ "upto": <ngưỡng trên VNĐ hoặc null = không giới hạn>, "rate": <0..1> }]
--
-- QUYỀN: y hệt contracts / payroll_slips — Admin hoặc can_view_salary_caller().
--
-- CÁCH CHẠY: Supabase Dashboard -> SQL Editor. An toàn chạy lại nhiều lần.
-- YÊU CẦU: đã chạy 018 (hàm is_admin_caller, can_view_salary_caller).
-- ============================================================

create table if not exists public.payroll_settings (
  id                      int primary key default 1 check (id = 1),
  standard_workdays       numeric not null default 26,
  self_deduction          numeric not null default 15500000,
  dependent_deduction     numeric not null default 6200000,
  bhxh_rate               numeric not null default 0.08,
  bhyt_rate               numeric not null default 0.015,
  bhtn_rate               numeric not null default 0.01,
  company_insurance_rate  numeric not null default 0.215,
  tax_brackets            jsonb   not null default '[
    {"upto": 10000000,  "rate": 0.05},
    {"upto": 30000000,  "rate": 0.10},
    {"upto": 60000000,  "rate": 0.20},
    {"upto": 100000000, "rate": 0.30},
    {"upto": null,      "rate": 0.35}
  ]'::jsonb,
  updated_at              timestamptz not null default now(),
  updated_by              text
);
insert into public.payroll_settings (id) values (1) on conflict (id) do nothing;

alter table public.payroll_settings enable row level security;
drop policy if exists "payroll_settings salary team" on public.payroll_settings;
create policy "payroll_settings salary team"
  on public.payroll_settings for all to authenticated
  using (public.is_admin_caller() or public.can_view_salary_caller())
  with check (public.is_admin_caller() or public.can_view_salary_caller());

revoke all on public.payroll_settings from anon;
revoke all on public.payroll_settings from public;
grant select, insert, update, delete on public.payroll_settings to authenticated;

-- ─── KIỂM TRA ───
select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'payroll_settings';
select * from public.payroll_settings;
