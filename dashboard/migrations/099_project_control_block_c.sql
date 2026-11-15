-- ============================================================
-- 099 — QUẢN TRỊ DỰ ÁN P3: KHỐI C — SẢN LƯỢNG & TÀI CHÍNH
--
-- Nền: 096 (khung + quyền), 097, 098. Chạy SAU 098.
--
-- Chốt với user 24/09/2026:
--   • Kỳ tháng = dương lịch (1 → cuối tháng); tuần = Thứ Hai → Chủ Nhật (ISO).
--   • Đơn giá B-B' nhập THEO TỪNG HẠNG MỤC (bảng pc_bb_unit_prices), vẫn giữ tổng
--     giá trị HĐ B-B' ở pc_contract_finance.
--   • CHT nhập nhật ký NGÀY; Văn phòng BĐH nhập 1 dòng TỔNG TUẦN ghi vào Chủ Nhật
--     (entry_type = 'WEEK'); QS duyệt thì mới tính vào lũy kế.
--   • Nhật ký kèm ảnh hiện trường, ảnh ≤ 2MB, kho riêng tư `pc-log-photos`.
--
-- NGUYÊN TẮC "MỘT NGUỒN SỰ THẬT": KHÔNG nhập tay số lũy kế. Mọi lũy kế tính từ
-- pc_progress_logs (APPROVED) + đơn giá. Bảng nhật ký KHÔNG chứa tiền (CHT, kỹ sư
-- đều đọc được); giá trị tính qua VIEW security_invoker, người không có quyền
-- tài chính nhận giá trị NULL vì RLS bảng đơn giá chặn.
--
-- CÁCH CHẠY: Supabase Dashboard > SQL Editor > dán cả file > Run. Chạy lại được.
-- ============================================================

-- ─── 1. HÀM QUYỀN NHẬT KÝ ───
-- Được NHẬP nhật ký: BLĐ, GĐDA, CHT, QS, Văn phòng BĐH.
create or replace function public.pc_can_log(p_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.pc_is_leadership()
      or public.pc_has_role(p_project, array['GDDA','CHT','QS','VP_BDH']);
$$;

-- Được DUYỆT nhật ký: BLĐ, GĐDA, QS.
create or replace function public.pc_can_approve_log(p_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.pc_is_leadership()
      or public.pc_has_role(p_project, array['GDDA','QS']);
$$;

-- ─── 2. ĐƠN GIÁ B-B' THEO HẠNG MỤC (tiền) ───
create table if not exists public.pc_bb_unit_prices (
  id              uuid primary key default gen_random_uuid(),
  contract_id     uuid not null references public.pc_contracts(id) on delete cascade,
  segment_wbs_id  uuid not null references public.pc_segment_wbs(id) on delete cascade,
  unit_price      bigint not null,
  updated_at      timestamptz not null default now(),
  unique (contract_id, segment_wbs_id)
);

-- ─── 3. NHẬT KÝ SẢN LƯỢNG (không chứa tiền) ───
create table if not exists public.pc_progress_logs (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.pc_projects(id) on delete cascade,
  segment_wbs_id   uuid not null references public.pc_segment_wbs(id) on delete cascade,
  contract_id      uuid references public.pc_contracts(id) on delete set null, -- nhà thầu B-B' thực hiện
  log_date         date not null,
  entry_type       text not null default 'DAY' check (entry_type in ('DAY','WEEK')),
  qty              numeric(16,3) not null check (qty >= 0),
  weather          text,
  manpower         integer,
  equipment_count  integer,
  note             text,
  photos           jsonb not null default '[]'::jsonb,   -- [{path, name}]
  status           text not null default 'DRAFT'
                   check (status in ('DRAFT','SUBMITTED','APPROVED','REJECTED')),
  reject_reason    text,
  created_by       text,
  submitted_at     timestamptz,
  approved_by      text,
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_pc_logs_project_date on public.pc_progress_logs (project_id, log_date);
create index if not exists idx_pc_logs_sw on public.pc_progress_logs (segment_wbs_id);

-- segment_wbs phải thuộc đúng dự án; chỉ người duyệt được chuyển APPROVED/REJECTED;
-- dòng đã duyệt chỉ người duyệt sửa được. Ghi dấu người/thời điểm.
create or replace function public.pc_progress_log_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_approver boolean := public.pc_can_approve_log(new.project_id);
begin
  if public.pc_segment_wbs_project(new.segment_wbs_id) is distinct from new.project_id then
    raise exception 'Hạng mục không thuộc dự án này';
  end if;
  if new.contract_id is not null and public.pc_contract_project(new.contract_id) is distinct from new.project_id then
    raise exception 'Hợp đồng không thuộc dự án này';
  end if;

  if tg_op = 'INSERT' then
    new.created_by := public.caller_email();  -- luôn là người đăng nhập, không tin giá trị gửi lên
    if new.status in ('APPROVED','REJECTED') and not v_is_approver then
      raise exception 'Chỉ QS / GĐDA / Ban lãnh đạo được duyệt nhật ký';
    end if;
  else
    if old.status = 'APPROVED' and not v_is_approver then
      raise exception 'Nhật ký đã duyệt — chỉ QS / GĐDA / Ban lãnh đạo được sửa';
    end if;
    if new.status is distinct from old.status and new.status in ('APPROVED','REJECTED') and not v_is_approver then
      raise exception 'Chỉ QS / GĐDA / Ban lãnh đạo được duyệt nhật ký';
    end if;
    new.created_by := old.created_by;  -- không cho đổi người lập
  end if;

  if new.status = 'SUBMITTED' and (tg_op = 'INSERT' or old.status is distinct from 'SUBMITTED') then
    new.submitted_at := now();
  end if;
  if new.status in ('APPROVED','REJECTED') and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    new.approved_by := public.caller_email();
    new.approved_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pc_progress_logs_guard on public.pc_progress_logs;
create trigger trg_pc_progress_logs_guard
  before insert or update on public.pc_progress_logs
  for each row execute function public.pc_progress_log_guard();

-- ─── 4. KẾ HOẠCH SẢN LƯỢNG / GIẢI NGÂN THEO THÁNG (tiền) ───
-- segment_id null = dòng cấp dự án (dùng cho KH giải ngân).
-- version 0 = baseline; điều chỉnh 1, 2… là version tăng dần; bản mới nhất là bản hiện hành.
create table if not exists public.pc_plan_entries (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.pc_projects(id) on delete cascade,
  segment_id            uuid references public.pc_segments(id) on delete cascade,
  period_month          date not null check (extract(day from period_month) = 1),
  planned_value         bigint,        -- KH sản lượng (VNĐ)
  planned_disbursement  bigint,        -- KH giải ngân (VNĐ)
  version               integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index if not exists uq_pc_plan
  on public.pc_plan_entries (project_id, coalesce(segment_id, '00000000-0000-0000-0000-000000000000'::uuid), period_month, version);

-- ─── 5. NGHIỆM THU & THANH TOÁN (tiền) ───
create table if not exists public.pc_acceptances (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.pc_projects(id) on delete cascade,
  contract_id     uuid not null references public.pc_contracts(id) on delete cascade,
  period_no       integer,
  period_from     date,
  period_to       date,
  accepted_value  bigint not null default 0,
  status          text not null default 'DRAFT' check (status in ('DRAFT','SUBMITTED','APPROVED')),
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_pc_acc_contract on public.pc_acceptances (contract_id);

create table if not exists public.pc_payments (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.pc_projects(id) on delete cascade,
  contract_id     uuid not null references public.pc_contracts(id) on delete cascade,
  acceptance_id   uuid references public.pc_acceptances(id) on delete set null,
  payment_type    text not null default 'PROGRESS'
                  check (payment_type in ('ADVANCE','PROGRESS','ADVANCE_RECOVERY','RETENTION','FINAL')),
  direction       text not null check (direction in ('IN','OUT')),  -- IN: CĐT trả Lodeza EOP · OUT: Lodeza EOP trả nhà thầu
  request_date    date,
  request_value   bigint,
  paid_date       date,
  paid_value      bigint,
  status          text not null default 'REQUESTED'
                  check (status in ('REQUESTED','APPROVED','PAID','REJECTED')),
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_pc_pay_contract on public.pc_payments (contract_id);

-- contract_id của nghiệm thu / thanh toán phải thuộc đúng dự án.
create or replace function public.pc_check_contract_project()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.pc_contract_project(new.contract_id) is distinct from new.project_id then
    raise exception 'Hợp đồng không thuộc dự án này';
  end if;
  return new;
end;
$$;

-- ─── 6. TRIGGER chung: kiểm, updated_at, nhật ký thay đổi ───
do $$
declare t text;
begin
  foreach t in array array['pc_acceptances','pc_payments'] loop
    execute format('drop trigger if exists trg_%s_conchk on public.%I', t, t);
    execute format('create trigger trg_%s_conchk before insert or update on public.%I
                      for each row execute function public.pc_check_contract_project()', t, t);
  end loop;

  execute 'drop trigger if exists trg_pc_plan_entries_segchk on public.pc_plan_entries';
  execute 'create trigger trg_pc_plan_entries_segchk before insert or update on public.pc_plan_entries
             for each row execute function public.pc_check_segment_project()';

  foreach t in array array['pc_bb_unit_prices','pc_progress_logs','pc_plan_entries','pc_acceptances','pc_payments'] loop
    execute format('drop trigger if exists trg_%s_touch on public.%I', t, t);
    execute format('create trigger trg_%s_touch before update on public.%I
                      for each row execute function public.pc_touch_updated_at()', t, t);
    execute format('drop trigger if exists trg_%s_audit on public.%I', t, t);
    execute format('create trigger trg_%s_audit after insert or update or delete on public.%I
                      for each row execute function public.pc_audit_trigger()', t, t);
  end loop;
end $$;

-- ─── 7. RLS ───
do $$
declare t text; pol record;
begin
  foreach t in array array['pc_bb_unit_prices','pc_progress_logs','pc_plan_entries','pc_acceptances','pc_payments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy if exists %I on public.%I', pol.policyname, t);
    end loop;
  end loop;
end $$;

create policy pc_bbp_select on public.pc_bb_unit_prices for select to authenticated
  using (public.pc_can_view_finance(public.pc_contract_project(contract_id)));
create policy pc_bbp_write on public.pc_bb_unit_prices for all to authenticated
  using (public.pc_can_edit_finance(public.pc_contract_project(contract_id)))
  with check (public.pc_can_edit_finance(public.pc_contract_project(contract_id)));

create policy pc_logs_select on public.pc_progress_logs for select to authenticated
  using (public.pc_can_view_project(project_id));
create policy pc_logs_insert on public.pc_progress_logs for insert to authenticated
  with check (public.pc_can_log(project_id));
-- Sửa: người lập (khi chưa duyệt — trigger chặn phần còn lại) hoặc người duyệt.
create policy pc_logs_update on public.pc_progress_logs for update to authenticated
  using (public.pc_can_approve_log(project_id)
         or (public.pc_can_log(project_id) and lower(created_by) = public.caller_email()))
  with check (public.pc_can_approve_log(project_id)
         or (public.pc_can_log(project_id) and lower(created_by) = public.caller_email()));
-- Xoá: người duyệt; người lập chỉ xoá được dòng CHƯA duyệt.
create policy pc_logs_delete on public.pc_progress_logs for delete to authenticated
  using (public.pc_can_approve_log(project_id)
         or (status <> 'APPROVED' and lower(created_by) = public.caller_email()));

create policy pc_plan_select on public.pc_plan_entries for select to authenticated
  using (public.pc_can_view_finance(project_id));
create policy pc_plan_write on public.pc_plan_entries for all to authenticated
  using (public.pc_can_edit_finance(project_id)) with check (public.pc_can_edit_finance(project_id));

create policy pc_acc_select on public.pc_acceptances for select to authenticated
  using (public.pc_can_view_finance(project_id));
create policy pc_acc_write on public.pc_acceptances for all to authenticated
  using (public.pc_can_edit_finance(project_id)) with check (public.pc_can_edit_finance(project_id));

create policy pc_pay_select on public.pc_payments for select to authenticated
  using (public.pc_can_view_finance(project_id));
create policy pc_pay_write on public.pc_payments for all to authenticated
  using (public.pc_can_edit_finance(project_id)) with check (public.pc_can_edit_finance(project_id));

-- ─── 8. VIEW GIÁ TRỊ SẢN LƯỢNG (security_invoker -> RLS bảng gốc áp dụng) ───
-- Chỉ dòng APPROVED. value_a = KL × đơn giá A-B; value_b = KL × đơn giá B-B'.
-- Người không có quyền tài chính: join bảng đơn giá bị RLS lọc -> value NULL.
create or replace view public.pc_v_progress_value
with (security_invoker = true) as
select
  l.id,
  l.project_id,
  w.segment_id,
  l.segment_wbs_id,
  w.wbs_item_id,
  l.contract_id,
  l.log_date,
  l.entry_type,
  l.qty,
  round(l.qty * fa.unit_price)::bigint as value_a,
  round(l.qty * fb.unit_price)::bigint as value_b
from public.pc_progress_logs l
join public.pc_segment_wbs w on w.id = l.segment_wbs_id
left join public.pc_segment_wbs_finance fa on fa.segment_wbs_id = l.segment_wbs_id
left join public.pc_bb_unit_prices fb on fb.contract_id = l.contract_id and fb.segment_wbs_id = l.segment_wbs_id
where l.status = 'APPROVED';

-- RLS KHÔNG áp cho view: phải tự thu hồi anon / public rồi mới cấp authenticated.
revoke all on public.pc_v_progress_value from anon, public;
grant select on public.pc_v_progress_value to authenticated;

-- ─── 9. pc_my_access trả thêm can_log / can_approve_log ───
create or replace function public.pc_my_access(p_project uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'can_view',            public.pc_can_view_project(p_project),
    'can_edit_structure',  public.pc_can_edit_structure(p_project),
    'can_edit_site',       public.pc_can_edit_site(p_project),
    'can_log',             public.pc_can_log(p_project),
    'can_approve_log',     public.pc_can_approve_log(p_project),
    'can_view_finance',    public.pc_can_view_finance(p_project),
    'can_edit_finance',    public.pc_can_edit_finance(p_project),
    'can_manage_members',  public.pc_can_manage_members(p_project),
    'is_leadership',       public.pc_is_leadership(),
    'roles', coalesce((
      select jsonb_agg(m.role) from public.pc_project_members m
      where m.project_id = p_project and lower(trim(m.email)) = public.caller_email()
    ), '[]'::jsonb)
  );
$$;

-- Ảnh nằm dưới thư mục "<project_id>/…": ai xem được dự án thì xem được ảnh.
create or replace function public.pc_photo_project(p_name text)
returns uuid language plpgsql stable as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['pc_can_log(uuid)','pc_can_approve_log(uuid)','pc_my_access(uuid)','pc_photo_project(text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ─── 10. KHO ẢNH NHẬT KÝ (riêng tư, 2MB, chỉ ảnh) ───
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('pc-log-photos', 'pc-log-photos', false, 2097152,
          array['image/jpeg','image/png','image/webp','image/heic'])
  on conflict (id) do update set
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
  raise notice 'Bucket pc-log-photos san sang (private, 2MB, anh).';
exception when others then
  raise warning 'KHONG tao duoc bucket (%). Vao Storage > New bucket "pc-log-photos", BO TICK Public, 2MB.', sqlerrm;
end $$;

do $$
begin
  execute 'drop policy if exists "pc log photos select" on storage.objects';
  execute 'drop policy if exists "pc log photos insert" on storage.objects';
  execute 'drop policy if exists "pc log photos delete" on storage.objects';

  execute $p$
    create policy "pc log photos select" on storage.objects for select to authenticated
      using (bucket_id = 'pc-log-photos' and public.pc_can_view_project(public.pc_photo_project(name)))
  $p$;
  execute $p$
    create policy "pc log photos insert" on storage.objects for insert to authenticated
      with check (bucket_id = 'pc-log-photos' and public.pc_can_log(public.pc_photo_project(name)))
  $p$;
  execute $p$
    create policy "pc log photos delete" on storage.objects for delete to authenticated
      using (bucket_id = 'pc-log-photos' and public.pc_can_approve_log(public.pc_photo_project(name)))
  $p$;
  raise notice 'Da dat 3 policy cho pc-log-photos.';
exception when others then
  raise warning 'KHONG dat duoc policy storage (%).', sqlerrm;
end $$;

-- ─── 11. KIỂM TRA ───
select tablename, rowsecurity from pg_tables
where schemaname = 'public'
  and tablename in ('pc_bb_unit_prices','pc_progress_logs','pc_plan_entries','pc_acceptances','pc_payments')
order by tablename;

select id, public, file_size_limit from storage.buckets where id = 'pc-log-photos';
