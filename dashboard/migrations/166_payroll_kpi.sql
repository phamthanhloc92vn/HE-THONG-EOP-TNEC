-- ============================================================
-- 166 — LƯƠNG THEO KPI (phòng hưởng hoa hồng: Kinh doanh...)
--
-- YÊU CẦU (user chốt 13/11/2026):
--   * Phòng nào hưởng KPI do HCNS chọn (danh sách phòng ban).
--   * Mức đạt theo doanh số / chỉ tiêu (tiền):
--       Vượt     : doanh số > chỉ tiêu
--       Đạt      : 90% ≤ doanh số ≤ 100% chỉ tiêu
--       Chưa đạt : < 90%
--   * Thưởng KPI = hệ số mức đạt × Lương CB (HĐ) + 20% phần doanh số vượt.
--     Không chia theo ngày công. THAY cho Thưởng HQCV của người thuộc phòng KPI.
--   * Hệ số / tỷ lệ / ngưỡng sửa được trên giao diện (bảng tra kiểu VLOOKUP).
--
-- THÊM GÌ:
--   payroll_kpi_config   1 dòng duy nhất (id = 1): phòng KPI + hệ số + tỷ lệ.
--   payroll_kpi_entries  chỉ tiêu + doanh số đạt theo (tháng, mã NV).
--
-- QUYỀN: y hệt contracts / payroll_slips — Admin hoặc can_view_salary_caller().
--
-- CÁCH CHẠY: Supabase Dashboard -> SQL Editor. An toàn chạy lại nhiều lần.
-- YÊU CẦU: đã chạy 018 (hàm is_admin_caller, can_view_salary_caller).
-- ============================================================

create table if not exists public.payroll_kpi_config (
  id              int primary key default 1 check (id = 1),
  departments     text[]  not null default '{}',
  coef_over       numeric not null default 1.8,
  coef_meet       numeric not null default 1.0,
  coef_under      numeric not null default 0.5,
  over_rate       numeric not null default 0.2,   -- thưởng % phần doanh số vượt
  meet_threshold  numeric not null default 0.9,   -- từ 90% chỉ tiêu là Đạt
  updated_at      timestamptz not null default now(),
  updated_by      text
);
insert into public.payroll_kpi_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.payroll_kpi_entries (
  month          text not null,                   -- 'MM/YYYY'
  employee_code  text not null,
  employee_name  text not null,
  department     text,
  target         numeric not null default 0,      -- chỉ tiêu KPI (VNĐ)
  actual         numeric not null default 0,      -- doanh số đạt (VNĐ)
  updated_at     timestamptz not null default now(),
  primary key (month, employee_code)
);

do $$
declare t text;
begin
  foreach t in array array['payroll_kpi_config', 'payroll_kpi_entries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s salary team" on public.%I', t, t);
    execute format(
      'create policy "%s salary team" on public.%I for all to authenticated
         using (public.is_admin_caller() or public.can_view_salary_caller())
         with check (public.is_admin_caller() or public.can_view_salary_caller())', t, t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke all on public.%I from public', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- ─── KIỂM TRA ───
-- Phải thấy 2 policy "... salary team" và 1 dòng cấu hình mặc định.
select tablename, policyname, cmd from pg_policies
where schemaname = 'public' and tablename in ('payroll_kpi_config', 'payroll_kpi_entries');
select * from public.payroll_kpi_config;
