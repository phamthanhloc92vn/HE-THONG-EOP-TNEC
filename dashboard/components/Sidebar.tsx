"use client";

import { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import BrandLogo from "./BrandLogo";
import { usePathname, useSearchParams } from "next/navigation";
import {
  LayoutDashboard,
  ClipboardList,
  Calculator,
  Building2,
  FileText,
  Settings,
  Briefcase,
  Users,
  CalendarRange,
  X,
  CheckSquare,
  MessageSquare,
  Mic,
  CalendarCheck,
  CarFront,
  DoorOpen,
  ChevronDown,
  MapPin,
  Newspaper,
  PlayCircle,
  CalendarOff,
  Plane,
  TrendingUp,
  Fingerprint,
  Wallet,
  ReceiptText,
  FolderKanban,
  ClipboardType,
  HardHat,
  Gauge,
  Contact,
  Boxes,
  Truck,
  Gavel,
  Scale,
  FilePen
} from "lucide-react";
import { useSidebar } from "./SidebarContext";
import { useDepartments } from "@/lib/departments";
import ThemeToggle from "./ThemeToggle";
import { supabase } from "@/lib/supabase";
import { fetchApprovalPermissions, canOpenRequestsInbox, isMarketingTeamLeader } from "@/lib/approvers";
import { emailFieldMatches } from "@/lib/emailMatch";
import { useTenantConfig } from "@/lib/tenantConfig";
import { usePlan } from "@/lib/plan";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { fetchPenaltyAccess, NO_PENALTY_ACCESS } from "@/lib/atldPenalties";
import { usePdfEditLink } from "@/lib/pdfEditLink";

// Quyền xử phạt của P. ATLĐ (quyết định mục con nào hiện). Nạp 1 lần mỗi phiên.
// Cùng luật lọc với trang /an-toan-lao-dong: tab xử phạt cần pen.view, 3 tab kho
// cần pen.stock (hoặc chưa có quyền xử phạt nào).
let atldNavCache: Promise<typeof NO_PENALTY_ACCESS> | null = null;
function useAtldNav(): typeof NO_PENALTY_ACCESS | null {
  const [nav, setNav] = useState<typeof NO_PENALTY_ACCESS | null>(null);
  useEffect(() => {
    let alive = true;
    if (!atldNavCache) atldNavCache = fetchPenaltyAccess();
    atldNavCache.then((n) => alive && setNav(n));
    return () => {
      alive = false;
    };
  }, []);
  return nav;
}

// Quyền hiện 2 mục Quản trị dự án (RPC pc_nav_access, migration 103). Nạp 1 lần
// mỗi phiên để menu không nháy khi chuyển trang. Lỗi (chưa chạy migration) ->
// hiện như cũ để không khoá nhầm ai.
type PcNav = { has_projects: boolean; can_dashboard: boolean };
let pcNavCache: Promise<PcNav> | null = null;
function loadPcNav(): Promise<PcNav> {
  if (!pcNavCache) {
    pcNavCache = (async () => {
      const { data, error } = await supabase.rpc("pc_nav_access");
      if (error || !data) {
        pcNavCache = null;
        return { has_projects: true, can_dashboard: true };
      }
      return data as PcNav;
    })();
  }
  return pcNavCache;
}
function usePcNav(): PcNav | null {
  const [nav, setNav] = useState<PcNav | null>(null);
  useEffect(() => {
    let alive = true;
    loadPcNav().then((n) => alive && setNav(n));
    return () => {
      alive = false;
    };
  }, []);
  return nav;
}

function SidebarLinks({ isApprover, pathname, setSidebarOpen }: { isApprover: boolean; pathname: string; setSidebarOpen: (o: boolean) => void }) {
  const searchParams = useSearchParams();
  const currentTab = searchParams.get("tab");
  const isBookingSection = pathname.startsWith("/dang-ky");
  // Hai mục nghỉ phép / công tác mở form nằm sẵn trên trang Lịch công việc, nhận
  // biết bằng tham số ?dk=. Nhóm phải coi là đang mở ở cả hai trang, nếu không
  // bấm vào là nhóm tự cụp lại và mục không sáng.
  const currentDk = searchParams.get("dk");
  const isCalendarBooking = pathname === "/calendar" && !!currentDk;
  const isBookingSectionActive = isBookingSection || isCalendarBooking;
  const [bookingGroupOpen, setBookingGroupOpen] = useState(isBookingSectionActive);
  // Nhóm "Kế toán" (/ke-toan) — hiện chỉ có mục con "Hồ sơ thanh toán".
  const isKeToanSection = pathname.startsWith("/ke-toan");
  const [keToanGroupOpen, setKeToanGroupOpen] = useState(isKeToanSection);
  // Nhóm "Quản lý dự án" — hiện chỉ có mục con "Vị trí dự án" (route giữ nguyên /vi-tri-du-an).
  const isProjectSection =
    pathname.startsWith("/vi-tri-du-an") ||
    pathname.startsWith("/thong-tin-quan-tri-du-an") ||
    pathname.startsWith("/dashboard-du-an");
  const [projectGroupOpen, setProjectGroupOpen] = useState(isProjectSection);
  // Nhóm "P. An toàn lao động" — 5 mục con là 5 tab của trang /an-toan-lao-dong (?tab=).
  const isAtldSection = pathname.startsWith("/an-toan-lao-dong");
  const [atldGroupOpen, setAtldGroupOpen] = useState(isAtldSection);
  const atldNav = useAtldNav();
  // Ẩn menu theo GÓI HIỆU LỰC CỦA PHÒNG + cấp phép riêng (không chỉ gói toàn cục).
  // Đang tải danh tính -> hiện tạm (tránh nháy menu trống), narrow lại khi có dữ liệu.
  const currentUser = useCurrentUser();
  const deps = useDepartments();
  const pcNav = usePcNav();
  const isPathAllowed = (p: string) => (currentUser.loading ? true : currentUser.canPath(p));
  // "PDF edit 1 click": Admin / cờ can_manage_news vào trang /pdf-edit để sửa link;
  // người khác bấm là mở thẳng link ngoài ở tab mới.
  const { url: pdfEditUrl } = usePdfEditLink();
  const canEditPdfLink = !currentUser.loading && (currentUser.isAdmin || currentUser.perms.canManageNews);
  const isPdfEditActive = pathname === "/pdf-edit";
  // "Chấm công GPS" chỉ hiện cho Admin hoặc nhân sự thuộc một Ban điều hành.
  const showGpsCheckin = !currentUser.loading && (currentUser.isAdmin || deps.bdh.includes(currentUser.department));

  const navItems = [
    { label: "Dashboard", href: "/", icon: LayoutDashboard },
    { label: "Tin tức", href: "/tin-tuc", icon: Newspaper },
    { label: "Hướng dẫn EOP", href: "/huong-dan-eop", icon: PlayCircle },
    { label: "Vị trí dự án", href: "/vi-tri-du-an", icon: MapPin },
    { label: "Quản lý Công việc", href: "/tasks", icon: ClipboardList },
    { label: "Lịch công việc", href: "/calendar", icon: CalendarRange },
    { label: "Tuyển dụng", href: "/recruitment", icon: Briefcase },
    { label: "Danh sách nhân viên", href: "/employees", icon: Users },
    { label: "Lương & Phúc lợi (C&B)", href: "/cb", icon: Calculator },
    { label: "Đề nghị thanh toán", href: "/administration", icon: Building2 },
    { label: "Hồ sơ trình ký", href: "/ho-so-trinh-ky", icon: TrendingUp },
    { label: "Văn Thư", href: "/document-control", icon: FileText },
    { label: "P. An toàn lao động", href: "/an-toan-lao-dong", icon: HardHat },
    { label: "Danh bạ đối tác", href: "/danh-ba-doi-tac", icon: Contact },
    { label: "Biên bản họp (Meeting)", href: "/meeting-team", icon: Mic },
    { label: "Góp ý & Kiến nghị", href: "/suggestions", icon: MessageSquare },
    { label: "Cài đặt hệ thống", href: "/settings?tab=system", icon: Settings },
  ].filter(item => isPathAllowed(item.href.split("?")[0])); // ẩn module ngoài gói dịch vụ

  // Chèn "Chấm công GPS" ngay dưới "Vị trí dự án" (chỉ Admin / nhân sự BĐH).
  if (showGpsCheckin) {
    const gpsItem = { label: "Chấm công GPS", href: "/cham-cong", icon: Fingerprint };
    const idx = navItems.findIndex(i => i.href === "/vi-tri-du-an");
    if (idx >= 0) navItems.splice(idx + 1, 0, gpsItem);
    else navItems.push(gpsItem);
  }

  if (isApprover) {
    navItems.push({ label: "Duyệt yêu cầu", href: "/settings?tab=approvals", icon: CheckSquare });
  }

  // Nhóm "Quản lý Đăng ký" (/dang-ky) — gate theo gói (hiện thuộc Basic)
  const bookingAllowed = isPathAllowed("/dang-ky");

  const bookingChildren: {
    label: string;
    href: string;
    tab: string | null;
    dk: string | null;
    icon: typeof CarFront;
  }[] = [
    { label: "Đăng ký xe", href: "/dang-ky?tab=xe", tab: "xe", dk: null, icon: CarFront },
    { label: "Đăng ký phòng họp", href: "/dang-ky?tab=phong-hop", tab: "phong-hop", dk: null, icon: DoorOpen },
    { label: "Đăng ký nghỉ phép", href: "/calendar?dk=nghi-phep", tab: null, dk: "nghi-phep", icon: CalendarOff },
    { label: "Đăng ký công tác", href: "/calendar?dk=cong-tac", tab: null, dk: "cong-tac", icon: Plane },
  ];

  const bookingGroup = (
    <div key="booking-group" className="space-y-1.5">
      <button
        type="button"
        onClick={() => setBookingGroupOpen((o) => !o)}
        className={`w-full flex items-center gap-3 px-5 py-2.5 rounded-[10px] text-xs font-bold transition-all duration-200 active:scale-[0.97] border cursor-pointer ${
          isBookingSectionActive
            ? "bg-gradient-to-r from-[#005BAC] to-[#00AEEF] border-transparent text-white shadow-md shadow-blue-500/15"
            : "bg-slate-50/50 border-slate-100 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        }`}
      >
        <CalendarCheck size={15} className={isBookingSectionActive ? "text-white" : "text-slate-500"} />
        <span className="flex-1 text-left">Quản lý Đăng ký</span>
        <ChevronDown
          size={13}
          className={`transition-transform duration-200 ${bookingGroupOpen || isBookingSectionActive ? "rotate-180" : ""} ${isBookingSectionActive ? "text-white" : "text-slate-400"}`}
        />
      </button>

      {(bookingGroupOpen || isBookingSectionActive) && (
        <div className="pl-5 space-y-1.5 animate-in fade-in duration-150">
          {bookingChildren.map((child) => {
            const ChildIcon = child.icon;
            const activeChildTab = currentTab || "phong-hop";
            const isChildActive = child.dk
              ? isCalendarBooking && currentDk === child.dk
              : isBookingSection && activeChildTab === child.tab;
            return (
              <Link
                key={child.href}
                href={child.href}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-2.5 px-4 py-2 rounded-[10px] text-[11px] font-bold transition-all duration-200 active:scale-[0.97] hover:translate-x-1 border ${
                  isChildActive
                    ? "bg-blue-50 border-blue-200 text-[#005BAC]"
                    : "bg-white border-slate-100 text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                }`}
              >
                <ChildIcon size={13} className={isChildActive ? "text-[#005BAC]" : "text-slate-400"} />
                <span>{child.label}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );

  // Nhóm "Quản lý dự án" — đứng đúng chỗ mục "Vị trí dự án" cũ; mục con lọc theo gói.
  // Thông tin quản trị: ai xem được ≥ 1 dự án. Dashboard: BLĐ, TC-KT, cờ xem toàn bộ, GĐDA.
  // Đang nạp quyền -> tạm ẩn 2 mục này (không hiện rồi mới giấu).
  const projectChildren = [
    { label: "Vị trí dự án", href: "/vi-tri-du-an", icon: MapPin },
    ...(pcNav?.has_projects ? [{ label: "Thông tin quản trị dự án", href: "/thong-tin-quan-tri-du-an", icon: ClipboardType }] : []),
    ...(pcNav?.can_dashboard ? [{ label: "Dashboard dự án", href: "/dashboard-du-an", icon: Gauge }] : []),
  ];
  const projectGroup = (
    <div key="project-group" className="space-y-1.5">
      <button
        type="button"
        onClick={() => setProjectGroupOpen((o) => !o)}
        className={`w-full flex items-center gap-3 px-5 py-2.5 rounded-[10px] text-xs font-bold transition-all duration-200 active:scale-[0.97] border cursor-pointer ${
          isProjectSection
            ? "bg-gradient-to-r from-[#005BAC] to-[#00AEEF] border-transparent text-white shadow-md shadow-blue-500/15"
            : "bg-slate-50/50 border-slate-100 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        }`}
      >
        <FolderKanban size={15} className={isProjectSection ? "text-white" : "text-slate-500"} />
        <span className="flex-1 text-left">Quản lý dự án</span>
        <ChevronDown
          size={13}
          className={`transition-transform duration-200 ${projectGroupOpen || isProjectSection ? "rotate-180" : ""} ${isProjectSection ? "text-white" : "text-slate-400"}`}
        />
      </button>

      {(projectGroupOpen || isProjectSection) && (
        <div className="pl-5 space-y-1.5 animate-in fade-in duration-150">
          {projectChildren.map((child) => {
            const ChildIcon = child.icon;
            const isChildActive = pathname.startsWith(child.href);
            return (
              <Link
                key={child.href}
                href={child.href}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-2.5 px-4 py-2 rounded-[10px] text-[11px] font-bold transition-all duration-200 active:scale-[0.97] hover:translate-x-1 border ${
                  isChildActive
                    ? "bg-blue-50 border-blue-200 text-[#005BAC]"
                    : "bg-white border-slate-100 text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                }`}
              >
                <ChildIcon size={13} className={isChildActive ? "text-[#005BAC]" : "text-slate-400"} />
                <span>{child.label}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );

  const showStock = !atldNav || atldNav.stock || !atldNav.view;
  const showPenalty = !atldNav || atldNav.view;
  const atldChildren = [
    { label: "Dashboard ATLĐ", tab: "dashboard", icon: LayoutDashboard, show: true },
    { label: "Tổng Danh mục kho ATLĐ", tab: "items", icon: Boxes, show: showStock },
    { label: "Quản lý Xuất-Nhập kho", tab: "prices", icon: ReceiptText, show: showStock },
    { label: "Xuất kho cho BĐH/Đối tác", tab: "issues", icon: Truck, show: showStock },
    { label: "Khấu trừ xử phạt", tab: "penalties", icon: Gavel, show: showPenalty },
    { label: "Khấu trừ PPE", tab: "ppe", icon: HardHat, show: showPenalty },
    { label: "Định mức xử phạt", tab: "rates", icon: Scale, show: showPenalty },
  ].filter((c) => c.show);
  const atldGroup = (
    <div key="atld-group" className="space-y-1.5">
      <button
        type="button"
        onClick={() => setAtldGroupOpen((o) => !o)}
        className={`w-full flex items-center gap-3 px-5 py-2.5 rounded-[10px] text-xs font-bold transition-all duration-200 active:scale-[0.97] border cursor-pointer ${
          isAtldSection
            ? "bg-gradient-to-r from-[#005BAC] to-[#00AEEF] border-transparent text-white shadow-md shadow-blue-500/15"
            : "bg-slate-50/50 border-slate-100 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        }`}
      >
        <HardHat size={15} className={isAtldSection ? "text-white" : "text-slate-500"} />
        <span className="flex-1 text-left">P. An toàn lao động</span>
        <ChevronDown
          size={13}
          className={`transition-transform duration-200 ${atldGroupOpen || isAtldSection ? "rotate-180" : ""} ${isAtldSection ? "text-white" : "text-slate-400"}`}
        />
      </button>

      {(atldGroupOpen || isAtldSection) && (
        <div className="pl-5 space-y-1.5 animate-in fade-in duration-150">
          {atldChildren.map((child) => {
            const ChildIcon = child.icon;
            const isChildActive = isAtldSection && (currentTab || atldChildren[0]?.tab) === child.tab;
            return (
              <Link
                key={child.tab}
                href={`/an-toan-lao-dong?tab=${child.tab}`}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-2.5 px-4 py-2 rounded-[10px] text-[11px] font-bold transition-all duration-200 active:scale-[0.97] hover:translate-x-1 border ${
                  isChildActive
                    ? "bg-blue-50 border-blue-200 text-[#005BAC]"
                    : "bg-white border-slate-100 text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                }`}
              >
                <ChildIcon size={13} className={isChildActive ? "text-[#005BAC]" : "text-slate-400"} />
                <span>{child.label}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );

  // Nhóm "Kế toán" — chèn ngay dưới "Đề nghị thanh toán" nếu gói cho phép.
  const keToanAllowed = isPathAllowed("/ke-toan");
  const keToanChildren = [
    { label: "Hồ sơ thanh toán", href: "/ke-toan/ho-so-thanh-toan", icon: ReceiptText },
  ];
  const keToanGroup = (
    <div key="ketoan-group" className="space-y-1.5">
      <button
        type="button"
        onClick={() => setKeToanGroupOpen((o) => !o)}
        className={`w-full flex items-center gap-3 px-5 py-2.5 rounded-[10px] text-xs font-bold transition-all duration-200 active:scale-[0.97] border cursor-pointer ${
          isKeToanSection
            ? "bg-gradient-to-r from-[#005BAC] to-[#00AEEF] border-transparent text-white shadow-md shadow-blue-500/15"
            : "bg-slate-50/50 border-slate-100 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        }`}
      >
        <Wallet size={15} className={isKeToanSection ? "text-white" : "text-slate-500"} />
        <span className="flex-1 text-left">Kế toán</span>
        <ChevronDown
          size={13}
          className={`transition-transform duration-200 ${keToanGroupOpen || isKeToanSection ? "rotate-180" : ""} ${isKeToanSection ? "text-white" : "text-slate-400"}`}
        />
      </button>

      {(keToanGroupOpen || isKeToanSection) && (
        <div className="pl-5 space-y-1.5 animate-in fade-in duration-150">
          {keToanChildren.map((child) => {
            const ChildIcon = child.icon;
            const isChildActive = pathname === child.href || pathname.startsWith(child.href);
            return (
              <Link
                key={child.href}
                href={child.href}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-2.5 px-4 py-2 rounded-[10px] text-[11px] font-bold transition-all duration-200 active:scale-[0.97] hover:translate-x-1 border ${
                  isChildActive
                    ? "bg-blue-50 border-blue-200 text-[#005BAC]"
                    : "bg-white border-slate-100 text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                }`}
              >
                <ChildIcon size={13} className={isChildActive ? "text-[#005BAC]" : "text-slate-400"} />
                <span>{child.label}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <>
      {navItems.map((item) => {
        const Icon = item.icon;
        let isActive = false;

        if (item.href.includes("?")) {
          const [path, query] = item.href.split("?");
          const urlParams = new URLSearchParams(query);
          const tabParam = urlParams.get("tab");
          const activeTab = currentTab || "system";
          isActive = pathname === path && activeTab === tabParam;
        } else {
          isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href) && !pathname.startsWith("/settings"));
        }

        const linkEl = (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setSidebarOpen(false)}
            className={`flex items-center gap-3 px-5 py-2.5 rounded-[10px] text-xs font-bold transition-all duration-200 active:scale-[0.97] hover:translate-x-1 border ${
              isActive
                ? "bg-gradient-to-r from-[#005BAC] to-[#00AEEF] border-transparent text-white shadow-md shadow-blue-500/15"
                : "bg-slate-50/50 border-slate-100 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <Icon size={15} className={isActive ? "text-white" : "text-slate-500"} />
            <span>{item.label}</span>
          </Link>
        );

        // Mục "Vị trí dự án" hiển thị dưới dạng nhóm "Quản lý dự án" (đã qua lọc gói ở navItems).
        if (item.href === "/vi-tri-du-an") return projectGroup;

        // Mục "P. An toàn lao động" hiển thị dưới dạng nhóm 5 mục con (đã qua lọc gói ở navItems).
        if (item.href === "/an-toan-lao-dong") return atldGroup;

        // Chèn nhóm "Quản lý Đăng ký" ngay sau mục Lịch công việc (nếu gói cho phép)
        if (item.href === "/calendar") {
          return (
            <div key={item.href} className="space-y-2.5">
              {linkEl}
              {canEditPdfLink ? (
                <Link
                  href="/pdf-edit"
                  onClick={() => setSidebarOpen(false)}
                  className={`flex items-center gap-3 px-5 py-2.5 rounded-[10px] text-xs font-bold transition-all duration-200 active:scale-[0.97] hover:translate-x-1 border ${
                    isPdfEditActive
                      ? "bg-gradient-to-r from-[#005BAC] to-[#00AEEF] border-transparent text-white shadow-md shadow-blue-500/15"
                      : "bg-slate-50/50 border-slate-100 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  }`}
                >
                  <FilePen size={15} className={isPdfEditActive ? "text-white" : "text-slate-500"} />
                  <span>PDF edit 1 click</span>
                </Link>
              ) : (
                <a
                  href={pdfEditUrl || "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    if (!pdfEditUrl) {
                      e.preventDefault();
                      alert("Chưa cấu hình link PDF edit 1 click.");
                      return;
                    }
                    setSidebarOpen(false);
                  }}
                  className="flex items-center gap-3 px-5 py-2.5 rounded-[10px] text-xs font-bold transition-all duration-200 active:scale-[0.97] hover:translate-x-1 border bg-slate-50/50 border-slate-100 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                >
                  <FilePen size={15} className="text-slate-500" />
                  <span>PDF edit 1 click</span>
                </a>
              )}
              {bookingAllowed && bookingGroup}
            </div>
          );
        }

        // Chèn nhóm "Kế toán" ngay sau mục "Đề nghị thanh toán" (nếu gói cho phép)
        if (item.href === "/administration") {
          return (
            <div key={item.href} className="space-y-2.5">
              {linkEl}
              {keToanAllowed && keToanGroup}
            </div>
          );
        }

        return linkEl;
      })}
    </>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const { sidebarOpen, setSidebarOpen } = useSidebar();
  const [isApprover, setIsApprover] = useState(false);
  const [isAdminUser, setIsAdminUser] = useState(false); // badge gói chỉ hiện với Admin
  const tenant = useTenantConfig();
  const { plan, planLabel } = usePlan();

  useEffect(() => {
    const fetchUserRole = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session || !session.user) return;
        const email = session.user.email || "";

        // Check Admin
        const { data: allowedData } = await supabase
          .from("allowed_users")
          .select("role")
          .ilike("email", email)
          .maybeSingle();
        const isAdmin = allowedData?.role === "Admin";
        setIsAdminUser(isAdmin);

        // Check Employees — bộ lọc `%X%` thô, chốt bằng khớp email TUYỆT ĐỐI.
        const { data: empRows } = await supabase
          .from("employees_directory")
          .select("name, role, email")
          .ilike("email", `%${email}%`);
        const empData = (empRows || []).find((r) => emailFieldMatches(r.email, email));

        const perms = await fetchApprovalPermissions(email);

        const role = empData?.role || (isAdmin ? "Admin" : "Nhân viên");
        const roleLower = role.toLowerCase();
        const hasApprovalPrivileges =
          isAdmin ||
          // canOpenRequestsInbox: có quyền duyệt HOẶC chỉ có cờ xem toàn bộ đơn
          // (085). Thiếu vế sau thì người HCNS được cấp cờ xem lại không thấy
          // mục "Duyệt yêu cầu" đâu để mà vào xem.
          canOpenRequestsInbox(perms) ||
          isMarketingTeamLeader(empData?.name) ||
          roleLower.includes("tổ trưởng") ||
          roleLower.includes("to truong") ||
          roleLower.includes("trưởng phòng") ||
          roleLower.includes("truong phong") ||
          roleLower.includes("phó phòng") ||
          roleLower.includes("pho phong") ||
          roleLower.includes("phó trưởng phòng") || 
          roleLower.includes("pho truong phong") ||
          roleLower.includes("giám đốc") ||
          roleLower.includes("giam doc") ||
          roleLower.includes("leader");

        setIsApprover(hasApprovalPrivileges);
      } catch (err) {
        console.error("Error checking user approval privileges in sidebar:", err);
      }
    };
    fetchUserRole();
  }, []);

  return (
    <>
      {/* Mobile Backdrop Overlay */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-30 lg:hidden transition-all duration-300"
        />
      )}

      <aside className={`w-60 h-screen flex flex-col fixed left-0 top-0 z-40 bg-white border-r border-slate-200/60 shadow-sm transition-transform duration-300 ease-in-out lg:translate-x-0 ${
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      }`}>
        {/* Brand Logo & Header */}
        <div className="px-6 py-6 border-b border-slate-200/60 relative">
          <div className="flex items-center gap-3">
            <BrandLogo
              className="w-9 h-9 rounded-xl shrink-0"
              tileClassName="bg-gradient-to-br from-blue-600 to-cyan-500 shadow-md shadow-blue-500/25"
              textClassName="text-xs"
            />
            <div className="min-w-0">
              <h1 className="text-[#1D1D1F] font-heading font-bold text-sm tracking-tight leading-tight truncate">{tenant.system_title}</h1>
              <div className="flex items-center gap-1.5 mt-0.5">
                <p className="text-slate-450 text-[10px] uppercase font-bold tracking-wider truncate">{tenant.system_subtitle}</p>
                {isAdminUser && (
                  <span className={`text-[8px] font-extrabold px-1.5 py-0.5 rounded-full uppercase tracking-wider shrink-0 ${
                    plan === "enterprise" ? "bg-indigo-50 text-indigo-600 border border-indigo-100" :
                    plan === "professional" ? "bg-blue-50 text-blue-600 border border-blue-100" :
                    "bg-slate-100 text-slate-500 border border-slate-200"
                  }`} title={`Gói dịch vụ: ${planLabel}`}>
                    {planLabel}
                  </span>
                )}
              </div>
            </div>
            <div className="ml-auto mr-6 lg:mr-0">
              <ThemeToggle />
            </div>
          </div>
          {/* Mobile Close Button */}
          <button 
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden absolute right-4 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-all"
            title="Đóng menu"
          >
            <X size={18} />
          </button>
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 px-4 py-6 space-y-2.5 overflow-y-auto">
          <div className="px-3 mb-3 text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">
            Chức năng chính
          </div>
          <Suspense fallback={<div className="animate-pulse h-10 bg-slate-100 rounded-full" />}>
            <SidebarLinks isApprover={isApprover} pathname={pathname} setSidebarOpen={setSidebarOpen} />
          </Suspense>
        </nav>
      </aside>
    </>
  );
}
