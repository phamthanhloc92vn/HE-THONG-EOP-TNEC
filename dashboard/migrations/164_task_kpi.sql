-- ============================================================
-- 164 — KPI CÔNG VIỆC: MỐC NỘP DUYỆT, TASK TỔNG / TASK CON, CỜ HOÃN, NGÀY LỄ
--
-- YÊU CẦU (user chốt 11/11/2026):
--   * KPI chấm theo NGƯỜI LÀM, theo ngày làm việc (bỏ T7, CN, lễ).
--   * Mốc "hoàn thành" = lúc người làm chuyển thẻ sang "Chờ phê duyệt" (lần ĐẦU),
--     không phải lúc quản lý duyệt. Bị trả về chỉnh sửa rồi nộp lại vẫn giữ mốc đầu.
--   * Task tổng gồm nhiều task con; mỗi task con có trọng số % do người giao nhập.
--   * Task bị hoãn/huỷ do bên ngoài -> không tính KPI (cờ do cấp quản lý bật).
--
-- THÊM GÌ:
--   tasks.submitted_at    mốc nộp duyệt đầu tiên — CHỈ trigger ghi, client không sửa.
--   tasks.parent_id       task con trỏ về task tổng (xoá task tổng -> task con thành task thường).
--   tasks.kpi_weight      trọng số % của task con trong task tổng.
--   tasks.kpi_hold        true = không tính vào KPI (hoãn / huỷ, không lỗi người làm).
--   tasks.kpi_hold_reason lý do hoãn.
--   tasks.is_group        true = task tổng (không chấm KPI, chỉ theo dõi tiến độ).
--   bảng kpi_holidays     ngày lễ — Admin sửa, mọi người đọc.
--
-- TASK CŨ: bảng `tasks` không có cột lịch sử nào cho biết thẻ vào "Chờ phê duyệt"
-- lúc nào, nên KHÔNG backfill (đoán sai còn tệ hơn để trống). Task đã hoàn thành
-- trước migration này có submitted_at = null; trang KPI đếm riêng là "chưa có mốc"
-- và không đưa vào tỷ lệ.
--
-- KHÔNG đụng policy nào của `tasks`: trang KPI đọc `tasks` qua RLS sẵn có
-- (migration 045) nên phạm vi xem KPI tự khớp phạm vi xem Kanban.
--
-- CÁCH CHẠY: Supabase Dashboard -> SQL Editor. An toàn chạy lại nhiều lần.
-- ============================================================

-- ─── 1. Cột mới trên tasks ───
alter table public.tasks add column if not exists submitted_at    timestamptz;
-- on delete SET NULL, không cascade: xoá nhầm task tổng không được kéo theo xoá
-- việc (và tiến độ, tệp) của người khác. Task con mồ côi thành task thường.
alter table public.tasks add column if not exists parent_id       uuid references public.tasks(id) on delete set null;
alter table public.tasks add column if not exists kpi_weight      numeric(5,2);
alter table public.tasks add column if not exists kpi_hold        boolean not null default false;
alter table public.tasks add column if not exists kpi_hold_reason text;
-- Đánh dấu TASK TỔNG. Cần cờ riêng chứ không suy từ "có task con không": người
-- phụ trách task tổng có thể không xem được task con của người khác (RLS), khi
-- đó task tổng sẽ bị chấm nhầm như task thường.
alter table public.tasks add column if not exists is_group        boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_kpi_weight_range') then
    alter table public.tasks add constraint tasks_kpi_weight_range
      check (kpi_weight is null or (kpi_weight > 0 and kpi_weight <= 100));
  end if;
end $$;

create index if not exists idx_tasks_parent_id on public.tasks (parent_id);

-- ─── 2. Trigger: ghi mốc nộp + khoá các cột KPI ───
-- auth.uid() null = chạy từ SQL Editor / service role (server) -> tin tưởng, để
-- Admin sửa tay được khi cần. Mọi lời gọi từ trình duyệt đều có auth.uid().
create or replace function public.guard_task_kpi()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  from_browser boolean := auth.uid() is not null;
begin
  -- (a) submitted_at: client không tự đặt / sửa được.
  if from_browser then
    if tg_op = 'INSERT' then
      new.submitted_at := null;
    else
      new.submitted_at := old.submitted_at;
    end if;
  end if;

  -- Lần ĐẦU vào "Chờ phê duyệt" (hoặc quản lý kéo thẳng sang "Đã hoàn thành",
  -- hoặc nhân viên đưa sang "Update thông tin" = xong phần mình, dự án theo dõi
  -- tiếp) thì đóng dấu. Đã có dấu thì giữ nguyên.
  if new.submitted_at is null and new.status in ('pending_approval', 'completed', 'tracking') then
    new.submitted_at := now();
  end if;

  -- (b) Cờ hoãn: chỉ cấp quản lý bật/tắt.
  if from_browser and not public.caller_can_manage_tasks() then
    if tg_op = 'INSERT' then
      new.kpi_hold := false;
      new.kpi_hold_reason := null;
    elsif new.kpi_hold is distinct from old.kpi_hold
       or new.kpi_hold_reason is distinct from old.kpi_hold_reason then
      raise exception 'Chỉ cấp quản lý mới được đánh dấu tạm hoãn / huỷ tính KPI.'
        using errcode = 'check_violation';
    end if;

    -- (c) Trọng số & task tổng đã ấn định thì nhân viên không tự đổi.
    if tg_op = 'UPDATE' and (
         (old.kpi_weight is not null and new.kpi_weight is distinct from old.kpi_weight)
      or (old.parent_id  is not null and new.parent_id  is distinct from old.parent_id)
      or new.is_group is distinct from old.is_group
    ) then
      raise exception 'Trọng số / task tổng đã ấn định. Chỉ cấp quản lý mới sửa được.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_task_kpi on public.tasks;
create trigger trg_guard_task_kpi
  before insert or update on public.tasks
  for each row
  execute function public.guard_task_kpi();

-- ─── 3. Ngày lễ ───
create table if not exists public.kpi_holidays (
  day  date primary key,
  name text not null default ''
);

alter table public.kpi_holidays enable row level security;

do $$
declare p record;
begin
  for p in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'kpi_holidays'
  loop
    execute format('drop policy %I on public.kpi_holidays', p.policyname);
  end loop;
end $$;

create policy "authenticated_read_kpi_holidays" on public.kpi_holidays
  for select to authenticated using (true);

create policy "admin_write_kpi_holidays" on public.kpi_holidays
  for all to authenticated
  using (exists (
    select 1 from public.allowed_users au
    where lower(au.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and au.role = 'Admin'
  ))
  with check (exists (
    select 1 from public.allowed_users au
    where lower(au.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and au.role = 'Admin'
  ));

-- Lễ 2026–2027 theo lịch nghỉ phổ biến của khối nhà nước — KIỂM TRA LẠI theo
-- thông báo nghỉ thực tế của công ty (đặc biệt Tết âm lịch và ngày nghỉ bù).
insert into public.kpi_holidays (day, name) values
  ('2026-01-01', 'Tết Dương lịch'),
  ('2026-02-16', 'Tết Nguyên đán'), ('2026-02-17', 'Tết Nguyên đán'),
  ('2026-02-18', 'Tết Nguyên đán'), ('2026-02-19', 'Tết Nguyên đán'),
  ('2026-02-20', 'Tết Nguyên đán'),
  ('2026-04-27', 'Giỗ Tổ Hùng Vương'),
  ('2026-04-30', 'Giải phóng miền Nam'), ('2026-05-01', 'Quốc tế Lao động'),
  ('2026-09-01', 'Quốc khánh'), ('2026-09-02', 'Quốc khánh'),
  ('2027-01-01', 'Tết Dương lịch'),
  ('2027-02-05', 'Tết Nguyên đán'), ('2027-02-08', 'Tết Nguyên đán'),
  ('2027-02-09', 'Tết Nguyên đán'), ('2027-02-10', 'Tết Nguyên đán'),
  ('2027-02-11', 'Tết Nguyên đán'),
  ('2027-04-16', 'Giỗ Tổ Hùng Vương'),
  ('2027-04-30', 'Giải phóng miền Nam'), ('2027-05-03', 'Nghỉ bù Quốc tế Lao động'),
  ('2027-09-02', 'Quốc khánh'), ('2027-09-03', 'Quốc khánh')
on conflict (day) do nothing;

-- ============================================================
-- KIỂM TRA
-- ============================================================
-- 1. Đủ 6 cột mới:
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'tasks'
  and column_name in ('submitted_at', 'parent_id', 'kpi_weight', 'kpi_hold', 'kpi_hold_reason', 'is_group');
-- 2. Trigger đã gắn:
select tgname from pg_trigger where tgname = 'trg_guard_task_kpi';
-- 3. Số ngày lễ:
select count(*) as so_ngay_le from public.kpi_holidays;

-- GỠ (nếu cần quay lại):
-- drop trigger if exists trg_guard_task_kpi on public.tasks;
-- drop function if exists public.guard_task_kpi();
