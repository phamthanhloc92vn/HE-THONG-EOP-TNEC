"use client";

import { apiFetch } from "@/lib/apiClient";
import { useState, useEffect, useMemo, useCallback, Suspense } from "react";
import Sidebar from "@/components/Sidebar";
import Header from "@/components/Header";
import { Settings, Database, Info, Key, CheckCircle, ShieldAlert, ShieldCheck, Check, X, Calendar, Briefcase, User, CarFront, DoorOpen, Mail, Package, Users, CalendarClock, ChevronRight, AlertCircle, BarChart3, FolderKanban, Building2, Trash2 } from "lucide-react";
import UserPermissionsModal, { type UserPermissionsTab } from "@/components/UserPermissionsModal";
import UsageReportPanel from "@/components/UsageReportPanel";
import ProjectCatalogPanel from "@/components/ProjectCatalogPanel";
import AvatarUploadCard from "@/components/AvatarUploadCard";
import PrivacyPolicyPanel from "@/components/PrivacyPolicyPanel";
import { usePrivacyPolicy } from "@/lib/usePrivacyPolicy";
import { supabase } from "@/lib/supabase";
import { usePlan } from "@/lib/plan";
import { PLAN_LABELS, type Plan } from "@/lib/planShared";
import { useDepartments, invalidateDepartments } from "@/lib/departments";
import { useTenantConfig, invalidateTenantConfig, bookingSkipCap1Of } from "@/lib/tenantConfig";
import {
  hasAnyApprovalPermission,
  canOpenRequestsInbox,
  isMarketingTeamLeader,
  isBookingCap1Approver,
  getRequestStage,
  isJustificationCap1Approver,
  resolveJustificationApproverName,
  isLeaveTripCap1Approver,
  isLeaveTripCap2Approver,
  fetchCap2Availability,
  fetchCap2ApproverEmails,
  CAP2_UNKNOWN,
  normalizeName,
} from "@/lib/approvers";
import { finalizeLeaveTripApproval } from "@/lib/requestApproval";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { isDirectorRole } from "@/lib/access";
import { useNoticeBox, useConfirmBox, usePromptBox } from "@/components/ConfirmDialog";
import { useSearchParams } from "next/navigation";
import { resolveModel, DEFAULT_AI_MODEL, AI_MODEL_OPTIONS } from "@/lib/aiModel";

/**
 * Đơn có "chạm" vào tháng đang lọc hay không (month dạng "YYYY-MM").
 * Tính theo KHOẢNG chứ không theo một mốc: đơn nghỉ 30/09 đến 02/10 phải hiện ở
 * cả tháng 9 lẫn tháng 10, chọn tháng nào cũng thấy.
 * month rỗng = xem tất cả các tháng.
 */
const taskOverlapsMonth = (t: any, month: string): boolean => {
  if (!month) return true;
  const start = t.start_date || t.due_date;
  const end = t.due_date || t.start_date;
  // Đơn không có ngày nào thì không thuộc tháng nào — lọc theo tháng bỏ qua nó.
  if (!start || !end) return false;
  return start.slice(0, 7) <= month && end.slice(0, 7) >= month;
};

function SettingsContent() {
  const searchParams = useSearchParams();
  const activeTab = searchParams.get("tab") || "system";
  const isApprovalsTab = activeTab === "approvals";
  // Tab "Đo lường sử dụng" — chỉ Admin. Bản thân UsageReportPanel tự chặn quyền,
  // và 2 hàm RPC nó gọi cũng chặn độc lập ở tầng DB.
  const isUsageTab = activeTab === "usage";
  // Tab "Danh mục công việc" — dự án (mã + tên), nhóm và nguồn công việc nuôi
  // form giao việc. Chỉ Admin; ProjectCatalogPanel tự chặn quyền, RLS của
  // migration 037 chặn thêm một tầng nữa ở DB.
  const isCatalogTab = activeTab === "danh-muc";
  // Tab "Chính sách bảo mật" — MỌI tài khoản đọc được và bấm "Tôi đã đọc".
  const isPrivacyTab = activeTab === "privacy";
  const { plan: activePlan } = usePlan();
  const [changingPlan, setChangingPlan] = useState(false);

  // Đổi gói dịch vụ (chỉ Admin — RLS tenant_config cũng chặn tầng DB).
  // Ghi vào tenant_config.plan rồi tải lại trang để mọi nơi đọc gói mới.
  const handleChangePlan = async (newPlan: Plan) => {
    if (newPlan === activePlan) return;
    ask({
      title: `Chuyển hệ thống sang gói ${PLAN_LABELS[newPlan]}?`,
      message: "Menu và tính năng sẽ thay đổi theo gói ngay sau khi tải lại.",
      confirmLabel: "Đổi gói",
      tone: "normal",
      onConfirm: async () => {
        try {
          setChangingPlan(true);
          const { error } = await supabase
            .from("tenant_config")
            .update({ value: newPlan })
            .eq("key", "plan");
          if (error) throw error;
          window.location.reload();
        } catch (err: any) {
          notify("Không đổi được gói dịch vụ: " + (err.message || err) + "\n(Chỉ tài khoản Admin mới có quyền này.)", "error");
          setChangingPlan(false);
        }
      },
    });
  };

  // ─── PHÂN GÓI THEO PHÒNG BAN (quyền nội bộ) ───
  // Ghi vào tenant_config.department_plans (jsonb). null/rỗng = chưa bật, mọi
  // người dùng chung `plan`. Có giá trị -> gói mỗi user = min(plan, gói phòng).
  const deptLists = useDepartments();
  const tenantCfg = useTenantConfig();
  const [deptPlansDraft, setDeptPlansDraft] = useState<Record<string, Plan>>({});
  const [deptPlansEnabled, setDeptPlansEnabled] = useState(false);
  const [savingDeptPlans, setSavingDeptPlans] = useState(false);

  useEffect(() => {
    setSkipXe(bookingSkipCap1Of(tenantCfg, "xe"));
    setSkipPhongHop(bookingSkipCap1Of(tenantCfg, "phong_hop"));
  }, [tenantCfg]);

  // Bật/tắt bước duyệt cấp 1 của đăng ký xe / phòng họp. Ghi vào tenant_config
  // (RLS chỉ cho Admin), xoá cache rồi tải lại để mọi trang đọc giá trị mới.
  //
  // CHẶN bật khi không còn ai giữ cờ "Duyệt đăng ký xe / phòng họp": bỏ cấp 1 mà
  // cấp điều phối cũng trống thì đơn gửi lên không còn ai xử lý ngoài Admin.
  const handleToggleBookingFlow = async (bookingType: "xe" | "phong_hop") => {
    const isXe = bookingType === "xe";
    const label = isXe ? "đăng ký xe" : "đăng ký phòng họp";
    const next = !(isXe ? skipXe : skipPhongHop);
    if (next) {
      const dispatchers = await fetchCap2ApproverEmails("booking");
      if (dispatchers === null) {
        notify("Không đọc được danh sách người điều phối. Kiểm tra kết nối mạng rồi thử lại.", "error");
        return;
      }
      if (!dispatchers) {
        notify("Chưa có ai giữ cờ \"Duyệt đăng ký xe / phòng họp\". Cấp cờ đó cho nhân sự điều phối trước, nếu không đơn gửi lên sẽ không còn ai xử lý.", "error");
        return;
      }
    }
    setSavingBookingFlow(bookingType);
    try {
      const { error } = await supabase
        .from("tenant_config")
        .upsert(
          {
            key: isXe ? "booking_skip_cap1_xe" : "booking_skip_cap1_phong_hop",
            value: next,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "key" }
        );
      if (error) throw error;
      // Khoá CŨ `booking_skip_cap1` (một công tắc cho cả hai loại) đè lên cả hai:
      // còn bật thì tắt một loại riêng lẻ sẽ không có tác dụng. Tắt nó đi và ghi
      // lại giá trị hiện hành của loại kia để không đổi hành vi của loại đó.
      if (tenantCfg.booking_skip_cap1) {
        await supabase.from("tenant_config").upsert([
          { key: "booking_skip_cap1", value: false, updated_at: new Date().toISOString() },
          {
            key: isXe ? "booking_skip_cap1_phong_hop" : "booking_skip_cap1_xe",
            value: isXe ? skipPhongHop : skipXe,
            updated_at: new Date().toISOString(),
          },
        ], { onConflict: "key" });
      }
      invalidateTenantConfig();
      if (isXe) setSkipXe(next); else setSkipPhongHop(next);
      // Cấu hình được cache ở tầng module trong TỪNG tab trình duyệt: người đang
      // mở sẵn trang Đăng ký vẫn chạy luồng cũ cho tới khi họ tải lại.
      notify(
        (next
          ? `Đã bỏ bước Trưởng phòng cho ${label}. Từ giờ đơn loại này gửi thẳng tới người điều phối.`
          : `Đã bật lại bước Trưởng phòng cho ${label}.`) +
        "\nAi đang mở sẵn trang Đăng ký cần tải lại (F5) mới thấy luồng mới.",
        "success"
      );
    } catch (err: any) {
      notify("Không lưu được thiết lập: " + (err?.message || err) + "\n(Chỉ tài khoản Admin mới đổi được.)", "error");
    } finally {
      setSavingBookingFlow(null);
    }
  };

  useEffect(() => {
    const dp = tenantCfg.department_plans;
    if (dp && Object.keys(dp).length > 0) {
      setDeptPlansEnabled(true);
      setDeptPlansDraft({ ...(dp as Record<string, Plan>) });
    } else {
      setDeptPlansEnabled(false);
      setDeptPlansDraft({});
    }
  }, [tenantCfg.department_plans]);

  const setDeptPlan = (key: string, plan: Plan) => {
    setDeptPlansDraft(prev => ({ ...prev, [key]: plan }));
  };

  const saveDeptPlans = async (payload: Record<string, Plan> | null) => {
    try {
      setSavingDeptPlans(true);
      const { error } = await supabase
        .from("tenant_config")
        .upsert({ key: "department_plans", value: payload }, { onConflict: "key" });
      if (error) throw error;
      window.location.reload();
    } catch (err: any) {
      notify("Không lưu được phân gói theo phòng: " + (err.message || err) + "\n(Chỉ Admin mới có quyền này.)", "error");
      setSavingDeptPlans(false);
    }
  };

  // Mặc định khi bật lần đầu: Ban Lãnh Đạo -> enterprise, HCNS -> professional,
  // còn lại (_default) -> basic. Admin chỉnh tiếp trước khi lưu.
  const handleEnableDeptPlans = () => {
    const seed: Record<string, Plan> = { _default: "basic" };
    for (const d of deptLists.all) {
      const dl = d.toLowerCase();
      if (dl.includes("lãnh đạo") || dl.includes("giám đốc")) seed[d] = "enterprise";
      else if (dl.includes("hành chính") || dl.includes("nhân sự")) seed[d] = "professional";
    }
    setDeptPlansDraft(seed);
    setDeptPlansEnabled(true);
  };

  // 1 dòng phòng ban: tên + bộ chọn gói dạng segmented (Basic/Pro/Enter).
  const renderDeptPlanRow = (key: string, label: string, muted = false) => {
    const cur: Plan = deptPlansDraft[key] || (key === "_default" ? "basic" : deptPlansDraft["_default"] || "basic");
    return (
      <div key={key} className={`flex items-center justify-between gap-2 bg-white border rounded-xl pl-3.5 pr-1.5 py-2 transition-all shadow-sm ${selectedDept === key ? "border-rose-300" : "border-slate-200/70 hover:border-slate-300"}`}>
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            onClick={() => { if (key !== "_default") setSelectedDept(selectedDept === key ? null : key); }}
            className={`text-[11px] font-bold truncate text-left ${muted ? "text-slate-400 italic" : "text-slate-700"} ${key !== "_default" ? "cursor-pointer hover:text-[#005BAC]" : ""}`}
            title={key !== "_default" ? `${label} — bấm để hiện nút xoá` : label}
          >
            {label}
          </button>
          {selectedDept === key && (
            <button
              type="button"
              onClick={() => handleDeleteDept(key)}
              disabled={deletingDept}
              className="shrink-0 flex items-center gap-1 text-[9px] font-extrabold text-white bg-rose-500 hover:bg-rose-600 disabled:opacity-50 px-2 py-1 rounded-md cursor-pointer transition-all"
              title="Xoá phòng này khỏi danh sách"
            >
              <Trash2 size={11} /> {deletingDept ? "…" : "Xoá"}
            </button>
          )}
        </div>
        <div className="flex gap-0.5 shrink-0 bg-slate-100 p-0.5 rounded-lg">
          {(["basic", "professional", "enterprise"] as Plan[]).map(pl => {
            const active = cur === pl;
            const activeCls = pl === "basic" ? "bg-slate-600 text-white" : pl === "professional" ? "bg-[#005BAC] text-white" : "bg-indigo-600 text-white";
            return (
              <button
                key={pl}
                onClick={() => setDeptPlan(key, pl)}
                className={`text-[9px] font-extrabold px-2 py-1 rounded-md uppercase tracking-wide transition-all cursor-pointer ${active ? `${activeCls} shadow-sm` : "text-slate-400 hover:text-slate-600"}`}
              >
                {pl === "basic" ? "Basic" : pl === "professional" ? "Pro" : "Enter"}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const [apiKey, setApiKey] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [model, setModel] = useState(DEFAULT_AI_MODEL);
  const [saved, setSaved] = useState(false);

  // Approvals States
  // Danh tính người dùng — hook chung (thay khối allowed_users + employees +
  // fetchApprovalPermissions từng copy-paste ở mỗi trang).
  const user = useCurrentUser();
  const currentUser = user.authenticated ? user : null;
  const approvalPerms = user.perms;
  // Đã bấm "Tôi đã đọc" chính sách bảo mật phiên bản hiện hành chưa (null = chưa biết).
  // Chỉ để hiện nhãn ở thẻ lối vào; lỗi đọc thì không hiện nhãn, không chặn gì.
  const privacyPolicy = usePrivacyPolicy();
  const [privacyAcked, setPrivacyAcked] = useState<boolean | null>(null);
  useEffect(() => {
    if (!user.authenticated || !user.email || privacyPolicy.loading) return;
    setPrivacyAcked(null);
    let mounted = true;
    supabase
      .from("privacy_policy_acks")
      .select("policy_version")
      .eq("email", user.email.trim().toLowerCase())
      .eq("policy_version", privacyPolicy.version)
      .maybeSingle()
      .then(({ data, error }) => {
        if (mounted && !error) setPrivacyAcked(!!data);
      });
    return () => { mounted = false; };
  }, [user.authenticated, user.email, privacyPolicy.loading, privacyPolicy.version]);
  // Hộp thông báo căn GIỮA màn hình — thay window.alert() (dính mép trên, hiện tên
  // miền, không theo giao diện chung). Dùng chung mẫu với trang Lịch/Báo cáo.
  const { notify, noticeNode } = useNoticeBox();
  // Hộp hỏi "có chắc không" + hộp nhập lý do — cùng mẫu căn giữa, thay confirm()/prompt().
  const { ask, confirmNode } = useConfirmBox();
  const { askText, promptNode } = usePromptBox();

  // ─── Tạo phòng ban / BĐH mới (chỉ Admin; RLS admin_write_departments chặn ở DB) ───
  const [newDeptName, setNewDeptName] = useState("");
  const [newDeptType, setNewDeptType] = useState<"phong_ban" | "bdh">("phong_ban");
  const [creatingDept, setCreatingDept] = useState(false);
  const handleCreateDept = async () => {
    const name = newDeptName.trim().replace(/\s+/g, " ");
    if (!name || creatingDept) return;
    const typeLabel = newDeptType === "bdh" ? "Ban điều hành" : "Phòng ban";
    if (deptLists.all.some(d => d.toLowerCase() === name.toLowerCase())) {
      notify(`"${name}" đã có trong danh sách.`, "warn");
      return;
    }
    setCreatingDept(true);
    try {
      // Xếp cuối nhóm: sort_order lớn nhất cùng loại + 10
      const { data: last } = await supabase
        .from("departments")
        .select("sort_order")
        .eq("type", newDeptType)
        .order("sort_order", { ascending: false })
        .limit(1);
      const sortOrder = ((last?.[0]?.sort_order as number | undefined) ?? 0) + 10;

      const { data, error } = await supabase
        .from("departments")
        .insert({ name, type: newDeptType, sort_order: sortOrder, active: true })
        .select("id");
      if (error) {
        const msg = error.code === "23505"
          ? `"${name}" đã tồn tại (có thể đang bị ẩn — active = false).`
          : error.message;
        notify(`Không tạo được ${typeLabel.toLowerCase()}: ${msg}`, "error");
        return;
      }
      // RLS chặn INSERT có thể trả 0 dòng thay vì lỗi
      if (!data || data.length === 0) {
        notify("Không tạo được — chỉ tài khoản Admin mới có quyền này.", "error");
        return;
      }
      await invalidateDepartments();
      setNewDeptName("");
      notify(`Đã tạo ${typeLabel.toLowerCase()} "${name}".`, "success");
    } finally {
      setCreatingDept(false);
    }
  };
  // ─── Xoá phòng ban / BĐH (chỉ Admin): bấm tên phòng để hiện nút Xoá ───
  const [selectedDept, setSelectedDept] = useState<string | null>(null);
  const [deletingDept, setDeletingDept] = useState(false);
  const handleDeleteDept = (name: string) => {
    ask({
      title: `Xoá "${name}"?`,
      message: "Phòng sẽ biến mất khỏi mọi danh sách chọn phòng ban. Không hoàn tác được.",
      confirmLabel: "Xoá",
      onConfirm: async () => {
        setDeletingDept(true);
        try {
          // Còn nhân viên thuộc phòng thì không cho xoá — tránh NV mồ côi phòng
          const { count, error: cntErr } = await supabase
            .from("employees")
            .select("id", { count: "exact", head: true })
            .eq("department", name);
          if (cntErr) {
            notify("Không kiểm tra được nhân viên của phòng: " + cntErr.message, "error");
            return;
          }
          if ((count ?? 0) > 0) {
            notify(`"${name}" còn ${count} nhân viên. Chuyển họ sang phòng khác ở Danh sách nhân viên rồi mới xoá được.`, "warn");
            return;
          }
          const { data, error } = await supabase
            .from("departments")
            .delete()
            .eq("name", name)
            .select("id");
          if (error) {
            notify("Không xoá được: " + error.message, "error");
            return;
          }
          // RLS chặn DELETE trả 0 dòng thay vì lỗi
          if (!data || data.length === 0) {
            notify("Không xoá được — chỉ tài khoản Admin mới có quyền này.", "error");
            return;
          }
          setSelectedDept(null);
          await invalidateDepartments();
          notify(`Đã xoá "${name}".`, "success");
        } finally {
          setDeletingDept(false);
        }
      },
    });
  };

  const createDeptForm = (
    <div className="rounded-2xl border border-dashed border-blue-200 bg-blue-50/30 p-3 space-y-2">
      <p className="text-[10px] font-black text-[#005BAC] uppercase tracking-wider">
        Tạo phòng ban / Ban điều hành mới
      </p>
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={newDeptType}
          onChange={e => setNewDeptType(e.target.value as "phong_ban" | "bdh")}
          className="text-[11px] font-bold text-slate-700 bg-white border border-slate-200 rounded-xl px-3 py-2 outline-none focus:border-blue-400 cursor-pointer"
        >
          <option value="phong_ban">Phòng ban chức năng</option>
          <option value="bdh">Ban điều hành dự án</option>
        </select>
        <input
          value={newDeptName}
          onChange={e => setNewDeptName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") handleCreateDept(); }}
          placeholder={newDeptType === "bdh" ? "VD: BĐH Cầu Rạch Miễu" : "VD: Phòng Pháp Chế"}
          className="flex-1 min-w-0 text-[11px] font-semibold text-slate-700 bg-white border border-slate-200 rounded-xl px-3 py-2 outline-none focus:border-blue-400"
        />
        <button
          onClick={handleCreateDept}
          disabled={creatingDept || !newDeptName.trim()}
          className="text-[11px] font-bold text-white bg-[#005BAC] hover:bg-blue-700 disabled:opacity-50 px-4 py-2 rounded-xl transition-all cursor-pointer shadow-sm shrink-0"
        >
          {creatingDept ? "Đang tạo…" : "+ Tạo mới"}
        </button>
      </div>
    </div>
  );

  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  // Mỗi luồng còn cấp 2 (duyệt cuối HCNS) hay không — suy từ việc CÓ AI đang giữ cờ
  // duyệt cuối tương ứng. Không ai giữ -> luồng 1 cấp: cấp 1 duyệt là đơn xong luôn.
  // Chỉ dùng để hiện đúng nhãn nút/badge; lúc bấm duyệt thật thì đọc lại DB.
  const [cap2Enabled, setCap2Enabled] = useState(CAP2_UNKNOWN);
  // Công tắc BỎ CẤP 1 của đăng ký — TÁCH RIÊNG từng loại: xe và phòng họp do người
  // khác điều phối nên bật/tắt độc lập. Bật: đơn loại đó gửi thẳng tới người điều
  // phối, không qua Trưởng phòng.
  const [skipXe, setSkipXe] = useState(false);
  const [skipPhongHop, setSkipPhongHop] = useState(false);
  // Đang lưu công tắc nào ("xe" | "phong_hop" | null) — để chỉ khoá đúng ô đang bấm
  const [savingBookingFlow, setSavingBookingFlow] = useState<null | "xe" | "phong_hop">(null);
  // Tra nhanh theo loại của MỘT đơn cụ thể (cột booking_type: "xe" | "phong_hop")
  const skipCap1For = useCallback(
    (bookingType?: string | null) => (bookingType === "xe" ? skipXe : skipPhongHop),
    [skipXe, skipPhongHop]
  );
  const [activeApprovalTab, setActiveApprovalTab] = useState<"trip" | "leave" | "explanation" | "booking">("trip");
  // Bộ lọc đơn vị cho 4 tab duyệt — 1 giá trị dùng chung (phòng ban VÀ ban điều hành
  // đều là cột `department`, nên chọn ở dropdown này thì dropdown kia tự bỏ chọn).
  // Rỗng = xem tất cả đơn vị.
  const [approvalDeptFilter, setApprovalDeptFilter] = useState("");
  // Nhóm "Danh sách đã duyệt" — bảng 3 tab dời từ cột phải trang Lịch công việc sang
  const [activeDoneTab, setActiveDoneTab] = useState<"nodate" | "leave" | "trip">("nodate");
  // Lọc theo tháng. Mặc định tháng hiện tại; chuỗi rỗng = xem tất cả các tháng.
  const [doneMonth, setDoneMonth] = useState(() => new Date().toLocaleDateString("en-CA").slice(0, 7));

  // Justifications States
  const [explanations, setExplanations] = useState<any[]>([]);
  const [loadingExplanations, setLoadingExplanations] = useState(false);

  // Resource bookings (đăng ký xe / phòng họp) States
  const [resourceBookings, setResourceBookings] = useState<any[]>([]);
  const [loadingBookings, setLoadingBookings] = useState(false);

  // Danh bạ email/phòng ban tra theo tên — bảng tasks không có cột email, cần tra khi gửi mail
  const [employeeDirectory, setEmployeeDirectory] = useState<{ name: string; email: string; department: string; role: string }[]>([]);

  // SMTP gửi email — dùng chung bộ lưu trữ với trang C&B (localStorage tnec_cb_smtp_*)
  const [smtpConfig, setSmtpConfig] = useState({
    user: "",
    pass: "",
    provider: "gmail",
    host: "smtp.gmail.com",
    port: 465,
    secure: true
  });
  const [showEmailConfigModal, setShowEmailConfigModal] = useState(false);
  const [modalProvider, setModalProvider] = useState("gmail");

  // Modal phân quyền & luồng duyệt (approval_permissions / approval_groups /
  // leave_exceptions) — chỉ Admin. Tab mở tuỳ nút bấm ở card Phân quyền.
  const [showUserPermissionsModal, setShowUserPermissionsModal] = useState(false);
  const [userPermissionsTab, setUserPermissionsTab] = useState<UserPermissionsTab>("flags");

  useEffect(() => {
    if (showEmailConfigModal) {
      setModalProvider(smtpConfig.provider || "gmail");
    }
  }, [showEmailConfigModal, smtpConfig.provider]);

  // Load configuration from local storage on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      setApiKey(localStorage.getItem("openai_api_key") || "");
      setWebhookUrl(localStorage.getItem("apps_script_url") || "");
      setModel(resolveModel(localStorage.getItem("openai_model")));

      // Nạp cấu hình SMTP dùng chung với trang C&B
      setSmtpConfig({
        user: localStorage.getItem("tnec_cb_smtp_user") || "",
        pass: localStorage.getItem("tnec_cb_smtp_pass") || "",
        provider: localStorage.getItem("tnec_cb_smtp_provider") || "gmail",
        host: localStorage.getItem("tnec_cb_smtp_host") || "smtp.gmail.com",
        port: Number(localStorage.getItem("tnec_cb_smtp_port")) || 465,
        secure: localStorage.getItem("tnec_cb_smtp_secure") !== "false",
      });

      fetchTasks();
      fetchExplanations();
      fetchResourceBookings();
      fetchEmployeeDirectory();
      void (async () => setCap2Enabled(await fetchCap2Availability()))();
    }
  }, []);

  // Handle URL subtab parameter
  const subtabParam = searchParams.get("subtab");
  useEffect(() => {
    if (subtabParam === "explanation" || subtabParam === "trip" || subtabParam === "leave" || subtabParam === "booking") {
      setActiveApprovalTab(subtabParam as any);
    }
  }, [subtabParam]);


  const fetchTasks = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from("tasks")
        .select("*")
        .order("created_at", { ascending: false });
      
      if (error) throw error;
      if (data) {
        setTasks(data);
      }
    } catch (err) {
      console.error("Error fetching tasks in settings:", err);
    } finally {
      setLoading(false);
    }
  };

  const fetchExplanations = async () => {
    try {
      setLoadingExplanations(true);
      const { data, error } = await supabase
        .from("attendance_justifications")
        .select("*")
        .in("status", ["Chờ duyệt", "Chưa duyệt"])
        .order("date", { ascending: false });
      
      if (error) throw error;
      if (data) {
        setExplanations(data);
      }
    } catch (err) {
      console.error("Error fetching justifications in settings:", err);
    } finally {
      setLoadingExplanations(false);
    }
  };

  const fetchEmployeeDirectory = async () => {
    try {
      const { data, error } = await supabase
        .from("employees_directory")
        .select("name, email, department, role");
      if (error) throw error;
      if (data) {
        setEmployeeDirectory(data.map((e: any) => ({
          name: e.name,
          email: e.email || "",
          department: e.department || "",
          role: e.role || ""
        })));
      }
    } catch (err) {
      console.error("Error fetching employee directory in settings:", err);
    }
  };

  const fetchResourceBookings = async () => {
    try {
      setLoadingBookings(true);
      const { data, error } = await supabase
        .from("resource_bookings")
        .select("*")
        .in("status", ["pending_manager", "pending_hcns"])
        .order("created_at", { ascending: false });

      if (error) throw error;
      if (data) setResourceBookings(data);
    } catch (err) {
      console.error("Error fetching resource bookings in settings:", err);
    } finally {
      setLoadingBookings(false);
    }
  };

  // Đọc SMTP dùng chung (Cài đặt hệ thống / C&B) từ localStorage
  const readSmtpConfig = () => ({
    user: localStorage.getItem("tnec_cb_smtp_user") || "",
    pass: localStorage.getItem("tnec_cb_smtp_pass") || "",
    host: localStorage.getItem("tnec_cb_smtp_host") || "smtp.gmail.com",
    port: Number(localStorage.getItem("tnec_cb_smtp_port")) || 465,
    secure: localStorage.getItem("tnec_cb_smtp_secure") !== "false",
  });

  // Cấp 1: Trưởng phòng xác nhận -> chuyển sang HCNS duyệt cuối + email báo người duyệt cuối
  // Gửi email KHÔNG chặn giao diện — bắt tay SMTP với Gmail mất vài giây, nếu
  // `await` thì nút duyệt/từ chối đứng im khiến người dùng tưởng bấm hụt.
  // Ghi DB xong là phản hồi ngay; chỉ báo thêm khi email LỖI.
  const sendBookingEmailInBackground = (payload: any, failPrefix: string, onSent?: () => void) => {
    void (async () => {
      try {
        const res = await apiFetch("/api/send-booking-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const result = await res.json();
        if (res.ok) {
          onSent?.();
        } else {
          notify(`${failPrefix}: ${result.error}`, "error");
        }
      } catch (mailErr: any) {
        notify(`${failPrefix}: ${mailErr.message || "lỗi kết nối"}`, "error");
      }
    })();
  };

  // Bản cho luồng Nghỉ phép / Công tác (/api/send-request-email)
  const sendRequestEmailInBackground = (payload: any, failPrefix: string, onSent?: () => void) => {
    void (async () => {
      try {
        const res = await apiFetch("/api/send-request-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const result = await res.json();
        if (res.ok) {
          onSent?.();
        } else {
          notify(`${failPrefix}: ${result.error}`, "error");
        }
      } catch (mailErr: any) {
        notify(`${failPrefix}: ${mailErr.message || "lỗi kết nối"}`, "error");
      }
    })();
  };

  const handleManagerConfirmBooking = async (booking: any) => {
    if (!currentUser) return;
    try {
      const { error } = await supabase
        .from("resource_bookings")
        .update({
          status: "pending_hcns",
          manager_approved_by: currentUser.name,
          manager_approved_at: new Date().toISOString(),
        })
        .eq("id", booking.id);

      if (error) throw error;

      notify("Đã phê duyệt! Yêu cầu được chuyển sang phòng HCNS (điều phối xe & phòng họp) để xác nhận.\n📧 Email báo người xác nhận đang được gửi.", "success");
      fetchResourceBookings();

      // Tra cứu người duyệt cuối (HCNS - can_approve_booking) + gửi mail: chạy nền
      void (async () => {
        try {
          const { data: perms } = await supabase
            .from("approval_permissions")
            .select("email, can_approve_booking");
          const approverEmails = (perms || [])
            .filter((p: any) => p.can_approve_booking && p.email)
            .map((p: any) => p.email)
            .join(", ");
          if (!approverEmails) return;
          sendBookingEmailInBackground(
            {
              mode: "notify_approver",
              stage: "final",
              smtpConfig: readSmtpConfig(),
              booking: { ...booking, manager_approved_by: currentUser.name },
              approverEmails,
              siteUrl: window.location.origin,
            },
            "Chưa gửi được email báo người xác nhận (phòng HCNS)"
          );
        } catch (mailErr: any) {
          notify(`Chưa gửi được email báo người xác nhận (phòng HCNS): ${mailErr.message || "lỗi kết nối"}`, "error");
        }
      })();
    } catch (err) {
      console.error("Error confirming booking (manager step):", err);
      notify("Lỗi khi xác nhận đăng ký!", "error");
    }
  };

  // Cấp 2 (HCNS): duyệt / từ chối -> tự động gửi email kết quả cho người đăng ký
  const handleFinalBookingDecision = async (booking: any, approve: boolean, rejectReasonArg?: string) => {
    if (!currentUser) return;
    // Từ chối: mở hộp nhập lý do căn giữa (thay window.prompt). Có lý do rồi mới gọi
    // lại chính hàm này với tham số rejectReasonArg để chạy tiếp phần ghi DB + email.
    if (!approve && rejectReasonArg === undefined) {
      askText({
        title: "Từ chối đăng ký",
        message: "Nhập lý do từ chối (sẽ được gửi trong email cho người đăng ký):",
        placeholder: "Ví dụ: trùng lịch, không đủ điều kiện...",
        confirmLabel: "Gửi từ chối",
        onSubmit: (reason) => handleFinalBookingDecision(booking, false, reason),
      });
      return;
    }
    const rejectReason = rejectReasonArg || "";

    try {
      const decision = approve ? "approved" : "rejected";
      const { error } = await supabase
        .from("resource_bookings")
        .update({
          status: decision,
          final_decision_by: currentUser.name,
          final_decision_at: new Date().toISOString(),
          reject_reason: approve ? null : rejectReason.trim(),
        })
        .eq("id", booking.id);

      if (error) throw error;

      notify(`${approve ? "Đã DUYỆT" : "Đã TỪ CHỐI"} đăng ký ${booking.booking_type === "xe" ? "xe" : "phòng họp"} của ${booking.requester_name}.\n📧 Email kết quả đang được gửi cho người đăng ký.`, approve ? "success" : "info");
      fetchResourceBookings();

      // Gửi email kết quả chạy nền — SMTP dùng chung cấu hình đã lưu ở trang C&B
      // (localStorage), server sẽ fallback sang biến môi trường nếu chưa cấu hình.
      sendBookingEmailInBackground(
        {
          smtpConfig: readSmtpConfig(),
          booking: { ...booking, manager_approved_by: booking.manager_approved_by },
          decision,
          rejectReason: rejectReason.trim(),
          approverName: currentUser.name,
        },
        "Chưa gửi được email kết quả",
        // Chỉ đánh dấu email_sent khi mail thật sự gửi được
        () => { void supabase.from("resource_bookings").update({ email_sent: true }).eq("id", booking.id); }
      );
    } catch (err) {
      console.error("Error making final booking decision:", err);
      notify("Lỗi khi xử lý duyệt đăng ký!", "error");
    }
  };

  // Cấp 1 (Trưởng phòng/Tổ trưởng/đặc cách) bấm phê duyệt.
  //
  // Rẽ nhánh theo CÔNG TẮC 1 CẤP / 2 CẤP (lib/approvers.ts): hỏi DB xem còn ai
  // đang giữ cờ duyệt cuối của loại đơn này không.
  //   - Còn người giữ cờ  -> luồng 2 cấp như cũ: chuyển sang HCNS + báo mail họ.
  //   - Không ai giữ cờ   -> luồng 1 cấp: duyệt luôn ra trạng thái cuối, gửi mail
  //                          kết quả thẳng cho người làm đơn.
  // CỐ Ý `await` câu hỏi này TRƯỚC khi ghi: nó quyết định đơn được ghi kiểu gì,
  // hỏi sau hoặc đọc cache là đơn đi sai luồng.
  const handleCap1Confirm = async (task: any, isTrip: boolean) => {
    if (!currentUser) return;
    const approverEmails = await fetchCap2ApproverEmails(isTrip ? "trip" : "leave");

    // Không đọc được cấu hình -> KHÔNG đoán. Ghi bừa lúc này là duyệt cuối nhầm
    // một đơn lẽ ra phải chuyển tiếp (hoặc ngược lại).
    if (approverEmails === null) {
      notify("Không đọc được cấu hình luồng duyệt. Kiểm tra kết nối mạng rồi bấm lại.", "error");
      return;
    }

    // ── Luồng 1 cấp: cấp 1 duyệt là xong ──
    if (!approverEmails) {
      await handleFinalDecision(task, isTrip, true);
      return;
    }

    // ── Luồng 2 cấp: chuyển tiếp cho người giữ cờ duyệt cuối ──
    try {
      const { error } = await supabase
        .from("tasks")
        .update({
          approval_stage: "pending_hcns",
          manager_approved_by: currentUser.name,
          manager_approved_at: new Date().toISOString(),
        })
        .eq("id", task.id);

      if (error) throw error;

      notify("Đã phê duyệt! Yêu cầu được chuyển sang phòng HCNS để xác nhận.\n📧 Email báo HCNS đang được gửi.", "success");
      fetchTasks();

      // Email báo người duyệt cuối — chạy nền, danh sách địa chỉ đã có sẵn ở trên
      sendRequestEmailInBackground(
        {
          mode: "notify_approver",
          stage: "hcns",
          requestType: isTrip ? "trip" : "leave",
          smtpConfig: readSmtpConfig(),
          task: { ...task, manager_approved_by: currentUser.name },
          approverEmails,
          siteUrl: window.location.origin,
        },
        "Chưa gửi được email báo HCNS"
      );
    } catch (err) {
      console.error("Error confirming request (manager step):", err);
      notify("Lỗi khi xác nhận yêu cầu!", "error");
    }
  };

  // DUYỆT CUỐI / TỪ CHỐI + gửi email kết quả cho người gửi đơn. Gọi từ 3 chỗ:
  // nút của cấp 2 (HCNS) khi còn luồng 2 cấp, nút Từ chối của cấp 1, và chính
  // nút Phê duyệt của cấp 1 khi luồng đã rút còn 1 cấp.
  const handleFinalDecision = async (task: any, isTrip: boolean, approve: boolean, rejectReasonArg?: string) => {
    if (!currentUser) return;
    // Từ chối: mở hộp nhập lý do căn giữa (thay window.prompt), có lý do rồi gọi lại
    // chính hàm với rejectReasonArg để chạy tiếp phần ghi DB + gửi email kết quả.
    if (!approve && rejectReasonArg === undefined) {
      askText({
        title: `Từ chối yêu cầu ${isTrip ? "đi công tác" : "nghỉ phép"}`,
        message: "Nhập lý do từ chối (sẽ được gửi email cho người gửi đơn):",
        placeholder: "Ví dụ: chưa đủ thông tin, trùng lịch...",
        confirmLabel: "Gửi từ chối",
        onSubmit: (reason) => handleFinalDecision(task, isTrip, false, reason),
      });
      return;
    }
    const rejectReason = rejectReasonArg || "";

    try {
      if (approve) {
        // Ghi CSDL của bước duyệt cuối nằm trong lib/requestApproval.ts vì trang
        // Lịch công việc cũng gọi đúng hàm này khi luồng chỉ còn 1 cấp.
        await finalizeLeaveTripApproval({ task, isTrip, deciderName: currentUser.name });
      } else {
        const { data, error } = await supabase
          .from("tasks")
          .update({
            status: "need_revision",
            reject_reason: rejectReason.trim(),
            final_decision_by: currentUser.name,
            final_decision_at: new Date().toISOString(),
          })
          .eq("id", task.id)
          .select("id");

        if (error) throw error;
        // RLS chặn thì Postgres sửa 0 dòng mà KHÔNG báo lỗi — không đếm là báo
        // "đã từ chối" giả trong khi đơn vẫn nằm nguyên chờ duyệt.
        if (!data || data.length === 0) {
          throw new Error("Không ghi được quyết định — tài khoản của bạn không có quyền cập nhật đơn này.");
        }
      }

      const requesterEmail = employeeDirectory.find(e => e.name === task.assignee)?.email || "";

      notify(
        `${approve ? "Đã phê duyệt" : "Đã từ chối"} yêu cầu ${isTrip ? "đi công tác" : "nghỉ phép"}.` +
        (requesterEmail ? "\n📧 Email kết quả đang được gửi cho người làm đơn." : ""),
        approve ? "success" : "info"
      );
      fetchTasks();

      if (requesterEmail) {
        sendRequestEmailInBackground(
          {
            requestType: isTrip ? "trip" : "leave",
            smtpConfig: readSmtpConfig(),
            task,
            requesterEmail,
            decision: approve ? "approved" : "rejected",
            rejectReason: rejectReason.trim(),
            deciderName: currentUser.name,
          },
          "Chưa gửi được email kết quả"
        );
      }
    } catch (err: any) {
      console.error("Error finalizing request decision:", err);
      notify("Lỗi khi xử lý yêu cầu: " + (err?.message || err), "error");
    }
  };

  const handleApproveJustification = async (id: string) => {
    try {
      const { error } = await supabase
        .from("attendance_justifications")
        .update({ status: "Đã duyệt" })
        .eq("id", id);
      
      if (error) throw error;
      notify("Đã phê duyệt giải trình công thành công!", "success");
      fetchExplanations();
    } catch (err) {
      console.error("Error approving justification:", err);
      notify("Lỗi khi phê duyệt giải trình công!", "error");
    }
  };

  const handleRejectJustification = async (id: string) => {
    try {
      // Phải là "Từ chối" — KHÔNG phải "Chưa duyệt". "Chưa duyệt" chính là trạng
      // thái chờ duyệt (fetchExplanations lấy cả "Chưa duyệt" lẫn "Chờ duyệt"), nên
      // set lại "Chưa duyệt" thì đơn không rời khỏi danh sách chờ — bấm Từ chối như
      // không có tác dụng. "Từ chối" là trạng thái riêng, tách đơn khỏi danh sách chờ.
      const { data, error } = await supabase
        .from("attendance_justifications")
        .update({ status: "Từ chối" })
        .eq("id", id)
        .select("id");

      if (error) throw error;
      // RLS chặn thì update trả 0 dòng mà KHÔNG báo lỗi — bắt trường hợp này để
      // không hiện "đã từ chối" giả (bấm OK nhưng thực chất không đổi được gì).
      if (!data || data.length === 0) {
        notify("Không từ chối được — tài khoản của bạn không có quyền cập nhật đơn này.", "error");
        return;
      }
      notify("Đã từ chối giải trình công!", "success");
      fetchExplanations();
    } catch (err) {
      console.error("Error rejecting justification:", err);
      notify("Lỗi khi từ chối giải trình!", "error");
    }
  };

  const isApprover = useMemo(() => {
    if (!currentUser) return false;
    if (currentUser.isAdmin) return true;
    // canOpenRequestsInbox = có quyền duyệt HOẶC chỉ có cờ xem toàn bộ đơn (085).
    // Người chỉ có cờ xem vào được màn hình và thấy đủ đơn, nhưng không có nút bấm.
    if (canOpenRequestsInbox(approvalPerms)) return true;
    // Tổ trưởng Marketing duyệt cấp 1 cho thành viên tổ Marketing
    if (isMarketingTeamLeader(currentUser.name)) return true;
    const roleLower = currentUser.role.toLowerCase();
    return (
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
      roleLower.includes("leader")
    );
  }, [currentUser, approvalPerms]);

  // Phòng ban / Ban điều hành của một người, tra theo TÊN trong danh bạ nhân sự.
  // Bảng `tasks` chỉ lưu tên người làm đơn nên phải tra ngược thế này.
  //
  // PHẢI KHAI Ở ĐÂY, TRƯỚC pendingTrips/pendingLeaves. Hai useMemo đó gọi hàm này
  // ngay trong lúc render; đặt khai báo `const` xuống dưới chúng thì lúc chạy sẽ
  // ném "Cannot access before initialization" và sập nguyên trang. TypeScript
  // KHÔNG bắt được lỗi này.
  const departmentOfPerson = useCallback(
    (personName?: string | null) => {
      const key = normalizeName(personName);
      if (!key) return "";
      return employeeDirectory.find(e => normalizeName(e.name) === key)?.department || "";
    },
    [employeeDirectory]
  );

  // Cấp duyệt của MỘT giải trình — giống badge "stage" của nghỉ phép/công tác, nhưng
  // giải trình duyệt 1 bước (status -> "Đã duyệt") nên cấp là thuộc tính của ĐƠN, suy
  // từ việc đơn vị người giải trình CÓ tổ trưởng/trưởng phòng để xử lý cấp 1 hay không:
  //   - Có người duyệt cấp 1 (resolveJustificationApproverName ra tên) -> "Cấp 1: Trưởng phòng".
  //   - Không (chính họ là trưởng phòng, hoặc đơn vị không có quản lý) -> rơi thẳng "Cấp 2: HCNS".
  // Dùng chung resolveJustificationApproverName với biểu mẫu C&B nên không lệch luật.
  const justificationIsManagerStage = useCallback(
    (exp: any) =>
      resolveJustificationApproverName({
        requesterName: exp.name,
        requesterDepartment: exp.department,
        people: employeeDirectory,
      }) !== "",
    [employeeDirectory]
  );

  // Business trip approvals list (Trưởng phòng & Admin only)
  // Đơn công tác chờ duyệt. Mỗi task được gắn thêm `stage` để UI hiện đúng badge +
  // nút thao tác. Khi luồng chỉ còn 1 cấp (không ai giữ cờ duyệt cuối), các đơn CŨ
  // đang kẹt ở bước HCNS được trả về cho chính cấp 1 (+ Admin) bấm nốt một lần là
  // xong — nếu không thì chúng nằm lại vĩnh viễn vì cấp 2 không còn ai.
  const pendingTrips = useMemo(() => {
    if (!currentUser || !isApprover) return [];
    const isUserAdmin = currentUser.isAdmin || (currentUser.role || "").toLowerCase() === "admin";

    return tasks
      .filter(t => t.status === "pending_approval" && (t.title.toLowerCase().startsWith("công tác") || t.title.toLowerCase().includes("cong tac")))
      .map(t => ({ ...t, stage: getRequestStage(t) }))
      .map(t => {
        const isCap1 = isLeaveTripCap1Approver({
          currentUserName: currentUser.name,
          currentUserRole: currentUser.role,
          currentUserIsAdmin: isUserAdmin,
          currentUserDepartment: currentUser.department,
          requesterName: t.assignee,
          requesterDepartment: departmentOfPerson(t.assignee),
          taskNotes: t.notes,
          taskTitleLower: t.title.toLowerCase(),
        });
        // canAct = ĐƯỢC BẤM duyệt/từ chối. Tách khỏi việc được THẤY đơn: cờ
        // can_view_all_requests (085) chỉ mở tầm nhìn, không kèm nút bấm.
        const canAct =
          t.stage === "manager" ? isCap1
          // Đơn tồn ở bước HCNS mà luồng đã rút còn 1 cấp -> trả về cho cấp 1 + Admin
          : !cap2Enabled.trip ? (isUserAdmin || isCap1)
          : isLeaveTripCap2Approver({ currentUserIsAdmin: isUserAdmin, approvalPerms, isTrip: true });
        return { ...t, canAct };
      })
      .filter(t => t.canAct || approvalPerms.canViewAllRequests);
  }, [tasks, currentUser, isApprover, approvalPerms, cap2Enabled, departmentOfPerson]);

  // Đơn nghỉ phép chờ duyệt — cùng luồng 2 cấp, giữ nguyên các quy tắc đặc cách hiện có
  // (người duyệt được chỉ định tường minh, Quỳnh/Hằng, Hoành Anh/Quyên) ở cấp 1.
  const pendingLeaves = useMemo(() => {
    if (!currentUser || !isApprover) return [];
    const isUserAdmin = currentUser.isAdmin || (currentUser.role || "").toLowerCase() === "admin";

    return tasks
      .filter(t => {
        if (t.status !== "pending_approval") return false;
        const titleLower = t.title.toLowerCase();
        return titleLower.startsWith("nghỉ phép") || titleLower.includes("nghi phep");
      })
      .map(t => ({ ...t, stage: getRequestStage(t) }))
      .map(t => {
        const isCap1 = isLeaveTripCap1Approver({
          currentUserName: currentUser.name,
          currentUserRole: currentUser.role,
          currentUserIsAdmin: isUserAdmin,
          currentUserDepartment: currentUser.department,
          requesterName: t.assignee,
          requesterDepartment: departmentOfPerson(t.assignee),
          taskNotes: t.notes,
          taskTitleLower: t.title.toLowerCase(),
        });
        const canAct =
          t.stage === "manager" ? isCap1
          : !cap2Enabled.leave ? (isUserAdmin || isCap1)
          : isLeaveTripCap2Approver({ currentUserIsAdmin: isUserAdmin, approvalPerms, isTrip: false });
        return { ...t, canAct };
      })
      .filter(t => t.canAct || approvalPerms.canViewAllRequests);
  }, [tasks, currentUser, isApprover, approvalPerms, cap2Enabled, departmentOfPerson]);

  // ─── Nhóm "Danh sách đã duyệt" ───
  // Ba danh sách dời nguyên từ cột phải trang Lịch công việc. Bên đó lọc trên
  // `filteredTasks` (theo ô tìm kiếm / nhân sự / độ ưu tiên của trang Lịch);
  // trang này không có mấy bộ lọc đó nên đọc thẳng `tasks`.
  // Phạm vi xem 3 danh sách này: CHỈ Admin / Giám đốc / Phó Giám đốc thấy toàn công
  // ty. Mọi người còn lại (kể cả Chỉ huy trưởng Ban điều hành, Trưởng/Phó phòng, Tổ
  // trưởng) chỉ thấy nhân sự CÙNG ĐƠN VỊ với mình — trước đây đọc thẳng `tasks` nên
  // tài khoản Ban điều hành nhìn thấy đơn của mọi phòng ban khác.
  const seesAllDoneLists = !!(
    currentUser && (
      currentUser.isAdmin ||
      (currentUser.role || "").toLowerCase() === "admin" ||
      currentUser.isDirector ||
      isDirectorRole(currentUser.role)
    )
  );

  // Phòng ban của người làm đơn tra từ danh bạ (bảng `tasks` chỉ lưu TÊN).
  // Thiếu dữ liệu phòng ban ở một trong hai bên thì KHÔNG suy đoán — thà không hiện
  // còn hơn hiện nhầm đơn vị khác.
  const inMyDoneScope = useCallback(
    (t: any) => {
      if (seesAllDoneLists) return true;
      if (!currentUser) return false;
      if (normalizeName(t.assignee) === normalizeName(currentUser.name)) return true;
      const mine = normalizeName(currentUser.department || "");
      const theirs = normalizeName(departmentOfPerson(t.assignee) || "");
      if (!mine || !theirs) return false;
      return mine === theirs;
    },
    [seesAllDoneLists, currentUser, departmentOfPerson]
  );

  const doneTasksWithoutDate = useMemo(() => {
    return tasks.filter(t => !t.due_date && !t.start_date && inMyDoneScope(t));
  }, [tasks, inMyDoneScope]);

  const doneLeaveTasks = useMemo(() => {
    return tasks.filter(t =>
      (t.title.toLowerCase().startsWith("nghỉ phép") || t.title.toLowerCase().includes("nghi phep"))
      && taskOverlapsMonth(t, doneMonth)
      && inMyDoneScope(t)
    );
  }, [tasks, doneMonth, inMyDoneScope]);

  const doneTripTasks = useMemo(() => {
    return tasks.filter(t =>
      (t.title.toLowerCase().startsWith("công tác") || t.title.toLowerCase().includes("cong tac"))
      && taskOverlapsMonth(t, doneMonth)
      && inMyDoneScope(t)
    );
  }, [tasks, doneMonth, inMyDoneScope]);

  // Hai helper đọc metadata trong notes — bê nguyên từ trang Lịch công việc
  const getCleanLocation = (notes: string) => {
    if (!notes) return "Hồ Chí Minh";
    const metaMatch = notes.match(/<!--METADATA:(.*?)-->/);
    if (metaMatch) {
      try {
        const metadata = JSON.parse(metaMatch[1]);
        if (metadata.destination) return metadata.destination;
      } catch (e) {
        // ignore
      }
    }
    if (notes.includes("### THÔNG TIN ĐĂNG KÝ CÔNG TÁC")) {
      const match = notes.match(/-\s+\*\*Điểm công tác chính\*\*:\s*(.*)/i);
      if (match) return match[1].trim();
    }
    return notes.length > 50 ? notes.substring(0, 50) + "..." : notes;
  };

  const getCleanDept = (notes: string) => {
    if (!notes) return "Hành chính nhân sự";
    const metaMatch = notes.match(/<!--METADATA:(.*?)-->/);
    if (metaMatch) {
      try {
        const metadata = JSON.parse(metaMatch[1]);
        if (metadata.employeeDept) return metadata.employeeDept;
      } catch (e) {
        // ignore
      }
    }
    if (notes.includes("Người duyệt:")) {
      const parts = notes.split("Lý do:");
      if (parts[1]) return "Lý do: " + parts[1].trim();
      return "Nghỉ phép chờ duyệt";
    }
    return notes.length > 50 ? notes.substring(0, 50) + "..." : notes;
  };

  // Giải trình công — luồng thứ 5, dùng chung khung cấp 1 với 4 luồng đăng ký
  // (đồng bộ 20/08/2026). Quyền THẤY TOÀN CÔNG TY chỉ đến từ Admin hoặc cờ
  // can_approve_justification — KHÔNG suy từ chức danh nữa (bỏ isUserHR 05/09/2026):
  // tổ trưởng nhân sự / nhân viên nhân sự không có cờ được coi như nhân viên thường.
  // Người xác nhận cuối bên HCNS PHẢI được cấp cờ can_approve_justification. Phần
  // còn lại giao cho isJustificationCap1Approver: cấm tự duyệt -> tổ trưởng của chính
  // tổ người giải trình -> người được điền vào ô "Người phê duyệt" -> Trưởng/Phó
  // phòng cùng đơn vị (tổ trưởng KHÔNG còn thấy người khác tổ, Giám đốc không còn
  // thấy mọi phòng — phạm vi lãnh đạo đi qua approval_groups như 4 luồng kia).
  // Header.tsx lọc y hệt bằng cùng hàm này; đừng thêm điều kiện chỉ ở một nơi.
  const pendingExplanations = useMemo(() => {
    if (!currentUser || !isApprover) return [];

    const isUserAdmin = currentUser.isAdmin || (currentUser.role || "").toLowerCase() === "admin";

    return explanations
      .map(e => {
        const canAct = isUserAdmin || approvalPerms.canApproveJustification
          ? true
          : isJustificationCap1Approver({
              currentUserName: currentUser.name,
              currentUserRole: currentUser.role,
              currentUserIsAdmin: isUserAdmin,
              currentUserDepartment: currentUser.department,
              requesterName: e.name,
              requesterDepartment: e.department,
              designatedApprover: e.approver,
            });
        return { ...e, canAct };
      })
      // Cờ xem (085) mở tầm nhìn toàn công ty mà KHÔNG kèm nút duyệt.
      .filter(e => e.canAct || approvalPerms.canViewAllRequests)
      // Ngày giải trình MỚI NHẤT lên đầu. Sắp lại ở client cho chắc (không phụ thuộc
      // thứ tự DB trả về); cùng ngày thì đơn tạo sau đứng trên (created_at giảm dần).
      .sort((a, b) => {
        const da = new Date(a.date).getTime();
        const db = new Date(b.date).getTime();
        if (db !== da) return db - da;
        return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
      });
  }, [explanations, currentUser, isApprover, approvalPerms]);

  // Người điều phối xe / phòng họp: cờ can_approve_booking, hoặc Admin.
  const canDispatchBooking = !!currentUser && (
    currentUser.isAdmin ||
    (currentUser.role || "").toLowerCase() === "admin" ||
    approvalPerms.canApproveBooking
  );

  // Đăng ký xe / phòng họp chờ duyệt:
  // - pending_manager: Trưởng/Phó phòng cùng đơn vị (hoặc tổ trưởng của tổ người
  //   đăng ký), hoặc Admin. Khi công tắc BỎ CẤP 1 đang bật thì người điều phối
  //   cũng thấy — đây là các đơn CŨ gửi trước lúc bật, không còn bước 1 nữa nên
  //   phải có người xử lý nốt.
  // - pending_hcns: người giữ cờ can_approve_booking (điều phối) hoặc Admin.
  const pendingBookings = useMemo(() => {
    if (!currentUser || !isApprover) return [];

    const isUserAdmin = currentUser.isAdmin || (currentUser.role || "").toLowerCase() === "admin";

    return resourceBookings.filter((b) => {
      if (b.status === "pending_manager") {
        if (skipCap1For(b.booking_type) && canDispatchBooking) return true;
        return isBookingCap1Approver({
          currentUserName: currentUser.name,
          currentUserRole: currentUser.role,
          currentUserIsAdmin: isUserAdmin,
          currentUserDepartment: currentUser.department,
          requesterName: b.requester_name,
          requesterDepartment: b.department,
        });
      }
      if (b.status === "pending_hcns") {
        return isUserAdmin || approvalPerms.canApproveBooking;
      }
      return false;
    });
  }, [resourceBookings, currentUser, isApprover, approvalPerms, skipCap1For, canDispatchBooking]);

  // ─── Bộ lọc đơn vị (phòng ban / ban điều hành) áp cho cả 4 tab duyệt ───
  // Cùng một cột `department`: đơn công tác/nghỉ phép tra ngược từ danh bạ theo tên
  // người làm đơn, còn giải trình & đăng ký đã có sẵn trường department. So khớp
  // chuẩn hoá (bỏ dấu/nối khoảng) để "Phòng Tài Chính Kế Toán" khớp bất kể hoa/thường.
  const matchesApprovalDept = useCallback(
    (dept?: string | null) => {
      if (!approvalDeptFilter) return true;
      return normalizeName(dept || "") === normalizeName(approvalDeptFilter);
    },
    [approvalDeptFilter]
  );

  const filteredTrips = useMemo(
    () => pendingTrips.filter(t => matchesApprovalDept(departmentOfPerson(t.assignee))),
    [pendingTrips, matchesApprovalDept, departmentOfPerson]
  );
  const filteredLeaves = useMemo(
    () => pendingLeaves.filter(t => matchesApprovalDept(departmentOfPerson(t.assignee))),
    [pendingLeaves, matchesApprovalDept, departmentOfPerson]
  );
  const filteredExplanations = useMemo(
    () => pendingExplanations.filter(e => matchesApprovalDept(e.department)),
    [pendingExplanations, matchesApprovalDept]
  );
  const filteredBookings = useMemo(
    () => pendingBookings.filter(b => matchesApprovalDept(b.department)),
    [pendingBookings, matchesApprovalDept]
  );

  // Lưu SMTP vào cùng bộ khoá với trang C&B — cấu hình một nơi, cả hệ thống dùng chung
  const handleSaveSmtpConfig = (user: string, pass: string, provider: string, host: string, port: number, secure: boolean) => {
    setSmtpConfig({ user, pass, provider, host, port, secure });
    if (typeof window !== "undefined") {
      localStorage.setItem("tnec_cb_smtp_user", user);
      localStorage.setItem("tnec_cb_smtp_pass", pass);
      localStorage.setItem("tnec_cb_smtp_provider", provider);
      localStorage.setItem("tnec_cb_smtp_host", host);
      localStorage.setItem("tnec_cb_smtp_port", String(port));
      localStorage.setItem("tnec_cb_smtp_secure", String(secure));
    }
    setShowEmailConfigModal(false);
    notify("Đã lưu cấu hình gửi email SMTP! Các nút Xác nhận & gửi mail sẽ dùng tài khoản này.", "success");
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (typeof window !== "undefined") {
      localStorage.setItem("openai_api_key", apiKey.trim());
      localStorage.setItem("apps_script_url", webhookUrl.trim());
      localStorage.setItem("openai_model", model);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    }
  };

  if (currentUser && isApprovalsTab && !isApprover) {
    return (
      <div className="flex min-h-screen bg-[#F7F9FC]">
        <Sidebar />
        <div className="ml-60 flex-1 flex flex-col min-w-0">
          <Header title="Duyệt yêu cầu" subtitle="Phê duyệt các yêu cầu đi công tác, nghỉ phép" />
          <main className="flex-1 p-8 flex flex-col items-center justify-center max-w-4xl">
            <div className="glass bg-white rounded-2xl p-8 border border-slate-200/50 shadow-premium text-center space-y-4 max-w-md">
              <div className="w-16 h-16 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center mx-auto shadow-sm">
                <ShieldAlert size={32} />
              </div>
              <h2 className="font-heading font-extrabold text-slate-800 text-lg">Truy cập bị từ chối</h2>
              <p className="text-xs text-slate-500 font-semibold leading-relaxed">
                Tài khoản của bạn ({currentUser.email}) không có quyền truy cập chức năng phê duyệt yêu cầu. Vui lòng liên hệ với Ban giám đốc hoặc Quản trị viên hệ thống để biết thêm chi tiết.
              </p>
              <div className="pt-2">
                <a
                  href="/"
                  className="inline-block px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-xl transition-all shadow active:scale-95"
                >
                  Quay lại Dashboard
                </a>
              </div>
            </div>
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-[#F7F9FC]">
      <Sidebar />
      <div className="ml-60 flex-1 flex flex-col min-w-0">
        <Header
          title={isApprovalsTab ? "Phê duyệt yêu cầu" : isUsageTab ? "Đo lường sử dụng" : isCatalogTab ? "Danh mục công việc" : isPrivacyTab ? "Chính sách bảo mật" : "Cài đặt hệ thống"}
          subtitle={isApprovalsTab ? "Xem và phê duyệt các yêu cầu đi công tác, nghỉ phép của nhân sự" : isUsageTab ? "Tài khoản nào thực sự dùng phần mềm — không tính đăng nhập rồi treo tab" : isCatalogTab ? "Dự án, nhóm và nguồn công việc dùng cho form giao việc" : undefined}
        />

        <main className="flex-1 p-8 space-y-6 overflow-y-auto w-full">
          {/* Toast Alert */}
          {saved && (
            <div className="fixed bottom-6 right-6 z-50 animate-bounce">
              <div className="bg-emerald-600 text-white px-6 py-3 rounded-xl shadow-lg flex items-center gap-3 font-semibold text-sm">
                <CheckCircle className="w-5 h-5 text-emerald-200" />
                Cập nhật cấu hình thành công!
              </div>
            </div>
          )}

          {/* ─── TAB ĐO LƯỜNG SỬ DỤNG (chỉ Admin) ─── */}
          {isUsageTab && <UsageReportPanel />}

          {/* ─── TAB DANH MỤC CÔNG VIỆC (chỉ Admin) ─── */}
          {isCatalogTab && <ProjectCatalogPanel />}

          {/* ─── TAB CHÍNH SÁCH BẢO MẬT (mọi tài khoản) ─── */}
          {isPrivacyTab && <PrivacyPolicyPanel />}

          {!isApprovalsTab && !isUsageTab && !isCatalogTab && !isPrivacyTab && (
            <div className="flex flex-col 2xl:flex-row gap-6 items-start">
            <div className="flex-1 min-w-0 w-full">
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
              {/* ═══ CỘT TRÁI: Gói dịch vụ + Bảo mật & Kết nối ═══ */}
              <div className="space-y-6">
              {/* ─── LỐI VÀO "CHÍNH SÁCH BẢO MẬT" (mọi tài khoản) ─── */}
              <a
                href="/settings?tab=privacy"
                className="glass bg-white rounded-2xl p-5 border border-slate-200/50 shadow-premium flex items-center gap-4 hover:border-blue-300 hover:shadow-lg transition-all group"
              >
                <div className="w-11 h-11 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                  <ShieldCheck size={21} />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="font-heading font-bold text-slate-800 text-sm mb-0.5 flex items-center gap-2">
                    Chính sách bảo mật
                    {privacyAcked === false && (
                      <span className="text-[9px] font-extrabold uppercase tracking-wide bg-rose-50 text-rose-600 px-2 py-0.5 rounded-full">Chưa xác nhận</span>
                    )}
                    {privacyAcked === true && (
                      <span className="text-[9px] font-extrabold uppercase tracking-wide bg-emerald-50 text-emerald-600 px-2 py-0.5 rounded-full">Đã xác nhận</span>
                    )}
                  </h2>
                </div>
                <ChevronRight size={18} className="text-slate-300 shrink-0 group-hover:text-blue-500 transition-colors" />
              </a>
              {/* ─── LỐI VÀO "ĐO LƯỜNG SỬ DỤNG" (chỉ Admin) ─── */}
              {currentUser?.isAdmin && (
                <a
                  href="/settings?tab=usage"
                  className="glass bg-white rounded-2xl p-5 border border-slate-200/50 shadow-premium flex items-center gap-4 hover:border-blue-300 hover:shadow-lg transition-all group"
                >
                  <div className="w-11 h-11 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                    <BarChart3 size={21} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="font-heading font-bold text-slate-800 text-sm mb-0.5">Đo lường sử dụng</h2>
                    <p className="text-[11px] text-slate-400 font-medium leading-tight">
                      Xếp hạng tài khoản dùng phần mềm tích cực nhất. Chỉ Admin xem được.
                    </p>
                  </div>
                  <ChevronRight size={18} className="text-slate-300 shrink-0 group-hover:text-blue-500 transition-colors" />
                </a>
              )}

              {/* ─── LỐI VÀO "DANH MỤC CÔNG VIỆC" (chỉ Admin) ─── */}
              {currentUser?.isAdmin && (
                <a
                  href="/settings?tab=danh-muc"
                  className="glass bg-white rounded-2xl p-5 border border-slate-200/50 shadow-premium flex items-center gap-4 hover:border-blue-300 hover:shadow-lg transition-all group"
                >
                  <div className="w-11 h-11 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                    <FolderKanban size={21} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="font-heading font-bold text-slate-800 text-sm mb-0.5">Danh mục công việc</h2>
                    <p className="text-[11px] text-slate-400 font-medium leading-tight">
                      Danh sách dự án triển khai (mã + tên), nhóm và nguồn công việc dùng khi giao việc.
                    </p>
                  </div>
                  <ChevronRight size={18} className="text-slate-300 shrink-0 group-hover:text-blue-500 transition-colors" />
                </a>
              )}

              {/* ─── GÓI DỊCH VỤ (chỉ Admin thấy và đổi được) ─── */}
              {currentUser?.isAdmin && (
              <div className="glass bg-white rounded-2xl p-6 border border-slate-200/50 shadow-premium">
                <h2 className="font-heading font-bold text-slate-800 text-sm flex items-center gap-2 mb-1">
                  <Package size={18} className="text-blue-600" /> Gói dịch vụ
                </h2>
                <p className="text-[11px] text-slate-400 font-medium mb-5">
                  Gói quyết định các module khả dụng trên toàn hệ thống. Chỉ Admin đổi được gói.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {([
                    { key: "basic" as Plan, desc: "Dashboard, Công việc, Lịch, Đăng ký xe/phòng họp, Duyệt yêu cầu, Hành chính & VPP, Biên bản họp, Vị trí dự án, Lương & Phúc lợi (C&B), Phòng ban, Cài đặt", accent: "border-slate-300", badge: "bg-slate-100 text-slate-600" },
                    { key: "professional" as Plan, desc: "+ Danh sách nhân viên, Góp ý & Kiến nghị, Tuyển dụng, Văn thư, Tổng hợp", accent: "border-blue-300", badge: "bg-blue-50 text-blue-600" },
                    { key: "enterprise" as Plan, desc: "+ Tìm kiếm AI thông minh, Hồ sơ trình ký (Kế hoạch thu chi, Sản lượng, Doanh thu), P. An toàn lao động (cần cấp cờ)", accent: "border-indigo-300", badge: "bg-indigo-50 text-indigo-600" },
                  ]).map(p => {
                    const isActive = activePlan === p.key;
                    return (
                      <button
                        key={p.key}
                        onClick={() => handleChangePlan(p.key)}
                        disabled={changingPlan || isActive}
                        className={`text-left p-4 rounded-2xl border-2 transition-all ${
                          isActive
                            ? `${p.accent} bg-slate-50/50 shadow-inner cursor-default`
                            : "border-slate-100 hover:border-slate-200 hover:bg-slate-50/50 cursor-pointer"
                        } disabled:opacity-90`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full uppercase tracking-wider ${p.badge}`}>
                            {PLAN_LABELS[p.key]}
                          </span>
                          {isActive && (
                            <span className="text-[9px] font-extrabold text-emerald-600 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full uppercase tracking-wider">
                              Đang dùng
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-slate-500 font-medium leading-relaxed">{p.desc}</p>
                      </button>
                    );
                  })}
                </div>

                <p className="mt-4 text-[10px] text-slate-400 font-medium leading-relaxed bg-slate-50 border border-slate-100 rounded-xl px-3 py-2.5">
                  🔒 Gói mở <b className="text-slate-500">module</b>, không mở <b className="text-slate-500">dữ liệu nhạy cảm</b>.
                  Trong C&amp;B, bảng lương &amp; BHXH và hợp đồng lao động chỉ hiện với Admin hoặc tài khoản
                  được bật cờ &quot;Xem lương &amp; HĐLĐ&quot; ở phần Phân quyền người dùng.
                </p>
              </div>
              )}

              {/* Setup Configuration Form */}
              <div className="glass bg-white rounded-2xl p-6 border border-slate-200/50 shadow-premium">
            <h2 className="font-heading font-bold text-slate-800 text-sm flex items-center gap-2 mb-5">
              <Key size={18} className="text-blue-600" /> Cấu hình bảo mật & Kết nối
            </h2>

            <form onSubmit={handleSave} className="space-y-5 text-xs text-slate-600 font-semibold">
              {/* API Key */}
              <div className="space-y-1">
                <label className="text-slate-500">OpenAI API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-proj-..."
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/40"
                />
              </div>

              {/* Webhook Url */}
              <div className="space-y-1">
                <label className="text-slate-500">Google Apps Script Webhook URL</label>
                <input
                  type="text"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://script.google.com/macros/s/.../exec"
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/40"
                />
              </div>

              {/* ChatGPT Model */}
              <div className="space-y-1">
                <label className="text-slate-500">ChatGPT Model</label>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/40 cursor-pointer"
                >
                  {AI_MODEL_OPTIONS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </div>

              <div className="pt-4 border-t border-slate-100 flex justify-end">
                <button
                  type="submit"
                  className="px-6 py-2.5 bg-[#005BAC] hover:bg-blue-700 text-white font-bold rounded-xl active:scale-95 transition-all shadow"
                >
                  Lưu cấu hình hệ thống
                </button>
              </div>
            </form>
          </div>

              </div>

              {/* ═══ CỘT PHẢI: Phân quyền & Luồng duyệt + SMTP + Thông tin nền tảng ═══ */}
              <div className="space-y-6">

              {/* ─── PHÂN QUYỀN & LUỒNG DUYỆT (chỉ Admin — 3 cụm, mỗi cụm một màu) ─── */}
              {currentUser?.isAdmin && (
              <div className="glass bg-white rounded-2xl p-6 border border-slate-200/50 shadow-premium">
                <h2 className="font-heading font-bold text-slate-800 text-sm flex items-center gap-2 mb-1">
                  <ShieldCheck size={18} className="text-indigo-600" /> Phân quyền &amp; Luồng duyệt
                </h2>
                <p className="text-[11px] text-slate-400 font-medium mb-4 leading-relaxed">
                  Toàn bộ quyền và luồng duyệt cấu hình bằng dữ liệu — cấp / thu hồi ngay tại đây,
                  không cần sửa code hay vào Supabase Table Editor.
                </p>
                <div className="space-y-2.5">
                  <button
                    type="button"
                    onClick={() => { setUserPermissionsTab("flags"); setShowUserPermissionsModal(true); }}
                    className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-blue-100 bg-blue-50/50 hover:bg-blue-50 hover:border-blue-200 transition-all active:scale-[0.99] cursor-pointer text-left"
                  >
                    <div className="w-9 h-9 rounded-xl bg-[#005BAC] text-white flex items-center justify-center shadow-sm shrink-0">
                      <ShieldCheck size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-slate-800">Cờ quyền người dùng (User Permissions)</p>
                      <p className="text-[10px] text-slate-400 font-medium">Duyệt công tác / nghỉ phép, xem lương, hồ sơ thanh toán, văn thư... cho từng nhân sự</p>
                    </div>
                    <ChevronRight size={15} className="text-blue-400 shrink-0" />
                  </button>

                  <button
                    type="button"
                    onClick={() => { setUserPermissionsTab("groups"); setShowUserPermissionsModal(true); }}
                    className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-amber-100 bg-amber-50/50 hover:bg-amber-50 hover:border-amber-200 transition-all active:scale-[0.99] cursor-pointer text-left"
                  >
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-500 to-orange-400 text-white flex items-center justify-center shadow-sm shrink-0">
                      <Users size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-slate-800">Nhóm duyệt riêng (tổ)</p>
                      <p className="text-[10px] text-slate-400 font-medium">Tổ trưởng duyệt cấp 1 mọi loại đơn thay Trưởng phòng ban — VD Tổ Marketing</p>
                    </div>
                    <ChevronRight size={15} className="text-amber-400 shrink-0" />
                  </button>

                  <button
                    type="button"
                    onClick={() => { setUserPermissionsTab("exceptions"); setShowUserPermissionsModal(true); }}
                    className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-rose-100 bg-rose-50/50 hover:bg-rose-50 hover:border-rose-200 transition-all active:scale-[0.99] cursor-pointer text-left"
                  >
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-rose-500 to-pink-400 text-white flex items-center justify-center shadow-sm shrink-0">
                      <CalendarClock size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-slate-800">Đặc cách nghỉ 1 ngày</p>
                      <p className="text-[10px] text-slate-400 font-medium">Cặp người duyệt thay cho đơn nghỉ đúng 1 ngày — VD Quỳnh duyệt Hằng</p>
                    </div>
                    <ChevronRight size={15} className="text-rose-400 shrink-0" />
                  </button>

                  {/* Hai công tắc rút luồng đăng ký còn 1 cấp — KHÁC ba mục trên:
                      đây không phải nút mở bảng dữ liệu mà là thiết lập bật/tắt ngay
                      tại chỗ, có hiệu lực cho cả công ty. Tách riêng xe và phòng họp
                      vì hai loại do người khác điều phối, nhu cầu duyệt cũng khác. */}
                  {([
                    { type: "xe" as const, on: skipXe, icon: <CarFront size={16} />, title: "Bỏ bước Trưởng phòng — Đăng ký xe", what: "Đơn đăng ký xe" },
                    { type: "phong_hop" as const, on: skipPhongHop, icon: <DoorOpen size={16} />, title: "Bỏ bước Trưởng phòng — Đăng ký phòng họp", what: "Đơn đăng ký phòng họp" },
                  ]).map(sw => (
                    <div key={sw.type} className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-emerald-100 bg-emerald-50/50 text-left">
                      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-400 text-white flex items-center justify-center shadow-sm shrink-0">
                        {sw.icon}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-bold text-slate-800">{sw.title}</p>
                        <p className="text-[10px] text-slate-400 font-medium">
                          {sw.on
                            ? `ĐANG BẬT: ${sw.what.toLowerCase()} gửi thẳng tới người điều phối, Trưởng phòng không nhận email nữa. Tắt là luồng 2 cấp trở lại ngay.`
                            : `Đang tắt: ${sw.what.toLowerCase()} qua Trưởng phòng rồi mới tới người điều phối. Bật để gửi thẳng, không cần deploy.`}
                        </p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={sw.on}
                        disabled={savingBookingFlow !== null}
                        onClick={() => handleToggleBookingFlow(sw.type)}
                        className={`relative w-11 h-6 rounded-full shrink-0 transition-colors cursor-pointer disabled:opacity-50 ${
                          sw.on ? "bg-emerald-600" : "bg-slate-300"
                        }`}
                      >
                        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${
                          sw.on ? "left-[22px]" : "left-0.5"
                        }`} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              )}

          {/* Cấu hình Email gửi thông báo (SMTP) — dùng chung với C&B và Duyệt Đăng ký */}
          <div className="glass bg-white rounded-2xl p-6 border border-slate-200/50 shadow-premium">
            <h2 className="font-heading font-bold text-slate-800 text-sm flex items-center gap-2 mb-4">
              <Mail size={18} className="text-emerald-600" /> Cấu hình gửi Email hệ thống (SMTP)
            </h2>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="text-xs font-semibold text-slate-600 space-y-1">
                {smtpConfig.user ? (
                  <p className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                    Đang dùng tài khoản gửi: <span className="text-[#005BAC] font-bold">{smtpConfig.user}</span>
                  </p>
                ) : (
                  <p className="flex items-center gap-2 text-amber-600">
                    <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0" />
                    Chưa cấu hình — các nút &quot;Xác nhận &amp; gửi mail&quot; sẽ không gửi được email kết quả.
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowEmailConfigModal(true)}
                className="shrink-0 px-5 py-2.5 bg-[#005BAC] hover:bg-blue-700 text-white text-xs font-bold rounded-xl active:scale-95 transition-all shadow-md shadow-blue-500/10 flex items-center gap-2 cursor-pointer"
              >
                <Settings size={14} /> {smtpConfig.user ? "Thay đổi cấu hình email" : "Cấu hình gửi email"}
              </button>
            </div>
          </div>

              {/* Thông tin nền tảng */}
              <div className="glass bg-white rounded-2xl p-6 border border-slate-200/50 shadow-sm space-y-4">
                <h2 className="font-heading font-bold text-slate-800 text-sm flex items-center gap-2">
                  <Info size={18} className="text-slate-500" /> Thông tin nền tảng
                </h2>
                <div className="text-xs font-semibold text-slate-600">
                  <div className="bg-slate-50 rounded-xl p-4 space-y-0.5">
                    <p className="text-slate-400 text-[10px]">Phiên bản</p>
                    <p className="text-[#005BAC] font-bold">EOP TNE&amp;C version 2.0</p>
                  </div>
                </div>
              </div>

              {/* Ảnh đại diện — mọi tài khoản đều dùng được, không gate quyền */}
              {currentUser?.email && (
                <AvatarUploadCard email={currentUser.email} name={currentUser.name} />
              )}
              </div>
            </div>
            </div>

            {/* ═══ PHÂN GÓI THEO PHÒNG BAN (cột phải, chỉ Admin) ═══ */}
            {currentUser?.isAdmin && (
            <div className="w-full 2xl:w-[640px] 2xl:shrink-0">
            <div className="glass bg-white rounded-2xl p-6 border border-slate-200/50 shadow-premium">
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-5">
                <div>
                  <h2 className="font-heading font-bold text-slate-800 text-sm flex items-center gap-2 mb-1">
                    <Users size={18} className="text-blue-600" /> Phân gói theo phòng ban
                  </h2>
                  <p className="text-[11px] text-slate-400 font-medium max-w-3xl leading-relaxed">
                    Gán gói riêng cho từng phòng (quyền nội bộ). Gói hiệu lực của mỗi người = thấp hơn
                    giữa gói hệ thống và gói phòng của họ. Ngoại lệ cho một cá nhân (VD Trưởng phòng QLDA
                    xem Văn thư) cấp qua nút <strong>User Permissions</strong>.
                  </p>
                </div>
                {deptPlansEnabled && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => ask({
                        title: "Tắt phân gói theo phòng?",
                        message: "Mọi người sẽ dùng chung gói hệ thống.",
                        confirmLabel: "Tắt",
                        onConfirm: () => saveDeptPlans(null),
                      })}
                      disabled={savingDeptPlans}
                      className="text-[11px] font-bold text-rose-500 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-50 px-3 py-2 rounded-xl transition-all cursor-pointer"
                    >
                      Tắt
                    </button>
                    <button
                      onClick={() => saveDeptPlans(deptPlansDraft)}
                      disabled={savingDeptPlans}
                      className="text-[11px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 px-4 py-2 rounded-xl transition-all cursor-pointer shadow-sm flex items-center gap-1.5"
                    >
                      {savingDeptPlans ? "Đang lưu…" : "Lưu & áp dụng"}
                    </button>
                  </div>
                )}
              </div>

              {!deptPlansEnabled ? (
                <div className="flex flex-col items-center justify-center gap-3 py-10 text-center bg-slate-50/60 rounded-2xl border border-dashed border-slate-200">
                  <div className="w-12 h-12 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-500">
                    <Users size={22} />
                  </div>
                  <p className="text-[11px] text-slate-500 font-medium max-w-md leading-relaxed">
                    Chưa bật — hiện mọi phòng dùng chung gói hệ thống (<strong>{PLAN_LABELS[activePlan]}</strong>).
                    Bật để gán gói riêng cho từng phòng.
                  </p>
                  <button
                    onClick={handleEnableDeptPlans}
                    className="text-[11px] font-bold text-white bg-[#005BAC] hover:bg-blue-700 px-5 py-2.5 rounded-xl transition-all cursor-pointer shadow-md shadow-blue-500/10"
                  >
                    Bật phân gói theo phòng
                  </button>
                  <div className="w-full px-4 pt-2 text-left">{createDeptForm}</div>
                </div>
              ) : (
                <div className="space-y-4">
                  {createDeptForm}

                  {/* Phòng ban chức năng */}
                  <div className="rounded-2xl border border-indigo-100 bg-indigo-50/30 p-4 space-y-3">
                    <p className="flex items-center gap-1.5 text-[10px] font-black text-indigo-500 uppercase tracking-wider">
                      <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" /> Phòng ban chức năng
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-2 gap-2.5">
                      {deptLists.phongBan.map(d => renderDeptPlanRow(d, d))}
                    </div>
                  </div>

                  {/* Ban điều hành dự án */}
                  {deptLists.bdh.length > 0 && (
                    <div className="rounded-2xl border border-amber-100 bg-amber-50/30 p-4 space-y-3">
                      <p className="flex items-center gap-1.5 text-[10px] font-black text-amber-600 uppercase tracking-wider">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Ban điều hành dự án
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-2 gap-2.5">
                        {deptLists.bdh.map(d => renderDeptPlanRow(d, d))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            </div>
            )}
            </div>
          )}

          {/* Nhóm Duyệt Yêu Cầu */}
          {isApprovalsTab && isApprover && (
            <div className="glass bg-white rounded-2xl p-6 border border-slate-200/50 shadow-premium space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-3">
                <h2 className="font-heading font-bold text-slate-800 text-sm flex items-center gap-2">
                  <CheckCircle size={18} className="text-emerald-600" /> Nhóm Duyệt Yêu Cầu
                </h2>

                {/* Bộ lọc đơn vị — Phòng ban & Ban điều hành. Cùng lọc cột `department`,
                    chọn dropdown này thì dropdown kia tự bỏ chọn. Áp cho cả 4 tab duyệt. */}
                <div className="flex flex-wrap items-center gap-2 text-[10px] font-bold">
                  <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-xl px-2.5 py-1.5">
                    <Users size={12} className="text-slate-400" />
                    <select
                      value={deptLists.phongBan.includes(approvalDeptFilter) ? approvalDeptFilter : ""}
                      onChange={(e) => setApprovalDeptFilter(e.target.value)}
                      className="bg-transparent border-none outline-none font-bold text-slate-700 text-[10px] cursor-pointer max-w-[160px]"
                    >
                      <option value="">Tất cả phòng ban</option>
                      {deptLists.phongBan.map((d) => (
                        <option key={d} value={d}>{d}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-xl px-2.5 py-1.5">
                    <Building2 size={12} className="text-slate-400" />
                    <select
                      value={deptLists.bdh.includes(approvalDeptFilter) ? approvalDeptFilter : ""}
                      onChange={(e) => setApprovalDeptFilter(e.target.value)}
                      className="bg-transparent border-none outline-none font-bold text-slate-700 text-[10px] cursor-pointer max-w-[160px]"
                    >
                      <option value="">Tất cả ban điều hành</option>
                      {deptLists.bdh.map((d) => (
                        <option key={d} value={d}>{d}</option>
                      ))}
                    </select>
                  </div>
                  {approvalDeptFilter && (
                    <button
                      type="button"
                      onClick={() => setApprovalDeptFilter("")}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl border border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100 transition-all active:scale-95"
                      title="Bỏ lọc đơn vị"
                    >
                      <X size={12} /> Bỏ lọc
                    </button>
                  )}
                </div>

                {/* Modern Capsule Segmented Style */}
                <div className="bg-slate-100 p-0.5 rounded-xl flex gap-1 border border-slate-200 text-[10px] font-bold">
                  <button
                    type="button"
                    onClick={() => setActiveApprovalTab("trip")}
                    className={`px-3 py-1.5 rounded-lg cursor-pointer transition-all ${
                      activeApprovalTab === "trip"
                        ? "bg-white text-blue-600 shadow-sm border border-slate-200/20"
                        : "text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    1. Duyệt công tác ({filteredTrips.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveApprovalTab("leave")}
                    className={`px-3 py-1.5 rounded-lg cursor-pointer transition-all ${
                      activeApprovalTab === "leave"
                        ? "bg-white text-blue-600 shadow-sm border border-slate-200/20"
                        : "text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    2. Duyệt Nghỉ Phép ({filteredLeaves.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveApprovalTab("explanation")}
                    className={`px-3 py-1.5 rounded-lg cursor-pointer transition-all ${
                      activeApprovalTab === "explanation"
                        ? "bg-white text-blue-600 shadow-sm border border-slate-200/20"
                        : "text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    3. Duyệt Giải Trình ({filteredExplanations.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveApprovalTab("booking")}
                    className={`px-3 py-1.5 rounded-lg cursor-pointer transition-all ${
                      activeApprovalTab === "booking"
                        ? "bg-white text-blue-600 shadow-sm border border-slate-200/20"
                        : "text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    4. Duyệt Đăng ký ({filteredBookings.length})
                  </button>
                </div>
              </div>

              {loading ? (
                <div className="flex items-center justify-center py-8 text-slate-400 text-xs font-semibold gap-2">
                  <span className="w-4 h-4 border-2 border-slate-305 border-t-blue-600 rounded-full animate-spin" />
                  Đang tải danh sách yêu cầu chờ duyệt...
                </div>
              ) : activeApprovalTab === "trip" ? (
                <div className="space-y-4">
                  {filteredTrips.length === 0 ? (
                    <p className="text-center text-slate-400 text-xs italic py-8">
                      {approvalDeptFilter ? "Không có yêu cầu đi công tác nào của đơn vị đã chọn." : "Không có yêu cầu đi công tác nào chờ bạn phê duyệt."}
                    </p>
                  ) : (
                    <div className="overflow-x-auto rounded-xl border border-slate-200/60 bg-white">
                      <table className="w-full text-xs text-left border-collapse">
                        <thead>
                          <tr className="bg-slate-50/75 border-b border-slate-100 text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                            <th className="py-3 px-4">Nhân sự</th>
                            <th className="py-3 px-4">Thời gian</th>
                            <th className="py-3 px-4">Điểm đến</th>
                            <th className="py-3 px-4">Nhiệm vụ</th>
                            <th className="py-3 px-4">Cấp duyệt</th>
                            <th className="py-3 px-4 text-center">Thao tác</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 font-semibold text-slate-600">
                          {filteredTrips.map((req) => {
                            // Extract destination or mission from notes
                            let cleanDest = "Chưa xác định";
                            let cleanMission = "Đi công tác";
                            if (req.notes) {
                              const destMatch = req.notes.match(/-\s+\*\*Điểm công tác chính\*\*:\s*(.*)/i);
                              if (destMatch) cleanDest = destMatch[1].trim();

                              const missionMatch = req.notes.match(/-\s+\*\*Nhiệm vụ cụ thể\*\*:\s*(.*)/i);
                              if (missionMatch) cleanMission = missionMatch[1].trim();
                            }
                            const isManagerStage = req.stage === "manager";
                            // Luồng 1 cấp (không ai giữ cờ "Duyệt công tác"): cấp 1 bấm là
                            // duyệt cuối luôn, kể cả đơn cũ đang kẹt ở bước HCNS.
                            const twoStep = cap2Enabled.trip;
                            const showFinalButtons = !twoStep || !isManagerStage;

                            return (
                              <tr key={req.id} className="hover:bg-slate-50/50 transition-all duration-150">
                                <td className="py-3.5 px-4 font-bold text-slate-800 flex items-center gap-2">
                                  <div className="w-6 h-6 rounded-full bg-indigo-500 text-white text-[9px] font-bold flex items-center justify-center">
                                    {req.assignee ? req.assignee.split(" ").filter(Boolean).map((n: string) => n[0]).join("").slice(0, 2).toUpperCase() : "NV"}
                                  </div>
                                  <span>{req.assignee}</span>
                                </td>
                                <td className="py-3.5 px-4 text-slate-500 font-mono text-[10px]">
                                  {req.start_date ? new Date(req.start_date).toLocaleDateString("vi-VN") : ""} ➔ {req.due_date ? new Date(req.due_date).toLocaleDateString("vi-VN") : ""}
                                </td>
                                <td className="py-3.5 px-4 text-slate-700 font-bold">{cleanDest}</td>
                                <td className="py-3.5 px-4 text-slate-450 font-normal max-w-[200px] truncate" title={cleanMission}>{cleanMission}</td>
                                <td className="py-3.5 px-4">
                                  <span className={`inline-block px-2.5 py-1 rounded-full border text-[9px] font-extrabold uppercase ${
                                    !twoStep
                                      ? "bg-slate-50 text-slate-600 border-slate-200"
                                      : isManagerStage ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-indigo-50 text-indigo-700 border-indigo-200"
                                  }`}>
                                    {!twoStep ? "Duyệt 1 cấp" : isManagerStage ? "Cấp 1: Trưởng phòng" : "Cấp 2: HCNS"}
                                  </span>
                                </td>
                                <td className="py-3.5 px-4">
                                  {/* Người chỉ có cờ XEM (085) thấy đơn nhưng không
                                      có nút nào — quyền duyệt vẫn nằm ở nhóm cờ phê
                                      duyệt, cờ xem không được phép nới ra. */}
                                  {!req.canAct ? (
                                    <p className="text-center text-[10px] font-bold text-slate-400 italic">Chỉ xem</p>
                                  ) : (
                                  <div className="flex items-center justify-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => showFinalButtons ? handleFinalDecision(req, true, true) : handleCap1Confirm(req, true)}
                                      className={`text-white text-[10px] font-bold px-3 py-1.5 rounded-lg transition-all active:scale-95 shadow-sm cursor-pointer ${
                                        showFinalButtons ? "bg-emerald-600 hover:bg-emerald-700" : "bg-[#005BAC] hover:bg-blue-700"
                                      }`}
                                    >
                                      {showFinalButtons ? "Phê duyệt & gửi mail" : "Phê duyệt & chuyển HCNS"}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleFinalDecision(req, true, false)}
                                      className="bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg transition-all active:scale-95 shadow-sm cursor-pointer"
                                    >
                                      Từ chối
                                    </button>
                                  </div>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ) : activeApprovalTab === "leave" ? (
                <div className="space-y-4">
                  {filteredLeaves.length === 0 ? (
                    <p className="text-center text-slate-400 text-xs italic py-8">
                      {approvalDeptFilter ? "Không có yêu cầu nghỉ phép nào của đơn vị đã chọn." : "Không có yêu cầu nghỉ phép nào chờ bạn phê duyệt."}
                    </p>
                  ) : (
                    <div className="overflow-x-auto rounded-xl border border-slate-200/60 bg-white">
                      <table className="w-full text-xs text-left border-collapse">
                        <thead>
                          <tr className="bg-slate-50/75 border-b border-slate-100 text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                            <th className="py-3 px-4">Nhân sự</th>
                            <th className="py-3 px-4">Thời gian</th>
                            <th className="py-3 px-4">Lý do nghỉ</th>
                            <th className="py-3 px-4">Cấp duyệt</th>
                            <th className="py-3 px-4 text-center">Thao tác</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 font-semibold text-slate-600">
                          {filteredLeaves.map((req) => {
                            let cleanReason = "Xin nghỉ phép";
                            if (req.notes) {
                              const reasonMatch = req.notes.match(/Lý do:\s*(.*)/i);
                              if (reasonMatch) cleanReason = reasonMatch[1].trim();
                            }
                            const isManagerStage = req.stage === "manager";
                            // Luồng 1 cấp (không ai giữ cờ "Duyệt nghỉ phép"): cấp 1 bấm là
                            // duyệt cuối luôn, kể cả đơn cũ đang kẹt ở bước HCNS.
                            const twoStep = cap2Enabled.leave;
                            const showFinalButtons = !twoStep || !isManagerStage;

                            return (
                              <tr key={req.id} className="hover:bg-slate-50/50 transition-all duration-150">
                                <td className="py-3.5 px-4 font-bold text-slate-800 flex items-center gap-2">
                                  <div className="w-6 h-6 rounded-full bg-emerald-500 text-white text-[9px] font-bold flex items-center justify-center">
                                    {req.assignee ? req.assignee.split(" ").filter(Boolean).map((n: string) => n[0]).join("").slice(0, 2).toUpperCase() : "NV"}
                                  </div>
                                  <span>{req.assignee}</span>
                                </td>
                                <td className="py-3.5 px-4 text-slate-500 font-mono text-[10px]">
                                  {req.start_date ? new Date(req.start_date).toLocaleDateString("vi-VN") : ""} ➔ {req.due_date ? new Date(req.due_date).toLocaleDateString("vi-VN") : ""}
                                </td>
                                <td className="py-3.5 px-4 text-slate-450 font-normal max-w-[250px] truncate" title={cleanReason}>{cleanReason}</td>
                                <td className="py-3.5 px-4">
                                  <span className={`inline-block px-2.5 py-1 rounded-full border text-[9px] font-extrabold uppercase ${
                                    !twoStep
                                      ? "bg-slate-50 text-slate-600 border-slate-200"
                                      : isManagerStage ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-indigo-50 text-indigo-700 border-indigo-200"
                                  }`}>
                                    {!twoStep ? "Duyệt 1 cấp" : isManagerStage ? "Cấp 1: Trưởng phòng" : "Cấp 2: HCNS"}
                                  </span>
                                </td>
                                <td className="py-3.5 px-4">
                                  {/* Người chỉ có cờ XEM (085) thấy đơn nhưng không
                                      có nút nào — quyền duyệt vẫn nằm ở nhóm cờ phê
                                      duyệt, cờ xem không được phép nới ra. */}
                                  {!req.canAct ? (
                                    <p className="text-center text-[10px] font-bold text-slate-400 italic">Chỉ xem</p>
                                  ) : (
                                  <div className="flex items-center justify-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => showFinalButtons ? handleFinalDecision(req, false, true) : handleCap1Confirm(req, false)}
                                      className={`text-white text-[10px] font-bold px-3 py-1.5 rounded-lg transition-all active:scale-95 shadow-sm cursor-pointer ${
                                        showFinalButtons ? "bg-emerald-600 hover:bg-emerald-700" : "bg-[#005BAC] hover:bg-blue-700"
                                      }`}
                                    >
                                      {showFinalButtons ? "Phê duyệt & gửi mail" : "Phê duyệt & chuyển HCNS"}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleFinalDecision(req, false, false)}
                                      className="bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg transition-all active:scale-95 shadow-sm cursor-pointer"
                                    >
                                      Từ chối
                                    </button>
                                  </div>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ) : activeApprovalTab === "explanation" ? (
                <div className="space-y-4">
                  {loadingExplanations ? (
                    <div className="flex items-center justify-center py-8 text-slate-400 text-xs font-semibold gap-2">
                      <span className="w-4 h-4 border-2 border-slate-300 border-t-blue-600 rounded-full animate-spin" />
                      Đang tải danh sách giải trình chờ duyệt...
                    </div>
                  ) : filteredExplanations.length === 0 ? (
                    <p className="text-center text-slate-400 text-xs italic py-8">
                      {approvalDeptFilter ? "Không có yêu cầu giải trình nào của đơn vị đã chọn." : "Không có yêu cầu giải trình công nào chờ bạn phê duyệt."}
                    </p>
                  ) : (
                    <div className="overflow-x-auto rounded-xl border border-slate-200/60 bg-white">
                      <table className="w-full text-xs text-left border-collapse">
                        <thead>
                          <tr className="bg-slate-50/75 border-b border-slate-100 text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                            <th className="py-3 px-4">Nhân sự</th>
                            <th className="py-3 px-4">Bộ phận</th>
                            <th className="py-3 px-4">Ngày giải trình</th>
                            <th className="py-3 px-4">Lý do</th>
                            <th className="py-3 px-4">Khung giờ đề xuất</th>
                            <th className="py-3 px-4">Cấp duyệt</th>
                            <th className="py-3 px-4 text-center">Thao tác</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 font-semibold text-slate-600">
                          {filteredExplanations.map((exp) => {
                            const isManagerStage = justificationIsManagerStage(exp);
                            // Giải trình từ trước tới nay CHỈ có một bước ghi (status ->
                            // "Đã duyệt"); hai nhãn "Cấp 1/Cấp 2" chỉ nói đơn này rơi vào
                            // tay ai. Không còn ai giữ cờ "Duyệt giải trình công" thì cũng
                            // không còn cấp 2 để phân biệt — hiện thẳng "Duyệt 1 cấp".
                            const twoStep = cap2Enabled.justification;
                            return (
                            <tr key={exp.id} className="hover:bg-slate-50/50 transition-all duration-150">
                              <td className="py-3.5 px-4 font-bold text-slate-800 flex items-center gap-2">
                                <div className="w-6 h-6 rounded-full bg-amber-500 text-white text-[9px] font-bold flex items-center justify-center">
                                  {exp.name ? exp.name.split(" ").filter(Boolean).map((n: string) => n[0]).join("").slice(0, 2).toUpperCase() : "NV"}
                                </div>
                                <span>{exp.name}</span>
                              </td>
                              <td className="py-3.5 px-4 text-slate-500">{exp.department}</td>
                              <td className="py-3.5 px-4 text-slate-500">{new Date(exp.date).toLocaleDateString("vi-VN")}</td>
                              <td className="py-3.5 px-4 text-slate-450 font-normal max-w-[200px] truncate" title={exp.reason}>{exp.reason}</td>
                              <td className="py-3.5 px-4 font-mono text-[#005BAC]">{exp.propose}</td>
                              <td className="py-3.5 px-4">
                                <span className={`inline-block px-2.5 py-1 rounded-full border text-[9px] font-extrabold uppercase ${
                                  !twoStep
                                    ? "bg-slate-50 text-slate-600 border-slate-200"
                                    : isManagerStage ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-indigo-50 text-indigo-700 border-indigo-200"
                                }`}>
                                  {!twoStep ? "Duyệt 1 cấp" : isManagerStage ? "Cấp 1: Trưởng phòng" : "Cấp 2: HCNS"}
                                </span>
                              </td>
                              <td className="py-3.5 px-4">
                                {/* Chỉ có cờ XEM (085) thì thấy giải trình nhưng
                                    không có nút — quyền duyệt vẫn ở nhóm cờ phê duyệt. */}
                                {!exp.canAct ? (
                                  <p className="text-center text-[10px] font-bold text-slate-400 italic">Chỉ xem</p>
                                ) : (
                                <div className="flex items-center justify-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => handleApproveJustification(exp.id)}
                                    className={`text-white text-[10px] font-bold px-3 py-1.5 rounded-lg transition-all active:scale-95 shadow-sm cursor-pointer ${
                                      twoStep && isManagerStage ? "bg-[#005BAC] hover:bg-blue-700" : "bg-emerald-600 hover:bg-emerald-700"
                                    }`}
                                  >
                                    Duyệt
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleRejectJustification(exp.id)}
                                    className="bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg transition-all active:scale-95 shadow-sm cursor-pointer"
                                  >
                                    Từ chối
                                  </button>
                                </div>
                                )}
                              </td>
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  {loadingBookings ? (
                    <div className="flex items-center justify-center py-8 text-slate-400 text-xs font-semibold gap-2">
                      <span className="w-4 h-4 border-2 border-slate-300 border-t-blue-600 rounded-full animate-spin" />
                      Đang tải danh sách đăng ký xe / phòng họp chờ duyệt...
                    </div>
                  ) : filteredBookings.length === 0 ? (
                    <p className="text-center text-slate-400 text-xs italic py-8">
                      {approvalDeptFilter ? "Không có đăng ký xe / phòng họp nào của đơn vị đã chọn." : "Không có đăng ký xe / phòng họp nào chờ bạn xử lý."}
                    </p>
                  ) : (
                    <div className="space-y-4">
                      {filteredBookings.map((b) => {
                        const isVehicleBooking = b.booking_type === "xe";
                        const isManagerStep = b.status === "pending_manager";
                        // Công tắc bỏ cấp 1 tính theo ĐÚNG loại của đơn này
                        const skipThis = skipCap1For(b.booking_type);
                        const attendeeList: string[] = Array.isArray(b.attendees) ? b.attendees : [];
                        return (
                          <div key={b.id} className="rounded-xl border border-slate-200/60 bg-white p-5 space-y-3 hover:bg-slate-50/30 transition-all">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div className="flex items-center gap-3">
                                <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-white shadow-sm ${isVehicleBooking ? "bg-gradient-to-br from-amber-500 to-orange-400" : "bg-gradient-to-br from-blue-600 to-cyan-500"}`}>
                                  {isVehicleBooking ? <CarFront size={16} /> : <DoorOpen size={16} />}
                                </div>
                                <div>
                                  <p className="font-bold text-slate-800 text-xs">
                                    {isVehicleBooking ? "Đăng ký xe" : "Đăng ký phòng họp"}: <span className="text-[#005BAC]">{b.resource_name}</span>
                                  </p>
                                  <p className="text-[10px] text-slate-400 font-semibold">
                                    {b.requester_name} • {b.department} • gửi lúc {b.created_at ? new Date(b.created_at).toLocaleString("vi-VN") : ""}
                                  </p>
                                </div>
                              </div>
                              <span className={`px-2.5 py-1 rounded-full border text-[9px] font-extrabold uppercase ${
                                isManagerStep && !skipThis
                                  ? "bg-amber-50 text-amber-700 border-amber-200"
                                  : "bg-indigo-50 text-indigo-700 border-indigo-200"
                              }`}>
                                {skipThis
                                  ? (isManagerStep ? "Đơn cũ — chờ điều phối" : "Chờ điều phối")
                                  : (isManagerStep ? "Cấp 1: Chờ Trưởng phòng phê duyệt" : "Cấp 2: Chờ phòng HCNS xác nhận")}
                              </span>
                            </div>

                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px] font-semibold text-slate-600 bg-slate-50/60 rounded-xl p-3">
                              <div>
                                <p className="text-[9px] text-slate-400 uppercase font-bold">Người chủ trì</p>
                                <p className="text-slate-800">{b.host_name}</p>
                              </div>
                              <div>
                                <p className="text-[9px] text-slate-400 uppercase font-bold">Thời gian</p>
                                <p className="font-mono text-[10px]">
                                  {new Date(b.start_time).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })} ➔ {new Date(b.end_time).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}
                                </p>
                              </div>
                              <div>
                                <p className="text-[9px] text-slate-400 uppercase font-bold">Số người</p>
                                <p>{b.attendee_count}{b.participant_type === "khach_hang" ? " (có khách ngoài)" : " (nội bộ)"}</p>
                              </div>
                              <div>
                                <p className="text-[9px] text-slate-400 uppercase font-bold">{isVehicleBooking ? "Mục đích" : "Nội dung họp"}</p>
                                <p className="font-normal truncate" title={b.content}>{b.content}</p>
                              </div>
                            </div>

                            {(attendeeList.length > 0 || b.customer_info || b.notes || b.manager_approved_by) && (
                              <div className="text-[10px] text-slate-500 font-normal space-y-1">
                                {attendeeList.length > 0 && <p><strong className="text-slate-600">Tham dự:</strong> {attendeeList.join(", ")}</p>}
                                {b.customer_info && <p><strong className="text-slate-600">Khách hàng:</strong> {b.customer_info}</p>}
                                {b.notes && <p><strong className="text-slate-600">Ghi chú hậu cần:</strong> {b.notes}</p>}
                                {b.manager_approved_by && <p><strong className="text-slate-600">Trưởng phòng đã phê duyệt:</strong> {b.manager_approved_by}</p>}
                              </div>
                            )}

                            <div className="flex items-center justify-end gap-2 pt-1 border-t border-slate-100">
                              {/* Bỏ cấp 1: người điều phối xử lý thẳng đơn còn ở bước
                                  Trưởng phòng. Trưởng phòng không kiêm điều phối thì
                                  vẫn thấy nút cũ để duyệt nốt đơn của phòng mình. */}
                              {isManagerStep && !(skipThis && canDispatchBooking) ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => handleManagerConfirmBooking(b)}
                                    className="bg-[#005BAC] hover:bg-blue-700 text-white text-[10px] font-bold px-4 py-2 rounded-lg transition-all active:scale-95 shadow-sm cursor-pointer"
                                  >
                                    Phê duyệt & chuyển HCNS
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleFinalBookingDecision(b, false)}
                                    className="bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-bold px-4 py-2 rounded-lg transition-all active:scale-95 shadow-sm cursor-pointer"
                                  >
                                    Từ chối & gửi mail
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => handleFinalBookingDecision(b, true)}
                                    className="bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold px-4 py-2 rounded-lg transition-all active:scale-95 shadow-sm cursor-pointer"
                                  >
                                    {skipThis ? "Điều phối & gửi mail" : "Xác nhận & gửi mail"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleFinalBookingDecision(b, false)}
                                    className="bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-bold px-4 py-2 rounded-lg transition-all active:scale-95 shadow-sm cursor-pointer"
                                  >
                                    Từ chối & gửi mail
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ─── NHÓM DANH SÁCH ĐÃ DUYỆT ───
              Bảng 3 tab dời nguyên từ cột phải trang Lịch công việc sang đây. */}
          {isApprovalsTab && isApprover && (
            <div className="glass bg-white rounded-2xl p-6 border border-slate-200/50 shadow-premium space-y-4 mt-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
                <h2 className="font-heading font-bold text-slate-800 text-sm flex items-center gap-2">
                  <Calendar size={18} className="text-[#005BAC]" /> Nhóm danh sách đã duyệt
                </h2>

                {/* Lọc theo tháng — áp cho tab Nghỉ phép và Công tác */}
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-xl px-3 py-1.5">
                    <Calendar size={12} className="text-slate-400" />
                    <input
                      type="month"
                      value={doneMonth}
                      onChange={(e) => setDoneMonth(e.target.value)}
                      className="bg-transparent border-none outline-none font-bold text-slate-700 text-xs cursor-pointer"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setDoneMonth("")}
                    className={`text-[10px] font-bold px-3 py-2 rounded-xl border transition-all active:scale-95 ${
                      doneMonth === ""
                        ? "bg-blue-50 border-blue-200 text-[#005BAC]"
                        : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                    }`}
                  >
                    Tất cả các tháng
                  </button>
                </div>
              </div>

              {/* Tabs */}
              <div className="grid grid-cols-3 bg-slate-100 p-0.5 rounded-xl text-center text-[10px] font-bold">
                <button
                  type="button"
                  onClick={() => setActiveDoneTab("nodate")}
                  className={`py-2 rounded-lg cursor-pointer transition-all ${
                    activeDoneTab === "nodate"
                      ? "bg-white text-slate-800 shadow-sm"
                      : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  Chưa hạn ({doneTasksWithoutDate.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveDoneTab("leave")}
                  className={`py-2 rounded-lg cursor-pointer transition-all ${
                    activeDoneTab === "leave"
                      ? "bg-white text-slate-800 shadow-sm"
                      : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  Nghỉ phép ({doneLeaveTasks.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveDoneTab("trip")}
                  className={`py-2 rounded-lg cursor-pointer transition-all ${
                    activeDoneTab === "trip"
                      ? "bg-white text-slate-800 shadow-sm"
                      : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  Công tác ({doneTripTasks.length})
                </button>
              </div>

              {/* Tab Content */}
              <div className="space-y-3 max-h-[500px] overflow-y-auto scrollbar-thin">
                {activeDoneTab === "nodate" && (
                  <div className="space-y-3">
                    {/* Nói rõ vì sao đổi tháng mà danh sách này không đổi */}
                    <p className="text-[10px] font-semibold text-slate-400 italic">
                      Mục này không lọc theo tháng — đây là các việc chưa đặt ngày nên không thuộc tháng nào.
                    </p>
                    <div className="bg-rose-50 border border-rose-100 p-3 rounded-xl flex gap-2">
                      <AlertCircle className="text-rose-500 shrink-0" size={16} />
                      <div className="text-[10px] leading-relaxed">
                        <span className="font-bold text-rose-800 block">🚨 CHƯA CÓ NGÀY HẠN</span>
                        <span className="text-rose-600 font-medium">
                          Danh sách công việc chưa được thiết lập deadline. Hãy nhấp để mở rộng và cấu hình hạn hoàn thành.
                        </span>
                      </div>
                    </div>
                    {doneTasksWithoutDate.map(t => (
                      <div
                        key={t.id}
                        className="p-3 bg-white border border-slate-200/80 rounded-xl shadow-sm space-y-1.5 text-left"
                      >
                        <p className="font-heading font-semibold text-xs text-slate-800 line-clamp-2">{t.title}</p>
                        <div className="flex items-center justify-between text-[9px] text-slate-400">
                          <span className="font-semibold text-slate-500 flex items-center gap-1"><User size={9} /> {t.assignee}</span>
                          <span className={`badge text-[8px] font-bold ${
                            t.status === "completed" ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-blue-700"
                          }`}>
                            {t.status === "completed" ? "Đã xong" : "Kế hoạch"}
                          </span>
                        </div>
                      </div>
                    ))}
                    {doneTasksWithoutDate.length === 0 && (
                      <p className="text-center text-slate-400 text-xs italic py-10">Tất cả việc đều đã có hạn</p>
                    )}
                  </div>
                )}

                {activeDoneTab === "leave" && (
                  <div className="space-y-3">
                    {doneLeaveTasks.map(t => (
                      <div
                        key={t.id}
                        className="p-3 bg-emerald-50/40 border border-emerald-100 rounded-xl space-y-1.5 text-left"
                      >
                        <p className="font-heading font-bold text-xs text-emerald-800">🌴 {t.title.replace(/^Nghỉ phép:\s*/i, "")}</p>
                        <div className="flex items-center justify-between text-[9px] text-emerald-600 font-semibold">
                          <span>Phòng ban/Lý do: {getCleanDept(t.notes || "")}</span>
                          <span>Hạn: {t.due_date ? new Date(t.due_date).toLocaleDateString("vi-VN") : "N/A"}</span>
                        </div>
                      </div>
                    ))}
                    {doneLeaveTasks.length === 0 && (
                      <p className="text-center text-slate-400 text-xs italic py-10">Không có lịch nghỉ phép nào</p>
                    )}
                  </div>
                )}

                {activeDoneTab === "trip" && (
                  <div className="space-y-3">
                    {doneTripTasks.map(t => (
                      <div
                        key={t.id}
                        className="p-3 bg-indigo-50/40 border border-indigo-100 rounded-xl space-y-1.5 text-left"
                      >
                        <p className="font-heading font-bold text-xs text-indigo-800">💼 {t.title.replace(/^Công tác:\s*/i, "")}</p>
                        <div className="flex items-center justify-between text-[9px] text-indigo-600 font-semibold">
                          <span>Địa điểm: {getCleanLocation(t.notes || "")}</span>
                          <span>Hạn: {t.due_date ? new Date(t.due_date).toLocaleDateString("vi-VN") : "N/A"}</span>
                        </div>
                      </div>
                    ))}
                    {doneTripTasks.length === 0 && (
                      <p className="text-center text-slate-400 text-xs italic py-10">Không có lịch đi công tác nào</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ─── MODAL PHÂN QUYỀN & LUỒNG DUYỆT (chỉ Admin — RLS chặn ghi tầng DB) ─── */}
          {currentUser?.isAdmin && (
            <UserPermissionsModal
              open={showUserPermissionsModal}
              onClose={() => setShowUserPermissionsModal(false)}
              employeeDirectory={employeeDirectory}
              initialTab={userPermissionsTab}
            />
          )}

          {/* ─── MODAL CẤU HÌNH SMTP GỬI THƯ (y hệt trang C&B, dùng chung localStorage) ─── */}
          {showEmailConfigModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
              <div className="bg-white w-full max-w-md rounded-2xl shadow-premium border border-slate-100 overflow-hidden transform transition-all animate-in zoom-in-95 duration-150">
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-[#005BAC] text-white">
                  <h3 className="font-heading font-black text-sm flex items-center gap-2">
                    <Settings size={16} /> Cấu hình tài khoản SMTP gửi email
                  </h3>
                  <button
                    onClick={() => setShowEmailConfigModal(false)}
                    className="text-white/80 hover:text-white transition-all cursor-pointer p-1 rounded-lg hover:bg-white/10"
                  >
                    <X size={16} />
                  </button>
                </div>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const formData = new FormData(e.currentTarget);
                    const user = String(formData.get("smtp_user") || "").trim();
                    const pass = String(formData.get("smtp_pass") || "").trim();
                    const provider = modalProvider;

                    let host = "smtp.gmail.com";
                    let port = 465;
                    let secure = true;

                    if (provider === "gmail") {
                      host = "smtp.gmail.com";
                      port = 465;
                      secure = true;
                    } else if (provider === "outlook") {
                      host = "smtp.office365.com";
                      port = 587;
                      secure = false;
                    } else {
                      host = String(formData.get("smtp_host") || "").trim() || "smtp.gmail.com";
                      port = Number(formData.get("smtp_port")) || 465;
                      secure = formData.get("smtp_secure") === "true";
                    }

                    if (!user || !pass) {
                      notify("Vui lòng điền đầy đủ email và mật khẩu!", "warn");
                      return;
                    }
                    handleSaveSmtpConfig(user, pass, provider, host, port, secure);
                  }}
                  className="p-6 space-y-4 text-xs font-semibold text-slate-700"
                >
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Nhà cung cấp Email</label>
                    <select
                      value={modalProvider}
                      onChange={(e) => setModalProvider(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-[#005BAC] focus:ring-1 focus:ring-[#005BAC] outline-none transition-all cursor-pointer"
                    >
                      <option value="gmail">Gmail</option>
                      <option value="outlook">Outlook / Microsoft Office 365 (Doanh nghiệp)</option>
                      <option value="custom">Cấu hình SMTP khác (Thủ công)</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Tài khoản Email gửi đi</label>
                    <input
                      type="email"
                      name="smtp_user"
                      defaultValue={smtpConfig.user}
                      placeholder={modalProvider === "gmail" ? "vidu@gmail.com" : "quynhnbn@trungnamgroup.com.vn"}
                      required
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-[#005BAC] focus:ring-1 focus:ring-[#005BAC] outline-none transition-all"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider flex items-center justify-between">
                      <span>Mật khẩu hoặc Mật khẩu ứng dụng</span>
                      {modalProvider === "gmail" && (
                        <a
                          href="https://myaccount.google.com/apppasswords"
                          target="_blank"
                          rel="noreferrer"
                          className="text-[#005BAC] hover:underline normal-case font-bold"
                        >
                          Cách lấy mật khẩu Gmail?
                        </a>
                      )}
                      {modalProvider === "outlook" && (
                        <a
                          href="https://mysignins.microsoft.com/security-info"
                          target="_blank"
                          rel="noreferrer"
                          className="text-[#005BAC] hover:underline normal-case font-bold"
                        >
                          Cài đặt bảo mật Microsoft?
                        </a>
                      )}
                    </label>
                    <input
                      type="password"
                      name="smtp_pass"
                      defaultValue={smtpConfig.pass}
                      placeholder="Mật khẩu tài khoản hoặc mật khẩu ứng dụng"
                      required
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-[#005BAC] focus:ring-1 focus:ring-[#005BAC] outline-none transition-all font-mono tracking-widest"
                    />
                  </div>

                  {modalProvider === "custom" && (
                    <div className="grid grid-cols-2 gap-3 border border-slate-100 p-3 rounded-2xl bg-slate-50/50">
                      <div className="space-y-1.5 col-span-2">
                        <label className="text-[9px] font-black text-slate-400 uppercase tracking-wider">SMTP Server Host</label>
                        <input
                          type="text"
                          name="smtp_host"
                          defaultValue={smtpConfig.host}
                          placeholder="smtp.example.com"
                          required
                          className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-xl focus:border-[#005BAC] outline-none transition-all"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[9px] font-black text-slate-400 uppercase tracking-wider">Cổng (Port)</label>
                        <input
                          type="number"
                          name="smtp_port"
                          defaultValue={smtpConfig.port}
                          placeholder="465"
                          required
                          className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-xl focus:border-[#005BAC] outline-none transition-all"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[9px] font-black text-slate-400 uppercase tracking-wider">Bảo mật SSL/TLS</label>
                        <select
                          name="smtp_secure"
                          defaultValue={String(smtpConfig.secure)}
                          className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-xl focus:border-[#005BAC] outline-none transition-all cursor-pointer"
                        >
                          <option value="true">SSL (Port 465)</option>
                          <option value="false">TLS/STARTTLS (Port 587 hoặc khác)</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {/* Hướng dẫn bảo mật dựa theo nhà cung cấp */}
                  <div className="bg-blue-50 border border-blue-100 p-3.5 rounded-xl space-y-1 text-blue-800 text-[10px] leading-relaxed">
                    <p className="font-bold flex items-center gap-1 text-xs">
                      <Info size={13} /> Hướng dẫn cấu hình gửi email:
                    </p>
                    {modalProvider === "gmail" ? (
                      <>
                        <p>1. Gmail yêu cầu bạn phải bật **Xác minh 2 bước** trên tài khoản Google, sau đó tạo một **Mật khẩu ứng dụng (App Password)** gồm 16 ký tự để kết nối.</p>
                        <p>2. Không dùng mật khẩu đăng nhập Gmail thông thường vì Google chặn kết nối ứng dụng trực tiếp từ bên ngoài.</p>
                      </>
                    ) : modalProvider === "outlook" ? (
                      <>
                        <p>1. Đối với email Outlook doanh nghiệp (ví dụ `@trungnamgroup.com.vn`), hệ thống sử dụng SMTP của Microsoft (`smtp.office365.com` qua cổng `587`).</p>
                        <p>2. Nếu công ty bạn yêu cầu xác thực MFA (bảo mật 2 lớp), bạn cần tạo **Mật khẩu ứng dụng (App Password)** từ tài khoản Microsoft của mình để kết nối.</p>
                        <p>3. Nếu công ty không sử dụng bảo mật 2 lớp cho Outlook, bạn có thể điền mật khẩu đăng nhập email thông thường.</p>
                      </>
                    ) : (
                      <p>Vui lòng liên hệ bộ phận IT quản lý hệ thống email của công ty để xin thông tin **SMTP Host**, **Port** và kiểm tra xem có cần mật khẩu ứng dụng riêng hay không.</p>
                    )}
                    <p className="pt-1 text-slate-400 border-t border-blue-100/50 mt-1">Thông tin SMTP được lưu cục bộ trên trình duyệt của bạn (localStorage), dùng chung cho trang C&amp;B và nút Duyệt Đăng ký.</p>
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowEmailConfigModal(false)}
                      className="px-4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-600 font-bold rounded-xl active:scale-95 transition-all cursor-pointer"
                    >
                      Hủy bỏ
                    </button>
                    <button
                      type="submit"
                      className="px-5 py-2 bg-[#005BAC] hover:bg-blue-700 text-white font-bold rounded-xl active:scale-95 transition-all cursor-pointer shadow-premium"
                    >
                      Lưu cấu hình
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </main>
      </div>
      {noticeNode}
      {confirmNode}
      {promptNode}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen bg-[#F7F9FC] items-center justify-center">
        <span className="w-8 h-8 border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin" />
      </div>
    }>
      <SettingsContent />
    </Suspense>
  );
}
