-- ============================================================
-- 088 — PHIẾU TRÌNH KÝ: THÊM LOẠI "TỜ TRÌNH"
--
-- LÝ DO (user chốt 22/09/2026):
-- Bộ phận thường xuyên trình Ban Giám đốc một ĐỀ XUẤT (mua sắm, nâng cấp, chủ
-- trương…) bằng tờ TTr/Lodeza EOP — không phải hồ sơ thanh toán, không phải hợp đồng,
-- cũng không phải đề nghị chuyển tiền. Trước đây phải soạn Word tay rồi cầm đi
-- xin chữ ký; nay lập ngay trong module và đi đúng luồng duyệt như 3 loại kia.
--
-- LUỒNG DUYỆT — ĐÚNG 2 CẤP, theo 3 ô ký trên tờ mẫu:
--   NGƯỜI TRÌNH KÝ (người lập) → TRƯỞNG BỘ PHẬN (cấp 1) → BAN LÃNH ĐẠO (Giám đốc)
-- Không có chặng Phó Giám đốc và KHÔNG có chặng Kế toán: tờ trình chỉ xin CHỦ
-- TRƯƠNG, tiền chi sau đó đi bằng phiếu đề nghị chuyển tiền riêng.
--
-- KHÔNG đụng gì vào cách trigger đi luồng: 074 đã đi theo cột `route` của từng
-- phiếu, hoàn toàn không phụ thuộc `loai`. buildSigningRoute() bên client dựng
-- route ['cho_cap1','cho_giam_doc'] cho loại này.
--
-- CÁCH CHẠY: Supabase Dashboard -> SQL Editor -> dán TOÀN BỘ -> Run.
-- An toàn chạy lại nhiều lần. YÊU CẦU: đã chạy 050, 052, 053, 060, 065, 074, 079.
-- ============================================================

-- ─── 1. NỚI CHECK `loai` ───
alter table public.signing_submissions
  drop constraint if exists signing_submissions_loai_check;
alter table public.signing_submissions
  add constraint signing_submissions_loai_check
  check (loai in ('ho_so', 'hop_dong', 'chuyen_tien', 'to_trinh'));

-- ─── 2. BA Ô RIÊNG CỦA TỜ TRÌNH ───
-- Để null với ba loại kia. Những ô còn lại DÙNG CHUNG cột đã có, không đẻ thêm:
--   don_vi             -> Bộ phận trình ("Lời đầu tiên bộ phận … ")
--   ve_viec            -> dòng "V/v: …" dưới chữ TỜ TRÌNH
--   noi_dung_trinh     -> phần thân đề nghị
--   chu_dau_tu         -> đơn vị báo giá
--   de_nghi_thanh_toan -> giá dự kiến,  vat_percent -> % VAT
--   hang_muc           -> diễn giải kèm giá (vd "nâng cấp 3 phiên bản Anh/Việt/Trung")
alter table public.signing_submissions
  add column if not exists so_to_trinh text,
  add column if not exists can_cu      text,
  add column if not exists kien_nghi   text;

comment on column public.signing_submissions.so_to_trinh is
  'So hieu to trinh (vd 012/026/TTr/TNE&C) - chi dung cho loai=to_trinh (088).';
comment on column public.signing_submissions.can_cu is
  'Doan "Can cu ..." mo dau to trinh - chi dung cho loai=to_trinh (088).';
comment on column public.signing_submissions.kien_nghi is
  'Doan "Kien nghi:" cuoi to trinh - chi dung cho loai=to_trinh (088).';

-- ─── 3. TRIGGER: KHOÁ LUÔN BA CỘT MỚI ───
-- Bản 079 liệt kê từng cột người duyệt KHÔNG được sửa. Thiếu ba cột mới ở đây
-- thì Trưởng bộ phận / Giám đốc sửa được nội dung tờ trình ngay lúc bấm Duyệt —
-- đúng loại lỗ hổng mà danh sách này sinh ra để bịt.
-- Phần còn lại chép NGUYÊN VĂN từ 079.

create or replace function public.guard_signing_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  jwt_email text    := public.caller_email();
  is_admin  boolean := public.is_admin_caller();
  is_owner  boolean := jwt_email <> '' and lower(old.created_by) = jwt_email;
  has_route boolean := jsonb_typeof(old.route) = 'array' and jsonb_array_length(old.route) > 0;
  has_qlda  boolean := public.signing_caller_qlda();
  has_khdt  boolean := public.signing_caller_khdt();
  has_acct  boolean := public.signing_caller_acct();
  has_gd    boolean := 'cho_giam_doc' = any(public.signing_stages_of_caller());
  is_cap1   boolean := old.cap1_email is not null and jwt_email <> ''
                       and position(jwt_email in lower(old.cap1_email)) > 0;
  holds_old boolean;
  cur_idx   int;
  nxt       text;
begin
  -- Ai đang giữ chặng old.status?
  holds_old := case old.status
    when 'cho_cap1'         then is_cap1 or (old.cap1_email is null and is_admin)
    when 'cho_pho_giam_doc' then has_qlda or has_khdt      -- legacy gộp
    when 'cho_pgd_qlda'     then has_qlda
    when 'cho_pgd_khdt'     then has_khdt
    when 'cho_giam_doc'     then has_gd
    when 'cho_ke_toan'      then has_acct
    else false end;

  -- 1) Không đổi trạng thái: chỉ người lập sửa nội dung, và chỉ ở nháp/trả lại.
  if old.status = new.status then
    if not (is_admin or (is_owner and old.status in ('nhap','tra_lai'))) then
      raise exception 'Phiếu đang ở bước "%" nên không sửa được nội dung.', old.status;
    end if;
    return new;
  end if;

  if is_admin then return new; end if;

  -- 2) NGƯỜI DUYỆT KHÔNG ĐƯỢC SỬA SỐ LIỆU / ĐỊNH TUYẾN.
  if not is_owner then
    if  new.don_vi               is distinct from old.don_vi
     or new.ve_viec              is distinct from old.ve_viec
     or new.noi_dung_trinh       is distinct from old.noi_dung_trinh
     or new.dot_so               is distinct from old.dot_so
     or new.chu_dau_tu           is distinct from old.chu_dau_tu
     or new.du_an                is distinct from old.du_an
     or new.hop_dong_so          is distinct from old.hop_dong_so
     or new.ngay_ky_hop_dong     is distinct from old.ngay_ky_hop_dong
     or new.goi_thau             is distinct from old.goi_thau
     or new.gia_tri_hd           is distinct from old.gia_tri_hd
     or new.gia_tri_nghiem_thu   is distinct from old.gia_tri_nghiem_thu
     or new.giu_bao_hanh         is distinct from old.giu_bao_hanh
     or new.giu_lai_tung_lan     is distinct from old.giu_lai_tung_lan
     or new.ty_le_giu_lai        is distinct from old.ty_le_giu_lai
     or new.khau_tru_tam_ung     is distinct from old.khau_tru_tam_ung
     or new.ty_le_thu_hoi        is distinct from old.ty_le_thu_hoi
     or new.de_nghi_thanh_toan   is distinct from old.de_nghi_thanh_toan
     or new.luy_ke_da_thanh_toan is distinct from old.luy_ke_da_thanh_toan
     or new.tam_ung_con_lai      is distinct from old.tam_ung_con_lai
     or new.project_code         is distinct from old.project_code
     or new.files                is distinct from old.files
     or new.created_by           is distinct from old.created_by
     or new.loai                 is distinct from old.loai
     or new.hang_muc             is distinct from old.hang_muc
     or new.ben_a                is distinct from old.ben_a
     or new.ben_b                is distinct from old.ben_b
     or new.vat_percent          is distinct from old.vat_percent
     or new.so_sanh              is distinct from old.so_sanh
     or new.route                is distinct from old.route
     or new.cap1_email           is distinct from old.cap1_email
     or new.pgd_chon             is distinct from old.pgd_chon
     -- 079 — tài khoản nhận tiền của giấy đề nghị chuyển tiền
     or new.so_tai_khoan         is distinct from old.so_tai_khoan
     or new.ngan_hang            is distinct from old.ngan_hang
     -- 088 — nội dung riêng của tờ trình
     or new.so_to_trinh          is distinct from old.so_to_trinh
     or new.can_cu               is distinct from old.can_cu
     or new.kien_nghi            is distinct from old.kien_nghi
    then
      raise exception 'Người duyệt không được sửa số liệu / định tuyến trên phiếu. Nếu sai, hãy TRẢ LẠI để người lập sửa.';
    end if;
  end if;

  -- 3) Trả lại: chỉ cấp ĐANG giữ phiếu, và phải ghi lý do.
  if new.status = 'tra_lai' then
    if not holds_old then
      raise exception 'Bạn không phải cấp đang xử lý phiếu này nên không trả lại được.';
    end if;
    if coalesce(new.tra_lai_ly_do, '') = '' then
      raise exception 'Phải ghi lý do khi trả lại phiếu.';
    end if;
    return new;
  end if;

  -- 4) PHIẾU MỚI — đi theo route của chính phiếu.
  if has_route then
    if old.status in ('nhap','tra_lai') then
      if new.status <> (old.route ->> 0) then
        raise exception 'Bước đầu của phiếu phải là "%".', old.route ->> 0;
      end if;
      if not is_owner then
        raise exception 'Chỉ người lập phiếu mới được trình phiếu.';
      end if;
      return new;
    end if;

    select (t.ord - 1) into cur_idx
      from jsonb_array_elements_text(old.route) with ordinality as t(val, ord)
      where t.val = old.status
      limit 1;
    if cur_idx is null then
      raise exception 'Trạng thái "%" không nằm trong luồng của phiếu.', old.status;
    end if;
    if cur_idx + 1 >= jsonb_array_length(old.route) then
      nxt := 'hoan_tat';
    else
      nxt := old.route ->> (cur_idx + 1);
    end if;
    if new.status <> nxt then
      raise exception 'Không chuyển được từ "%" sang "%".', old.status, new.status;
    end if;
    if not holds_old then
      raise exception 'Bạn không phải cấp đang giữ phiếu này.';
    end if;
    return new;
  end if;

  -- 5) PHIẾU CŨ (route rỗng) — giữ nguyên luật 060.
  if old.status in ('nhap','tra_lai') and new.status = 'cho_pho_giam_doc' then
    if not is_owner then
      raise exception 'Chỉ người lập phiếu mới được trình phiếu.';
    end if;
    return new;
  end if;
  if holds_old then
    if old.status = 'cho_pho_giam_doc' and new.status = 'cho_giam_doc' then
      return new;
    end if;
    if old.status = 'cho_giam_doc' then
      if old.loai = 'hop_dong' and new.status = 'hoan_tat' then return new; end if;
      if old.loai <> 'hop_dong' and new.status = 'cho_ke_toan' then return new; end if;
    end if;
    if old.status = 'cho_ke_toan' and new.status = 'hoan_tat' then
      return new;
    end if;
    raise exception 'Không chuyển được từ "%" sang "%" (loại phiếu: %).',
      old.status, new.status, old.loai;
  end if;

  raise exception 'Bạn không có quyền chuyển phiếu từ "%" sang "%".', old.status, new.status;
end;
$$;

drop trigger if exists guard_signing_transition_trg on public.signing_submissions;
create trigger guard_signing_transition_trg
  before update on public.signing_submissions
  for each row execute function public.guard_signing_transition();

-- ─── 4. KIỂM TRA ───
select conname, pg_get_constraintdef(oid) as dinh_nghia
from pg_constraint
where conrelid = 'public.signing_submissions'::regclass
  and conname = 'signing_submissions_loai_check';

select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'signing_submissions'
  and column_name in ('so_to_trinh','can_cu','kien_nghi')
order by column_name;

select loai, count(*) as so_phieu
from public.signing_submissions
group by loai
order by loai;
