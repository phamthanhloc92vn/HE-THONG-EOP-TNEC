"use client";

import { useState, useEffect } from "react";
import { supabase } from "./supabase";

// ============================================================
// CẤU HÌNH CÔNG TY (tenant_config) — nguồn thay thế các hằng số
// brand/format từng hardcode rải rác trong code.
//
// Nguyên tắc an toàn:
// - DEFAULTS = đúng giá trị TNEC đang chạy. DB thiếu dòng nào,
//   hoặc chưa đăng nhập / lỗi mạng -> dùng default, hệ vẫn chạy y cũ.
// - Cache module-level: mỗi phiên chỉ query 1 lần cho mọi component.
// ============================================================

// Nhân sự hành chính (kanban VPP trang Hành chính). `name` phải khớp giá trị
// cột `assignee` của task trong bảng tasks (tên ngắn), `full_name` dùng cho
// form hồ sơ thanh toán.
export type AdminStaff = {
  name: string;
  full_name?: string;
  role: string;
  duties: string;
};

export type TenantConfig = {
  company_name: string;
  company_short: string;
  system_title: string;
  system_subtitle: string;
  // Dòng chữ lớn màu xanh trên MÀN HÌNH ĐĂNG NHẬP. Tách riêng khỏi
  // system_subtitle (dòng nhỏ dưới logo ở Sidebar) vì hai chỗ này cần độ dài
  // và cách xưng tên khác nhau.
  login_subtitle: string;
  logo_text: string;
  // Đường dẫn ẢNH logo ("/logo.png" trong thư mục public, hoặc URL đầy đủ).
  // Để rỗng = dùng 2 chữ cái logo_text như cũ. Xem components/BrandLogo.tsx.
  logo_url: string;
  contract_no_suffix: string;
  email_sender_name: string;
  chairman_name: string;
  site_url: string;
  hcns_head_name: string;
  admin_staff: AdminStaff[];
  // Người được miễn làm thứ Bảy nhưng vẫn tính đủ công (bảng công C&B);
  // khớp tên kiểu "chứa, không phân biệt dấu"
  plan: "basic" | "professional" | "enterprise";
  // Phân gói THEO PHÒNG BAN (quyền nội bộ) — { "_default": Plan, "<Tên phòng>": Plan }.
  // null = chưa bật: mọi người dùng chung `plan` của tenant (hành vi cũ). Khi có
  // giá trị, gói hiệu lực của mỗi user = min(plan tenant, gói phòng của user).
  // Xem resolveEffectivePlan trong lib/access.ts.
  department_plans: Record<string, "basic" | "professional" | "enterprise"> | null;
  // Bật thì các Ô CHỌN NGƯỜI (giao việc, nhân viên tham dự họp, lịch công việc,
  // chia sẻ tin tức) không còn liệt kê nhân sự đã nghỉ việc — dựa trên cờ
  // `is_resigned` có sẵn trong view employees_directory (migration 031).
  //
  // KHÔNG ảnh hưởng: module Danh sách nhân viên & C&B (vẫn thấy đủ để tra cứu),
  // nhận diện người đăng nhập (Header/Sidebar/useCurrentUser) và các số liệu
  // thống kê — lọc ở đó sẽ làm mất quyền hoặc sai số đếm.
  hide_resigned_in_pickers: boolean;
  // ĐĂNG KÝ XE / PHÒNG HỌP — bỏ bước duyệt cấp 1 của Trưởng phòng, đơn gửi thẳng
  // tới người điều phối (cờ can_approve_booking). Bật/tắt tại Cài đặt hệ thống >
  // Phân quyền & Luồng duyệt, có hiệu lực ngay, không cần deploy.
  //
  // TÁCH RIÊNG TỪNG LOẠI (18/09/2026): xe và phòng họp do hai người điều phối khác
  // nhau và mức độ cần Trưởng phòng duyệt cũng khác, nên mỗi loại một công tắc.
  //
  // CHỈ áp cho xe/phòng họp. Nghỉ phép và công tác vẫn bắt buộc qua cấp 1 — đó là
  // duyệt nhân sự, không phải điều phối tài sản.
  //
  // Bật thì Trưởng phòng KHÔNG nhận email báo nữa (user chốt 16/09/2026: im lặng
  // hoàn toàn, không gửi bản báo tin).
  booking_skip_cap1_xe: boolean;
  booking_skip_cap1_phong_hop: boolean;
  // KHOÁ CŨ, chỉ còn để tương thích ngược: hồi 16/09 công tắc là một, áp chung cả
  // hai loại. Bật = coi như cả hai loại đều bỏ cấp 1 (xem bookingSkipCap1Of). Giao
  // diện không ghi vào khoá này nữa; công ty nào đang bật thì tắt nó đi rồi dùng
  // hai khoá riêng ở trên.
  booking_skip_cap1: boolean;
  // KHOÁ TẤT CẢ TÀI KHOẢN — bật thì mọi người không phải Admin (allowed_users)
  // bị chặn ở AuthWrapper. Chỉ là 1 công tắc, KHÔNG đổi trạng thái từng nhân
  // viên, nên tắt đi là mọi người vào lại như cũ (người nghỉ việc vẫn bị khoá).
  lock_all_accounts: boolean;
  // Khoá THEO PHÒNG BAN / BĐH: danh sách tên khớp đúng `employees.department`.
  // Người thuộc phòng trong danh sách bị khoá như lock_all_accounts.
  locked_departments: string[];
};

export const TENANT_DEFAULTS: TenantConfig = {
  company_name: "Trung Nam E&C",
  company_short: "TNEC",
  system_title: "PM - HCNS - TNEC",
  system_subtitle: "Hệ thống HCNS",
  login_subtitle: "Hệ thống EOP Trungnam E&C",
  logo_text: "TN",
  logo_url: "", // mặc định rỗng -> giữ nguyên ô 2 chữ cái
  contract_no_suffix: "TNE&C",
  email_sender_name: "Phòng HCNS TNEC",
  chairman_name: "Huỳnh Giáp Nhân",
  site_url: "https://nhansutrungnamec.com",
  hcns_head_name: "Lê Thị Hoa Đào",
  admin_staff: [
    { name: "Như Quỳnh", full_name: "Nguyễn Bích Như Quỳnh", role: "Phó phòng Hành chính", duties: "Phụ trách hậu cần, kho VPP, phòng họp, tiếp khách & làm hồ sơ thanh toán, đối soát hóa đơn" },
    { name: "Thanh Hằng", role: "Văn thư", duties: "Phụ trách tiếp nhận, phân loại, lưu trữ và chuyển phát công văn" },
    { name: "Thanh Ngân", role: "Hành chính", duties: "Phụ trách hỗ trợ công tác hành chính, quản lý văn phòng phẩm & cấp phát vật tư" },
  ],
  plan: "enterprise",
  department_plans: null, // chưa bật phân gói theo phòng -> dùng chung `plan`
  hide_resigned_in_pickers: false, // mặc định TẮT -> hành vi y như trước khi có tính năng
  booking_skip_cap1_xe: false, // mặc định TẮT -> vẫn đủ 2 cấp như cũ
  booking_skip_cap1_phong_hop: false,
  booking_skip_cap1: false, // khoá cũ, mặc định TẮT
  lock_all_accounts: false,
  locked_departments: [],
};

/**
 * Loại đăng ký này có bỏ bước Trưởng phòng không.
 * Khoá cũ `booking_skip_cap1` bật thì áp cho CẢ HAI loại — đừng bỏ vế này, công ty
 * nào đã bật hồi 16/09 mà mất vế đó là luồng tự nhảy ngược về 2 cấp không ai hiểu vì sao.
 */
export function bookingSkipCap1Of(cfg: TenantConfig, bookingType: "xe" | "phong_hop"): boolean {
  if (cfg.booking_skip_cap1) return true;
  return bookingType === "xe" ? !!cfg.booking_skip_cap1_xe : !!cfg.booking_skip_cap1_phong_hop;
}

let cached: TenantConfig | null = null;
let inflight: Promise<TenantConfig> | null = null;

export async function fetchTenantConfig(): Promise<TenantConfig> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const { data, error } = await supabase.from("tenant_config").select("key, value");
      if (error || !data || data.length === 0) return TENANT_DEFAULTS;
      const merged: any = { ...TENANT_DEFAULTS };
      for (const row of data) {
        if (row.key in merged && row.value !== null && row.value !== undefined) {
          merged[row.key] = row.value; // value là jsonb: chuỗi đã parse sẵn
        }
      }
      // Chưa đăng nhập RLS chỉ trả các khóa brand -> dùng được nhưng KHÔNG cache,
      // để sau khi đăng nhập hook sẽ đọc lại đủ bộ khóa. Nhận biết phiên đã
      // đăng nhập qua khóa 'plan' (anon không đọc được khóa này) — không đếm
      // số dòng vì DB có thể chưa chạy đủ các migration seed khóa mới.
      if (data.some(row => row.key === "plan")) {
        cached = merged as TenantConfig;
      }
      return merged as TenantConfig;
    } catch {
      return TENANT_DEFAULTS;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

// Xoá cache sau khi GHI cấu hình. Cache nằm ở tầng module nên nếu không xoá,
// người vừa đổi công tắc sẽ còn thấy giá trị cũ ở các trang khác cho tới khi
// tải lại toàn bộ ứng dụng.
export function invalidateTenantConfig() {
  cached = null;
}

// Hook cho component: render ngay với DEFAULTS, tự cập nhật khi DB trả về.
export function useTenantConfig(): TenantConfig {
  const [config, setConfig] = useState<TenantConfig>(cached || TENANT_DEFAULTS);

  useEffect(() => {
    let mounted = true;
    fetchTenantConfig().then(c => { if (mounted) setConfig(c); });
    return () => { mounted = false; };
  }, []);

  return config;
}
