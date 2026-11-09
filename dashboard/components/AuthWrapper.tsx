"use client";

import { useEffect, useState, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { Loader2, ShieldAlert, Lock } from "lucide-react";
import { SidebarProvider } from "./SidebarContext";
import ActivityTracker from "./ActivityTracker";
import BrandLogo from "./BrandLogo";
import { usePathname } from "next/navigation";
import { useTenantConfig } from "@/lib/tenantConfig";
import { normalizePlan, getMinPlanForPath, PLAN_LABELS } from "@/lib/planShared";
import { canAccessPath, resolveEffectivePlan, accessDenialReason } from "@/lib/access";
import { fetchApprovalPermissions, NO_APPROVAL_PERMISSIONS, type ApprovalPermissions } from "@/lib/approvers";
import { emailFieldMatches } from "@/lib/emailMatch";

const MAINTENANCE_FLAG = "hcns_locked_out";
const setMaintenanceFlag = (on: boolean) => {
  try {
    if (on) sessionStorage.setItem(MAINTENANCE_FLAG, "1");
    else sessionStorage.removeItem(MAINTENANCE_FLAG);
  } catch {}
};

export default function AuthWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const tenant = useTenantConfig();
  const isPublicRoute = pathname === "/gop-y" || pathname.startsWith("/gop-y/");

  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [checkingAdmin, setCheckingAdmin] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  // Nút Microsoft mới chỉ là chỗ đặt sẵn, chưa đấu nối nhà cung cấp
  const [msNotice, setMsNotice] = useState(false);
  // Cho GATE GÓI (theo phòng + cấp phép riêng): admin thực sự bỏ qua gate;
  // người khác gate theo gói hiệu lực của phòng + cờ approval_permissions.
  const [strictAdmin, setStrictAdmin] = useState(false);
  const [userDept, setUserDept] = useState<string>("");
  const [userPerms, setUserPerms] = useState<ApprovalPermissions>(NO_APPROVAL_PERMISSIONS);
  
  const lastCheckedEmail = useRef<string | null>(null);
  // Công tắc "Khoá tất cả tài khoản" — màn hình đăng nhập đọc để hiện thông báo
  // bảo trì (anon đọc được khoá này nhờ migration 162).
  // Khoá THEO PHÒNG thì màn hình đăng nhập (chưa biết ai) không tự biết được,
  // nên trước khi đăng xuất ta ghi dấu vào sessionStorage; vào lại được thì xoá.
  const [maintenance, setMaintenance] = useState(false);

  useEffect(() => {
    if (session) return;
    let flagged = false;
    try { flagged = sessionStorage.getItem(MAINTENANCE_FLAG) === "1"; } catch {}
    setMaintenance(flagged);
    supabase
      .from("tenant_config")
      .select("value")
      .eq("key", "lock_all_accounts")
      .maybeSingle()
      .then(({ data }) => setMaintenance(flagged || data?.value === true));
  }, [session]);

  useEffect(() => {
    // 1. Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUserEmail(session?.user?.email || null);
      setLoading(false);
    });

    // 2. Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUserEmail(session?.user?.email || null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session || !userEmail) {
      setIsAdmin(false);
      setAuthError(null);
      lastCheckedEmail.current = null;
      return;
    }

    // Nếu email này đã được kiểm tra thành công và đã được xác nhận quyền Admin,
    // không cần gọi database kiểm tra lại mỗi lần session thay đổi tham chiếu (do tab focus/token refresh).
    if (userEmail === lastCheckedEmail.current && isAdmin) {
      return;
    }

    const checkAdminStatus = async () => {
      setCheckingAdmin(true);
      try {
        // 1. Check allowed_users (Admins / Special Whitelist)
        //    `.ilike("email", "%X%")` chỉ là bộ lọc THÔ ở DB; quyết định cuối cùng
        //    là emailFieldMatches() — khớp email TUYỆT ĐỐI, không phải chuỗi con.
        //    Nếu không, "thanhloc92vn@gmail.com" sẽ lọt vào vì là chuỗi con của
        //    "phamthanhloc92vn@gmail.com".
        const { data: allowedRows, error: allowedError } = await supabase
          .from("allowed_users")
          .select("role, email")
          .ilike("email", `%${userEmail.trim()}%`);

        if (allowedError) {
          console.warn("Error checking allowed_users:", allowedError);
          setAuthError(allowedError.message || JSON.stringify(allowedError));
          setIsAdmin(false);
          return;
        }

        const allowedData = (allowedRows || []).find((r) => emailFieldMatches(r.email, userEmail));

        if (allowedData && allowedData.role === "Admin") {
          setIsAdmin(true);
          setStrictAdmin(true); // admin thực sự -> bỏ qua gate gói
          setMaintenanceFlag(false);
          setAuthError(null);
          lastCheckedEmail.current = userEmail;
          return;
        }

        // 2. Check employees table (If not in allowed_users or not Admin)
        //    Bộ lọc thô + khớp TUYỆT ĐỐI như trên. Bỏ `.maybeSingle()` vì bộ lọc
        //    `%X%` có thể trả nhiều dòng (VD email này là chuỗi con của email khác).
        const { data: empRows, error: empError } = await supabase
          .from("employees_directory")
          .select("role, status, department, email")
          .ilike("email", `%${userEmail.trim()}%`);

        if (empError) {
          console.warn("Error checking employees table:", empError);
          setAuthError(empError.message || JSON.stringify(empError));
          setIsAdmin(false);
          return;
        }

        const empData = (empRows || []).find((r) => emailFieldMatches(r.email, userEmail));

        if (empData) {
          // Công tắc "Khoá tất cả tài khoản" (tenant_config.lock_all_accounts).
          // Đọc thẳng DB, không qua cache useTenantConfig, để Admin vừa bật là
          // lần đăng nhập/tải trang kế tiếp đã bị chặn. Đọc lỗi -> coi như tắt.
          // Kèm khoá theo phòng (locked_departments, khớp đúng employees.department).
          const { data: lockRows } = await supabase
            .from("tenant_config")
            .select("key, value")
            .in("key", ["lock_all_accounts", "locked_departments"]);
          const lockAllOn = (lockRows || []).some(r => r.key === "lock_all_accounts" && r.value === true);
          const lockedDepts = (lockRows || []).find(r => r.key === "locked_departments")?.value;
          const deptLocked = Array.isArray(lockedDepts) && !!empData.department && lockedDepts.includes(empData.department);
          // Đang khoá -> đăng xuất hẳn, đưa về màn hình đăng nhập (ở đó hiện
          // thông báo "Hệ thống đang bảo trì").
          if (lockAllOn || deptLocked) {
            setMaintenanceFlag(true);
            setIsAdmin(false);
            await supabase.auth.signOut();
            return;
          }
          setMaintenanceFlag(false);

          const statusLower = (empData.status || "").toLowerCase().trim();
          if (statusLower.includes("nghỉ việc") || statusLower.includes("nghi viec")) {
            setAuthError("Tài khoản của bạn đã ở trạng thái Nghỉ việc và bị khóa quyền truy cập hệ thống. Vui lòng liên hệ Phòng HCNS.");
            setIsAdmin(false);
            return;
          }

          // Active employee -> allow login
          setIsAdmin(true);
          setStrictAdmin(false);
          setUserDept(empData.department || "");
          setUserPerms(await fetchApprovalPermissions(userEmail.trim()));
          setAuthError(null);
          lastCheckedEmail.current = userEmail;
        } else {
          setAuthError("Tài khoản chưa được cấp phép. Vui lòng liên hệ phòng HCNS.");
          setIsAdmin(false);
        }
      } catch (err: any) {
        console.error("Error checking admin status:", err);
        setAuthError(err?.message || String(err));
        setIsAdmin(false);
      } finally {
        setCheckingAdmin(false);
      }
    };

    checkAdminStatus();
  }, [session, userEmail, isAdmin]);

  const handleLogin = async () => {
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: typeof window !== "undefined" ? window.location.origin : "",
        },
      });
      if (error) throw error;
    } catch (err) {
      console.error("Login error:", err);
      alert("Lỗi khi đăng nhập bằng Google!");
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  if (isPublicRoute) {
    return <>{children}</>;
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#F7F9FC] text-slate-500 gap-3">
        <Loader2 className="animate-spin text-[#005BAC]" size={36} />
        <p className="text-xs font-semibold">Đang kiểm tra trạng thái đăng nhập...</p>
      </div>
    );
  }

  // 1. Not Logged In -> Show Login Page
  if (!session) {
    return (
      <div className="relative flex items-center justify-center min-h-screen bg-[#060A16] overflow-hidden px-4 py-10">
        {/* Nền: các dải sáng xanh thương hiệu chạy chéo, làm mờ sâu */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -top-1/4 -left-1/4 w-[150%] h-[45%] rotate-[-16deg] blur-[70px] bg-[linear-gradient(90deg,transparent,rgba(0,91,172,0.85),rgba(0,174,239,0.55),transparent)]" />
          <div className="absolute top-[38%] -right-1/3 w-[140%] h-[30%] rotate-[12deg] blur-[60px] bg-[linear-gradient(90deg,transparent,rgba(0,174,239,0.7),rgba(125,211,252,0.45),transparent)]" />
          <div className="absolute -bottom-[15%] -left-1/4 w-[150%] h-[40%] rotate-[-9deg] blur-[80px] bg-[linear-gradient(90deg,transparent,rgba(30,64,175,0.8),rgba(0,91,172,0.5),transparent)]" />
          {/* Hai vệt sáng mảnh cho cảm giác kim loại bóng */}
          <div className="absolute top-[30%] -left-[10%] w-[120%] h-[2px] rotate-[-15deg] blur-[2px] bg-[linear-gradient(90deg,transparent,rgba(125,211,252,0.6),transparent)]" />
          <div className="absolute bottom-[26%] -left-[10%] w-[120%] h-px rotate-[-9deg] blur-[1px] bg-[linear-gradient(90deg,transparent,rgba(0,174,239,0.5),transparent)]" />
          {/* Tối 4 góc để khối kính nổi lên */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_18%,rgba(6,10,22,0.82)_78%)]" />
        </div>

        <div className="relative w-full max-w-[34rem]">
          {/* Khối kính chính */}
          <div className="relative overflow-hidden rounded-[2.25rem] border border-white/15 bg-white/[0.07] backdrop-blur-2xl shadow-[0_30px_70px_-20px_rgba(0,91,172,0.55)] px-7 py-10 sm:px-12">
            {/* Vệt sáng chạy dọc viền trên */}
            <div className="pointer-events-none absolute inset-x-12 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
            {/* Hai góc kính trang trí */}
            <div className="pointer-events-none absolute top-4 left-4 w-11 h-11 rounded-tl-[1.4rem] border-t border-l border-white/25" />
            <div className="pointer-events-none absolute bottom-4 right-4 w-11 h-11 rounded-br-[1.4rem] border-b border-r border-white/25" />

            <div className="relative flex flex-col items-center text-center">
              {/* Logo công ty (đọc từ tenant_config, fallback TNEC) */}
              <BrandLogo
                className="w-16 h-16 rounded-2xl ring-4 ring-[#00AEEF]/15"
                tileClassName="bg-gradient-to-br from-[#005BAC] to-[#00AEEF] shadow-lg"
                textClassName="text-2xl"
              />

              <h1 className="mt-6 font-heading font-extrabold text-[1.65rem] leading-tight tracking-tight text-white">
                Chào mừng <span className="text-[#00AEEF]">trở lại</span>
              </h1>
              <p className="mt-3 text-[#00AEEF] text-[0.78rem] sm:text-sm font-extrabold uppercase tracking-[0.1em] sm:tracking-[0.14em] leading-snug">
                {tenant.login_subtitle}
              </p>

              {maintenance && (
                <p className="mt-6 w-full rounded-xl border border-red-800 bg-red-700 px-3 py-2.5 text-[0.75rem] font-bold leading-relaxed text-white">
                  Hệ thống đang bảo trì. Vui lòng quay lại sau.
                </p>
              )}

              {/* Gạch ngăn */}
              <div className="mt-8 mb-5 w-full flex items-center gap-3">
                <div className="h-px flex-1 bg-white/15" />
                <span className="text-[0.6rem] font-bold uppercase tracking-[0.2em] text-slate-400">
                  Tiếp tục với
                </span>
                <div className="h-px flex-1 bg-white/15" />
              </div>

              {/* Hai nút đăng nhập */}
              <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  onClick={handleLogin}
                  className="group flex items-center justify-center gap-2.5 rounded-2xl border border-white/80 bg-[#FFFFFF] px-3 py-3.5 text-[#0F172A] shadow-xl transition-all hover:shadow-[0_12px_30px_-10px_rgba(0,174,239,0.6)] active:scale-[0.97] cursor-pointer"
                >
                  {/* Google Icon */}
                  <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24">
                    <path
                      fill="#EA4335"
                      d="M12 5.04c1.66 0 3.2.57 4.38 1.69l3.27-3.27C17.67 1.48 14.97 1 12 1 7.37 1 3.42 3.66 1.5 7.57l3.92 3.04c.92-2.76 3.51-4.57 6.58-4.57z"
                    />
                    <path
                      fill="#4285F4"
                      d="M23.49 12.27c0-.81-.07-1.59-.2-2.34H12v4.44h6.44c-.28 1.48-1.12 2.73-2.38 3.58l3.7 2.87c2.16-1.99 3.43-4.91 3.43-8.55z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.42 15.35A7.14 7.14 0 0 1 5 12c0-1.18.2-2.31.57-3.37L1.65 5.59A11.96 11.96 0 0 0 0 12c0 2.45.62 4.76 1.7 6.81l3.72-3.46z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c3.24 0 5.97-1.07 7.96-2.91l-3.7-2.87c-1.03.69-2.34 1.1-4.26 1.1-3.07 0-5.66-1.81-6.58-4.57L1.5 16.79C3.42 20.34 7.37 23 12 23z"
                    />
                  </svg>
                  <span className="text-[0.72rem] font-bold whitespace-nowrap">Đăng nhập bằng Google</span>
                </button>

                <button
                  onClick={() => setMsNotice(true)}
                  className="group relative flex items-center justify-center gap-2.5 rounded-2xl border border-white/80 bg-[#FFFFFF] px-3 py-3.5 text-[#0F172A] shadow-xl opacity-60 transition-all hover:opacity-80 active:scale-[0.97] cursor-pointer"
                >
                  <span className="absolute -top-1.5 right-2 rounded-full bg-[#00AEEF] px-1.5 py-0.5 text-[0.5rem] font-bold uppercase tracking-wider text-white shadow">
                    Sắp có
                  </span>
                  {/* Microsoft Icon */}
                  <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24">
                    <path fill="#F25022" d="M2 2h9.2v9.2H2z" />
                    <path fill="#7FBA00" d="M12.8 2H22v9.2h-9.2z" />
                    <path fill="#00A4EF" d="M2 12.8h9.2V22H2z" />
                    <path fill="#FFB900" d="M12.8 12.8H22V22h-9.2z" />
                  </svg>
                  <span className="text-[0.72rem] font-bold whitespace-nowrap">Đăng nhập bằng Microsoft</span>
                </button>
              </div>

              {msNotice && (
                <p className="mt-4 w-full rounded-xl border border-[#00AEEF]/25 bg-[#00AEEF]/10 px-3 py-2.5 text-[0.7rem] font-semibold leading-relaxed text-[#7FD8F7]">
                  Đăng nhập bằng tài khoản Microsoft đang được chuẩn bị. Hiện tại vui lòng dùng tài khoản Google.
                </p>
              )}

              <p className="mt-7 text-[0.68rem] leading-relaxed text-slate-400/80 font-medium">
                Tài khoản đã cấp quyền mới vào được hệ thống
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 2. Logged In, but checking allowed list
  if (checkingAdmin) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#F7F9FC] text-slate-500 gap-3">
        <Loader2 className="animate-spin text-[#005BAC]" size={36} />
        <p className="text-xs font-semibold">Đang kiểm tra quyền truy cập hệ thống...</p>
      </div>
    );
  }

  // 3. Logged in but NOT Admin (not in allowed list)
  if (!isAdmin) {
    return (
      <div className="relative flex items-center justify-center min-h-screen bg-[#090D1A] overflow-hidden">
        {/* Glow Spheres */}
        <div className="absolute top-1/4 left-1/4 w-[350px] h-[350px] bg-rose-600/5 rounded-full blur-[120px] pointer-events-none" />

        <div className="relative max-w-md w-full mx-4 p-10 bg-slate-900/80 border border-slate-800 rounded-[2rem] shadow-2xl flex flex-col items-center text-center space-y-6 backdrop-blur-xl">
          <div className="w-16 h-16 rounded-2xl bg-rose-500/10 flex items-center justify-center text-rose-500 shadow-md ring-4 ring-rose-500/5">
            <ShieldAlert size={32} />
          </div>

          <div className="space-y-2">
            <h2 className="text-white font-heading font-extrabold text-base">Từ chối truy cập</h2>
            <p className="text-rose-400 font-mono text-xs font-semibold bg-rose-950/30 px-3 py-1 rounded-xl border border-rose-900/20 truncate max-w-[280px]" title={userEmail || undefined}>
              {userEmail}
            </p>
          </div>

          <p className="text-slate-350 text-xs leading-relaxed px-2 font-medium">
            Tài khoản Google của bạn hiện **chưa có quyền** truy cập hệ thống quản trị này. Vui lòng liên hệ với ban nhân sự hoặc Quản trị viên để được phê duyệt email của bạn.
          </p>

          {authError && (
            <div className="text-[11px] text-rose-300 font-mono max-w-full break-all bg-rose-950/20 p-3 rounded-xl border border-rose-900/30 text-left mt-2">
              <span className="font-bold text-rose-400 block mb-0.5">Chi tiết lỗi (Debug):</span>
              {authError}
            </div>
          )}

          <div className="flex flex-col w-full pt-4">
            <button
              onClick={handleLogout}
              className="w-full bg-slate-800 hover:bg-slate-750 text-white text-xs font-bold py-3.5 rounded-2xl transition-all cursor-pointer hover:scale-[1.01] active:scale-[0.99]"
            >
              Đăng xuất & Thử tài khoản khác
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 4. Kiểm tra GÓI DỊCH VỤ: module ngoài gói -> màn hình nâng cấp
  // (chặn cả truy cập thẳng URL, không chỉ ẩn menu). Gói hiệu lực tính theo
  // PHÒNG của user (min với trần tenant) + cấp phép riêng qua approval_permissions.
  // department_plans null -> effectivePlan = tenant.plan (hành vi cũ, không khoá nhầm).
  const activePlan = normalizePlan(tenant.plan);
  const effectivePlan = resolveEffectivePlan(activePlan, userDept, tenant.department_plans);
  const accessUser = { isAdmin: strictAdmin, tenantPlan: activePlan, effectivePlan, perms: userPerms };
  if (!canAccessPath(accessUser, pathname)) {
    const minPlan = getMinPlanForPath(pathname);
    // Bị chặn vì THIẾU CỜ (gói đã đủ) thì phải nói đúng vậy — nếu dùng chung câu
    // "cần nâng gói" thì người ở phòng Enterprise sẽ đọc được một câu vô nghĩa.
    const deniedByFlag = accessDenialReason(accessUser, pathname) === "flag";
    return (
      <SidebarProvider>
        <div className="flex flex-col items-center justify-center min-h-screen bg-[#F7F9FC] px-4">
          <div className="max-w-md w-full bg-white border border-slate-200/60 rounded-[2rem] shadow-premium p-10 flex flex-col items-center text-center space-y-5">
            <div className="w-16 h-16 rounded-2xl bg-amber-50 flex items-center justify-center text-amber-500 ring-4 ring-amber-100/50">
              <Lock size={30} />
            </div>
            <div className="space-y-2">
              <h2 className="font-heading font-extrabold text-slate-800 text-base">
                {deniedByFlag ? "Bạn chưa được cấp quyền vào module này" : `Tính năng thuộc gói ${PLAN_LABELS[minPlan]}`}
              </h2>
              <p className="text-slate-500 text-xs leading-relaxed font-medium">
                {deniedByFlag ? (
                  <>
                    Module này chỉ mở cho những tài khoản được Quản trị viên chỉ định
                    riêng — gói dịch vụ của phòng không tự mở. Vui lòng liên hệ Quản trị
                    viên nếu bạn cần truy cập.
                  </>
                ) : (
                  <>
                    Phòng của bạn đang ở gói <strong>{PLAN_LABELS[effectivePlan]}</strong>.
                    Module này chỉ khả dụng từ gói <strong>{PLAN_LABELS[minPlan]}</strong> trở lên —
                    vui lòng liên hệ Quản trị viên để được cấp quyền.
                  </>
                )}
              </p>
            </div>
            <a
              href="/"
              className="w-full bg-[#005BAC] hover:bg-blue-700 text-white text-xs font-bold py-3.5 rounded-2xl transition-all"
            >
              Về trang Dashboard
            </a>
          </div>
        </div>
      </SidebarProvider>
    );
  }

  // 5. Logged in & Is Admin & đúng gói -> Render dashboard
  // ActivityTracker chỉ gắn ở nhánh này (đã qua đăng nhập + đúng gói) nên chỉ
  // đếm lượt mở module THẬT, không đếm màn hình đăng nhập/từ chối/nâng gói.
  return (
    <SidebarProvider>
      <ActivityTracker />
      {children}
    </SidebarProvider>
  );
}
