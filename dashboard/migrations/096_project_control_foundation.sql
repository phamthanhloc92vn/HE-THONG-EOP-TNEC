-- ============================================================
-- 096 — QUẢN TRỊ DỰ ÁN (Project Control) — P0 NỀN QUYỀN + P1 KHUNG DỰ ÁN
--
-- Đặc tả: "Module Quản trị dự án xây dựng" v0.1 (23/09/2026), dự án mẫu ĐT.769.
-- Chốt với user 24/09/2026:
--   • Dùng nội bộ Lodeza EOP, nằm trong HCNS (menu Quản lý dự án > Thông tin quản trị dự án).
--   • 1 Ban điều hành (departments type='bdh') = 1 dự án. Khoá theo bdh_name,
--     giống project_locations (016).
--   • Nhà thầu DÙNG CHUNG danh mục đối tác của Kế hoạch thu chi (finance_partners,
--     048) — số tài khoản chỉ nhập một nơi.
--   • TIỀN chỉ Ban lãnh đạo + GĐDA + TC-KT xem. Kỹ sư hiện trường thấy nhà thầu
--     nào làm lý trình nào nhưng KHÔNG thấy con số nào.
--
-- TIỀN TỐ pc_ (Project Control). KHÔNG đặt tên "contracts" — tên đó là bảng
-- HĐLĐ có lương (018), trùng là thảm hoạ.
--
-- CÁCH TÁCH TIỀN: RLS chặn theo DÒNG, không chặn theo CỘT. Vì vậy mọi con số tiền
-- nằm ở bảng riêng đuôi `_finance` (hoặc cả bảng là tiền như pc_contract_addenda),
-- đọc/ghi bằng quyền tài chính. Bảng "khung" (lý trình, hạng mục, hợp đồng không
-- kèm giá trị) mở cho mọi người xem được dự án.
--
-- VAI TRÒ TRONG DỰ ÁN (pc_project_members.role):
--   GDDA   Giám đốc dự án      — toàn quyền trong dự án, xem tiền, gán thành viên
--   CHT    Chỉ huy trưởng      — (P3) nhập nhật ký sản lượng ngày
--   QS     Khối lượng – dự toán — sửa lý trình/hạng mục; (P3) duyệt nhật ký
--   VP_BDH Văn phòng BĐH       — sửa lý trình/hạng mục; (P3) nhập theo tuần
--   KY_SU  Kỹ sư hiện trường   — chỉ xem khung, KHÔNG thấy tiền
--   TC_KT  Tài chính – Kế toán của dự án — xem/sửa tiền dự án này
-- CỜ TOÀN CÔNG TY (approval_permissions):
--   can_view_all_projects     Ban lãnh đạo: xem + sửa mọi dự án, kể cả tiền; lập hồ sơ dự án
--   can_view_project_finance  Phòng TC-KT: xem + sửa tiền mọi dự án
--
-- KHỚP EMAIL: TUYỆT ĐỐI theo từng email trong ô (tách dấu phẩy/chấm phẩy/khoảng
-- trắng) — KHÔNG dùng LIKE '%email%' (lỗ hổng chuỗi con đã vá 08/09/2026).
--
-- CÁCH CHẠY: Supabase Dashboard > SQL Editor > dán cả file > Run.
-- An toàn chạy lại nhiều lần.
-- ============================================================

create extension if not exists btree_gist;

-- ─── 1. CỜ QUYỀN ───
alter table public.approval_permissions
  add column if not exists can_view_all_projects boolean not null default false,
  add column if not exists can_view_project_finance boolean not null default false;

-- ─── 2. HÀM NHẬN DIỆN (khớp email tuyệt đối) ───
create or replace function public.caller_email()
returns text
language sql
stable
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

-- Ô email (có thể chứa nhiều địa chỉ) có chứa ĐÚNG email đăng nhập không.
create or replace function public.pc_email_in(p_field text)
returns boolean
language sql
stable
as $$
  select public.caller_email() <> ''
     and public.caller_email() = any (
       regexp_split_to_array(lower(coalesce(p_field, '')), '[\s,;]+')
     );
$$;

create or replace function public.pc_is_leadership()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin_caller() or exists (
    select 1 from public.approval_permissions p
    where p.can_view_all_projects = true and public.pc_email_in(p.email)
  );
$$;

create or replace function public.pc_is_finance_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.approval_permissions p
    where p.can_view_project_finance = true and public.pc_email_in(p.email)
  );
$$;

-- Phòng ban (Ban điều hành) của người đăng nhập, lấy từ danh bạ nhân sự.
create or replace function public.pc_caller_department()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select e.department from public.employees e
  where public.pc_email_in(e.email)
  limit 1;
$$;

-- ─── 3. BẢNG DỰ ÁN ───
create table if not exists public.pc_projects (
  id               uuid primary key default gen_random_uuid(),
  bdh_name         text not null unique,     -- khoá liên kết -> departments.name (type='bdh')
  code             text,                     -- VD: DT769-XL15
  name             text not null,            -- tên dự án đầy đủ
  package_name     text,                     -- gói thầu
  owner_name       text,                     -- Chủ đầu tư
  supervisor_name  text,                     -- Tư vấn giám sát
  location         text,
  start_date       date,                     -- ngày khởi công
  finish_date      date,                     -- ngày hoàn thành theo HĐ
  status           text not null default 'PREPARING'
                   check (status in ('PREPARING','MOBILIZING','EXECUTING','SUSPENDED',
                                     'COMPLETED','SETTLEMENT','WARRANTY','CLOSED')),
  note             text,
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Tiền cấp dự án — tách bảng để kỹ sư không đọc được.
create table if not exists public.pc_project_finance (
  project_id              uuid primary key references public.pc_projects(id) on delete cascade,
  contract_value_pre_vat  bigint,                        -- GT HĐ A-B trước thuế (VNĐ)
  vat_rate                numeric(5,4) not null default 0.08,
  contingency_value       bigint,                        -- chi phí dự phòng
  payment_threshold       bigint not null default 4000000000, -- ngưỡng SL chưa TT B-B' (4 tỷ)
  updated_at              timestamptz not null default now()
);

create table if not exists public.pc_project_members (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.pc_projects(id) on delete cascade,
  email       text not null,
  name        text,
  role        text not null check (role in ('GDDA','CHT','QS','VP_BDH','KY_SU','TC_KT')),
  created_at  timestamptz not null default now(),
  unique (project_id, email, role)
);
create index if not exists idx_pc_members_project on public.pc_project_members (project_id);

-- ─── 4. HÀM QUYỀN THEO DỰ ÁN ───
create or replace function public.pc_has_role(p_project uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.pc_project_members m
    where m.project_id = p_project
      and m.role = any (p_roles)
      and lower(trim(m.email)) = public.caller_email()
  );
$$;

-- XEM dự án: Ban lãnh đạo, TC-KT toàn công ty, thành viên, hoặc nhân sự thuộc đúng BĐH.
create or replace function public.pc_can_view_project(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.pc_is_leadership()
      or public.pc_is_finance_staff()
      or exists (select 1 from public.pc_project_members m
                 where m.project_id = p_project and lower(trim(m.email)) = public.caller_email())
      or exists (select 1 from public.pc_projects p
                 where p.id = p_project and p.bdh_name = public.pc_caller_department());
$$;

-- SỬA thông tin chung + lý trình + hạng mục.
create or replace function public.pc_can_edit_structure(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.pc_is_leadership()
      or public.pc_has_role(p_project, array['GDDA','QS','VP_BDH']);
$$;

-- XEM tiền.
create or replace function public.pc_can_view_finance(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.pc_is_leadership()
      or public.pc_is_finance_staff()
      or public.pc_has_role(p_project, array['GDDA','TC_KT']);
$$;

-- SỬA tiền + hợp đồng.
create or replace function public.pc_can_edit_finance(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.pc_can_view_finance(p_project);
$$;

-- Gán thành viên: Ban lãnh đạo hoặc GĐDA của dự án.
create or replace function public.pc_can_manage_members(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.pc_is_leadership() or public.pc_has_role(p_project, array['GDDA']);
$$;

-- ─── 5. LÝ TRÌNH & HẠNG MỤC ───
create table if not exists public.pc_segments (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.pc_projects(id) on delete cascade,
  code            text not null,                 -- LT01
  km_start_m      numeric(12,2) not null,        -- mét: Km0+880 = 880
  km_end_m        numeric(12,2) not null,
  segment_type    text not null default 'ROAD'
                  check (segment_type in ('ROAD','BRIDGE_APPROACH','BRIDGE','RETAINING_WALL','MIXED')),
  structure_name  text,                          -- Cầu Cái Hảo...
  locality        text,                          -- địa phận
  sides           smallint not null default 2 check (sides in (1, 2)),
  sort_order      integer not null default 0,
  planned_start   date,
  planned_finish  date,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint pc_segments_km_order check (km_end_m > km_start_m),
  constraint pc_segments_code_unique unique (project_id, code),
  -- Không cho 2 lý trình của cùng dự án chồng lên nhau (chạm mép thì được).
  constraint pc_segments_no_overlap exclude using gist (
    project_id with =,
    numrange(km_start_m, km_end_m, '[)') with &&
  )
);
create index if not exists idx_pc_segments_project on public.pc_segments (project_id);

-- Danh mục hạng mục mẫu (dùng chung mọi dự án).
create table if not exists public.pc_wbs_items (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,        -- T-1, K-2, C-3...
  group_code  text not null check (group_code in ('T','K','C')), -- Tuyến / Khác / Cầu
  name        text not null,
  unit        text,
  sort_order  integer not null default 0,
  active      boolean not null default true
);

-- 12 hạng mục theo file gốc ĐT.769 (đặc tả mục 6.2). Chỉ thêm nếu chưa có mã.
insert into public.pc_wbs_items (code, group_code, name, sort_order) values
  ('T-1', 'T', 'Cọc xi măng đất (CDM)', 10),
  ('T-2', 'T', 'Nền đường + HTKT', 20),
  ('T-3', 'T', 'Mặt đường + ATGT + CSCX', 30),
  ('K-1', 'K', 'Tường chắn BTCT', 40),
  ('K-2', 'K', 'Tường chắn có cốt (MSE)', 50),
  ('K-3', 'K', 'Cừ BT DƯL', 60),
  ('K-4', 'K', 'Cọc BTCT vuông', 70),
  ('C-1', 'C', 'Cọc khoan nhồi', 80),
  ('C-2', 'C', 'Bệ – thân – xà mũ', 90),
  ('C-3', 'C', 'Dầm SPT – GC', 100),
  ('C-4', 'C', 'BMC + khe co giãn + liên tục nhiệt', 110),
  ('C-5', 'C', 'Lan can + ATGT + chiếu sáng', 120)
on conflict (code) do nothing;

-- Hạng mục áp cho từng lý trình (không kèm tiền).
create table if not exists public.pc_segment_wbs (
  id              uuid primary key default gen_random_uuid(),
  segment_id      uuid not null references public.pc_segments(id) on delete cascade,
  wbs_item_id     uuid not null references public.pc_wbs_items(id) on delete restrict,
  applicable      boolean not null default true,   -- false = "Không có"
  weight_pct      numeric(6,3) not null default 0 check (weight_pct >= 0 and weight_pct <= 100),
  budget_qty      numeric(16,3),                   -- khối lượng theo HĐ A-B
  unit            text,
  planned_start   date,
  planned_finish  date,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (segment_id, wbs_item_id)
);
create index if not exists idx_pc_segment_wbs_segment on public.pc_segment_wbs (segment_id);

-- Đơn giá / giá trị hạng mục — tiền, tách bảng.
create table if not exists public.pc_segment_wbs_finance (
  segment_wbs_id  uuid primary key references public.pc_segment_wbs(id) on delete cascade,
  unit_price      bigint,
  budget_value    bigint,
  updated_at      timestamptz not null default now()
);

-- ─── 6. HỢP ĐỒNG ───
create table if not exists public.pc_contracts (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.pc_projects(id) on delete cascade,
  contract_type       text not null check (contract_type in ('A_B','B_B1')),
  parent_contract_id  uuid references public.pc_contracts(id) on delete set null,
  partner_id          uuid references public.finance_partners(id) on delete restrict,
  partner_name        text,             -- chụp tên lúc lưu (kỹ sư không đọc được finance_partners)
  legal_status        text check (legal_status in ('NOMINAL','NON_NOMINAL')),
  contractor_role     text check (contractor_role in ('MAIN','SUB')),
  contract_no         text,
  sign_date           date,
  status              text not null default 'NEGOTIATING'
                      check (status in ('NEGOTIATING','SIGNED','LIQUIDATED')),
  note                text,
  created_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_pc_contracts_project on public.pc_contracts (project_id);

create table if not exists public.pc_contract_finance (
  contract_id      uuid primary key references public.pc_contracts(id) on delete cascade,
  value_pre_vat    bigint,
  vat_rate         numeric(5,4) not null default 0.08,
  advance_rate     numeric(5,4),       -- % tạm ứng
  retention_rate   numeric(5,4),       -- % giữ lại bảo hành
  updated_at       timestamptz not null default now()
);

-- Phạm vi HĐ: lý trình × hạng mục (1 nhà thầu nhiều lý trình, 1 lý trình nhiều nhà thầu).
create table if not exists public.pc_contract_scopes (
  id           uuid primary key default gen_random_uuid(),
  contract_id  uuid not null references public.pc_contracts(id) on delete cascade,
  segment_id   uuid not null references public.pc_segments(id) on delete cascade,
  wbs_item_id  uuid references public.pc_wbs_items(id) on delete restrict, -- null = cả lý trình
  scope_desc   text,                  -- "Tuyến + HTKT", "Cây xanh, ATGT, chiếu sáng"...
  created_at   timestamptz not null default now()
);
create index if not exists idx_pc_scopes_contract on public.pc_contract_scopes (contract_id);
create index if not exists idx_pc_scopes_segment on public.pc_contract_scopes (segment_id);

create table if not exists public.pc_contract_scope_finance (
  scope_id    uuid primary key references public.pc_contract_scopes(id) on delete cascade,
  value       bigint,
  updated_at  timestamptz not null default now()
);

-- Phụ lục / phát sinh — cả bảng là tiền.
create table if not exists public.pc_contract_addenda (
  id            uuid primary key default gen_random_uuid(),
  contract_id   uuid not null references public.pc_contracts(id) on delete cascade,
  addendum_no   text,
  sign_date     date,
  value_change  bigint not null default 0,   -- +/- giá trị
  reason        text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_pc_addenda_contract on public.pc_contract_addenda (contract_id);

-- ─── 7. HÀM TRA DỰ ÁN TỪ BẢNG CON (cho RLS) ───
create or replace function public.pc_segment_project(p_segment uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select project_id from public.pc_segments where id = p_segment;
$$;

create or replace function public.pc_segment_wbs_project(p_sw uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select s.project_id from public.pc_segment_wbs w
  join public.pc_segments s on s.id = w.segment_id
  where w.id = p_sw;
$$;

create or replace function public.pc_contract_project(p_contract uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select project_id from public.pc_contracts where id = p_contract;
$$;

create or replace function public.pc_scope_project(p_scope uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select c.project_id from public.pc_contract_scopes s
  join public.pc_contracts c on c.id = s.contract_id
  where s.id = p_scope;
$$;

-- ─── 8. NHẬT KÝ THAY ĐỔI ───
create table if not exists public.pc_audit_log (
  id          bigint generated always as identity primary key,
  project_id  uuid,
  table_name  text not null,
  row_id      text,
  action      text not null,          -- INSERT / UPDATE / DELETE
  old_data    jsonb,
  new_data    jsonb,
  changed_by  text,
  changed_at  timestamptz not null default now()
);
create index if not exists idx_pc_audit_project on public.pc_audit_log (project_id, changed_at desc);

create or replace function public.pc_audit_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r        jsonb;
  v_proj   uuid;
  v_rowid  text;
begin
  r := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;

  -- Suy ra dự án từ cột khoá có trong dòng. Dòng cha đã bị xoá dây chuyền thì để null.
  if tg_table_name = 'pc_projects' then
    v_proj := (r ->> 'id')::uuid;
  elsif r ? 'project_id' then
    v_proj := (r ->> 'project_id')::uuid;
  elsif r ? 'segment_wbs_id' then
    v_proj := public.pc_segment_wbs_project((r ->> 'segment_wbs_id')::uuid);
  elsif r ? 'scope_id' then
    v_proj := public.pc_scope_project((r ->> 'scope_id')::uuid);
  elsif r ? 'contract_id' then
    v_proj := public.pc_contract_project((r ->> 'contract_id')::uuid);
  elsif r ? 'segment_id' then
    v_proj := public.pc_segment_project((r ->> 'segment_id')::uuid);
  end if;

  v_rowid := coalesce(r ->> 'id', r ->> 'project_id', r ->> 'segment_wbs_id',
                      r ->> 'contract_id', r ->> 'scope_id');

  insert into public.pc_audit_log (project_id, table_name, row_id, action, old_data, new_data, changed_by)
  values (
    v_proj, tg_table_name, v_rowid, tg_op,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end,
    public.caller_email()
  );
  return null;
end;
$$;

create or replace function public.pc_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'pc_projects','pc_project_finance','pc_project_members','pc_segments',
    'pc_segment_wbs','pc_segment_wbs_finance','pc_contracts','pc_contract_finance',
    'pc_contract_scopes','pc_contract_scope_finance','pc_contract_addenda'
  ] loop
    execute format('drop trigger if exists trg_%s_audit on public.%I', t, t);
    execute format(
      'create trigger trg_%s_audit after insert or update or delete on public.%I
         for each row execute function public.pc_audit_trigger()', t, t);
  end loop;

  foreach t in array array[
    'pc_projects','pc_project_finance','pc_segments','pc_segment_wbs',
    'pc_segment_wbs_finance','pc_contracts','pc_contract_finance','pc_contract_scope_finance'
  ] loop
    execute format('drop trigger if exists trg_%s_touch on public.%I', t, t);
    execute format(
      'create trigger trg_%s_touch before update on public.%I
         for each row execute function public.pc_touch_updated_at()', t, t);
  end loop;
end $$;

-- ─── 9. RLS ───
do $$
declare
  t   text;
  pol record;
begin
  foreach t in array array[
    'pc_projects','pc_project_finance','pc_project_members','pc_segments','pc_wbs_items',
    'pc_segment_wbs','pc_segment_wbs_finance','pc_contracts','pc_contract_finance',
    'pc_contract_scopes','pc_contract_scope_finance','pc_contract_addenda','pc_audit_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    -- Xoá SẠCH policy cũ trước khi đặt lại (không đoán tên).
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy if exists %I on public.%I', pol.policyname, t);
    end loop;
  end loop;
end $$;

-- pc_projects: lập hồ sơ = Ban lãnh đạo; sửa = người sửa khung; xoá = Admin.
create policy pc_projects_select on public.pc_projects for select to authenticated
  using (public.pc_can_view_project(id));
create policy pc_projects_insert on public.pc_projects for insert to authenticated
  with check (public.pc_is_leadership());
create policy pc_projects_update on public.pc_projects for update to authenticated
  using (public.pc_can_edit_structure(id)) with check (public.pc_can_edit_structure(id));
create policy pc_projects_delete on public.pc_projects for delete to authenticated
  using (public.is_admin_caller());

create policy pc_project_finance_select on public.pc_project_finance for select to authenticated
  using (public.pc_can_view_finance(project_id));
create policy pc_project_finance_write on public.pc_project_finance for all to authenticated
  using (public.pc_can_edit_finance(project_id)) with check (public.pc_can_edit_finance(project_id));

create policy pc_members_select on public.pc_project_members for select to authenticated
  using (public.pc_can_view_project(project_id));
create policy pc_members_write on public.pc_project_members for all to authenticated
  using (public.pc_can_manage_members(project_id)) with check (public.pc_can_manage_members(project_id));

create policy pc_segments_select on public.pc_segments for select to authenticated
  using (public.pc_can_view_project(project_id));
create policy pc_segments_write on public.pc_segments for all to authenticated
  using (public.pc_can_edit_structure(project_id)) with check (public.pc_can_edit_structure(project_id));

create policy pc_wbs_items_select on public.pc_wbs_items for select to authenticated
  using (true);
create policy pc_wbs_items_write on public.pc_wbs_items for all to authenticated
  using (public.is_admin_caller()) with check (public.is_admin_caller());

create policy pc_segment_wbs_select on public.pc_segment_wbs for select to authenticated
  using (public.pc_can_view_project(public.pc_segment_project(segment_id)));
create policy pc_segment_wbs_write on public.pc_segment_wbs for all to authenticated
  using (public.pc_can_edit_structure(public.pc_segment_project(segment_id)))
  with check (public.pc_can_edit_structure(public.pc_segment_project(segment_id)));

create policy pc_segment_wbs_fin_select on public.pc_segment_wbs_finance for select to authenticated
  using (public.pc_can_view_finance(public.pc_segment_wbs_project(segment_wbs_id)));
create policy pc_segment_wbs_fin_write on public.pc_segment_wbs_finance for all to authenticated
  using (public.pc_can_edit_finance(public.pc_segment_wbs_project(segment_wbs_id)))
  with check (public.pc_can_edit_finance(public.pc_segment_wbs_project(segment_wbs_id)));

create policy pc_contracts_select on public.pc_contracts for select to authenticated
  using (public.pc_can_view_project(project_id));
create policy pc_contracts_write on public.pc_contracts for all to authenticated
  using (public.pc_can_edit_finance(project_id)) with check (public.pc_can_edit_finance(project_id));

create policy pc_contract_fin_select on public.pc_contract_finance for select to authenticated
  using (public.pc_can_view_finance(public.pc_contract_project(contract_id)));
create policy pc_contract_fin_write on public.pc_contract_finance for all to authenticated
  using (public.pc_can_edit_finance(public.pc_contract_project(contract_id)))
  with check (public.pc_can_edit_finance(public.pc_contract_project(contract_id)));

create policy pc_scopes_select on public.pc_contract_scopes for select to authenticated
  using (public.pc_can_view_project(public.pc_contract_project(contract_id)));
create policy pc_scopes_write on public.pc_contract_scopes for all to authenticated
  using (public.pc_can_edit_finance(public.pc_contract_project(contract_id)))
  with check (public.pc_can_edit_finance(public.pc_contract_project(contract_id)));

create policy pc_scope_fin_select on public.pc_contract_scope_finance for select to authenticated
  using (public.pc_can_view_finance(public.pc_scope_project(scope_id)));
create policy pc_scope_fin_write on public.pc_contract_scope_finance for all to authenticated
  using (public.pc_can_edit_finance(public.pc_scope_project(scope_id)))
  with check (public.pc_can_edit_finance(public.pc_scope_project(scope_id)));

create policy pc_addenda_select on public.pc_contract_addenda for select to authenticated
  using (public.pc_can_view_finance(public.pc_contract_project(contract_id)));
create policy pc_addenda_write on public.pc_contract_addenda for all to authenticated
  using (public.pc_can_edit_finance(public.pc_contract_project(contract_id)))
  with check (public.pc_can_edit_finance(public.pc_contract_project(contract_id)));

-- Nhật ký chứa cả giá trị cũ/mới của bảng tiền -> chỉ Ban lãnh đạo đọc. Không ai
-- ghi trực tiếp (trigger security definer tự ghi).
create policy pc_audit_select on public.pc_audit_log for select to authenticated
  using (public.pc_is_leadership());
revoke insert, update, delete on public.pc_audit_log from authenticated;

-- ─── 10. RPC: QUYỀN CỦA TÔI + DANH MỤC ĐỐI TÁC ───
-- Giao diện hỏi một lần để biết hiện nút nào (RLS vẫn là chốt chặn thật).
create or replace function public.pc_my_access(p_project uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'can_view',            public.pc_can_view_project(p_project),
    'can_edit_structure',  public.pc_can_edit_structure(p_project),
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

create or replace function public.pc_is_leadership_rpc()
returns boolean
language sql stable security definer set search_path = public as $$
  select public.pc_is_leadership();
$$;

-- Ai được chọn/tạo nhà thầu: người sửa được hợp đồng ở ÍT NHẤT một dự án.
create or replace function public.pc_can_pick_partner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.pc_is_leadership()
      or public.pc_is_finance_staff()
      or exists (select 1 from public.pc_project_members m
                 where m.role in ('GDDA','TC_KT') and lower(trim(m.email)) = public.caller_email());
$$;

-- Danh sách đối tác (không kèm số tài khoản) cho ô chọn nhà thầu. finance_partners
-- vốn chỉ Admin/cờ Báo cáo đọc được, nên cần cửa riêng hẹp này.
create or replace function public.pc_partner_list()
returns table (id uuid, name text, short_name text, party_type text, tax_code text)
language sql
stable
security definer
set search_path = public
as $$
  select f.id, f.name, f.short_name, f.party_type, f.tax_code
  from public.finance_partners f
  where public.pc_can_pick_partner() and f.active
  order by f.name;
$$;

-- Thêm nhanh nhà thầu vào danh mục chung (trùng tên thì trả id sẵn có).
-- Số tài khoản vẫn nhập ở Kế hoạch thu chi > Danh mục đối tác.
create or replace function public.pc_partner_create(
  p_name text, p_short_name text, p_party_type text, p_tax_code text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if not public.pc_can_pick_partner() then
    raise exception 'Không có quyền thêm nhà thầu';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Thiếu tên nhà thầu';
  end if;
  select id into v_id from public.finance_partners where lower(name) = lower(trim(p_name)) limit 1;
  if v_id is not null then
    return v_id;
  end if;
  insert into public.finance_partners (name, short_name, party_type, tax_code)
  values (
    trim(p_name),
    nullif(trim(coalesce(p_short_name, '')), ''),
    case when p_party_type in ('nha_thau_phu','nha_cung_cap','chu_dau_tu','ca_nhan')
         then p_party_type else 'nha_thau_phu' end,
    nullif(trim(coalesce(p_tax_code, '')), '')
  )
  returning id into v_id;
  return v_id;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'pc_email_in(text)','pc_is_leadership()','pc_is_finance_staff()','pc_caller_department()',
    'pc_has_role(uuid, text[])','pc_can_view_project(uuid)','pc_can_edit_structure(uuid)',
    'pc_can_view_finance(uuid)','pc_can_edit_finance(uuid)','pc_can_manage_members(uuid)',
    'pc_segment_project(uuid)','pc_segment_wbs_project(uuid)','pc_contract_project(uuid)',
    'pc_scope_project(uuid)','pc_my_access(uuid)','pc_is_leadership_rpc()','pc_can_pick_partner()',
    'pc_partner_list()','pc_partner_create(text, text, text, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ─── 11. KIỂM TRA ───
-- 11a. 13 bảng pc_ phải bật RLS
select tablename, rowsecurity from pg_tables
where schemaname = 'public' and tablename like 'pc\_%' order by tablename;

-- 11b. 12 hạng mục mẫu
select code, name from public.pc_wbs_items order by sort_order;

-- 11c. 2 cờ mới
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'approval_permissions'
  and column_name in ('can_view_all_projects', 'can_view_project_finance');
