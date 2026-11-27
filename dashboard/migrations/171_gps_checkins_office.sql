-- ============================================================
-- 171 — CHẤM CÔNG GPS cho KHỐI VĂN PHÒNG (các phòng ban)
--
-- Toạ độ Văn phòng công ty = 1 dòng project_locations có bdh_name
-- 'Văn phòng công ty' (ghim tại trang /cham-cong, ẩn khỏi bản đồ dự án).
-- Lượt chấm của nhân sự phòng ban vẫn ghi bdh_name = TÊN PHÒNG BAN để HR lọc
-- theo phòng; trigger chỉ cần biết: phòng ban -> dùng toạ độ Văn phòng công ty.
--
-- CÁCH CHẠY: Supabase Dashboard -> SQL Editor -> Run. An toàn chạy lại nhiều lần.
-- Tiên quyết: migration 067.
-- ============================================================

create or replace function public.gps_checkins_validate()
returns trigger language plpgsql as $$
declare pl record; d double precision; loc_name text := new.bdh_name;
begin
  new.captured_at := now();  -- giờ chính thức = server, bỏ qua đồng hồ client
  -- Phòng ban (khối Văn phòng) dùng chung toạ độ "Văn phòng công ty".
  if exists (select 1 from public.departments where name = new.bdh_name and type = 'phong_ban') then
    loc_name := 'Văn phòng công ty';
  end if;
  select lat, lng, coalesce(radius_m, 100) as radius_m into pl
  from public.project_locations where bdh_name = loc_name limit 1;
  if not found then
    raise exception '"%" chưa được ghim toạ độ.', loc_name using errcode='check_violation';
  end if;
  if new.accuracy_m is not null and new.accuracy_m > 100 then
    raise exception 'Tín hiệu GPS quá yếu (sai số ~% m).', round(new.accuracy_m) using errcode='check_violation';
  end if;
  d := public.gps_distance_m(new.lat, new.lng, pl.lat, pl.lng);
  if d > pl.radius_m then
    raise exception 'Ngoài bán kính: cách điểm chấm ~% m (bán kính % m).', round(d), pl.radius_m using errcode='check_violation';
  end if;
  new.radius_m := pl.radius_m; new.distance_m := d; new.is_valid := true;
  return new;
end;
$$;
