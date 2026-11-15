-- ============================================================
-- 105 — QUẢN TRỊ DỰ ÁN: PHIẾU BÁO CÁO NGÀY (theo mẫu công ty)
--
-- User chốt 24/09/2026: mẫu "BÁO CÁO NGÀY" của công ty có nhiều thông tin tính
-- theo CẢ NGÀY, không gắn vào từng dòng nhật ký sản lượng:
--   • Thời tiết sáng / chiều, hình thức thi công / quản lý.
--   • Theo TỪNG ĐƠN VỊ (Lodeza EOP + thầu phụ chính danh + thầu phụ Lodeza EOP): phạm vi
--     công việc, nhân sự theo chức danh, máy theo loại, việc hôm nay / ngày mai,
--     ảnh hiện trường.
--   • Vướng mắc, kiến nghị, người lập báo cáo.
-- → 1 phiếu / dự án / ngày. KHÔNG qua duyệt (user chốt): ai được nhập nhật ký là
--   lưu được. Khối lượng "hôm nay" vẫn lấy từ nhật ký ĐÃ DUYỆT, không nhập ở đây.
--
-- units (jsonb) = mảng các đơn vị:
--   [{ key, name, group: 'TNEC'|'NOMINAL'|'NON_NOMINAL', scope,
--      manpower: {CHT: 1, ...}, equipment: {"Máy đào": 3, ...},
--      today, tomorrow, photos: [{path, name}] }]
-- Ảnh dùng chung kho `pc-log-photos` (migration 099), đường dẫn "<project_id>/...".
--
-- CÁCH CHẠY: Supabase Dashboard > SQL Editor > dán cả file > Run. Chạy lại được.
-- ============================================================

create table if not exists public.pc_daily_reports (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.pc_projects(id) on delete cascade,
  report_date    date not null,
  weather_am     text,
  weather_pm     text,
  method         text,                              -- hình thức thi công / quản lý
  units          jsonb not null default '[]'::jsonb,
  issues         text,                              -- vướng mắc
  proposals      text,                              -- kiến nghị
  reporter_name  text,
  reporter_title text,
  created_by     text,
  updated_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (project_id, report_date)
);

create or replace function public.pc_daily_report_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if jsonb_typeof(new.units) is distinct from 'array' then
    raise exception 'units phải là mảng';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := public.caller_email();
  else
    new.created_by := old.created_by;   -- không cho đổi người lập
    new.project_id := old.project_id;
  end if;
  new.updated_by := public.caller_email();
  return new;
end;
$$;

drop trigger if exists trg_pc_daily_reports_guard on public.pc_daily_reports;
create trigger trg_pc_daily_reports_guard
  before insert or update on public.pc_daily_reports
  for each row execute function public.pc_daily_report_guard();

drop trigger if exists trg_pc_daily_reports_touch on public.pc_daily_reports;
create trigger trg_pc_daily_reports_touch before update on public.pc_daily_reports
  for each row execute function public.pc_touch_updated_at();
drop trigger if exists trg_pc_daily_reports_audit on public.pc_daily_reports;
create trigger trg_pc_daily_reports_audit after insert or update or delete on public.pc_daily_reports
  for each row execute function public.pc_audit_trigger();

-- ─── RLS: xoá sạch policy cũ rồi đặt lại ───
alter table public.pc_daily_reports enable row level security;
revoke all on public.pc_daily_reports from anon, public;
grant select, insert, update, delete on public.pc_daily_reports to authenticated;

do $$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'pc_daily_reports' loop
    execute format('drop policy if exists %I on public.pc_daily_reports', pol.policyname);
  end loop;
end $$;

create policy pc_daily_select on public.pc_daily_reports for select to authenticated
  using (public.pc_can_view_project(project_id));
create policy pc_daily_insert on public.pc_daily_reports for insert to authenticated
  with check (public.pc_can_log(project_id));
create policy pc_daily_update on public.pc_daily_reports for update to authenticated
  using (public.pc_can_log(project_id)) with check (public.pc_can_log(project_id));
create policy pc_daily_delete on public.pc_daily_reports for delete to authenticated
  using (public.pc_can_approve_log(project_id) or lower(created_by) = public.caller_email());

-- ─── KIỂM TRA ───
select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'pc_daily_reports' order by policyname;
