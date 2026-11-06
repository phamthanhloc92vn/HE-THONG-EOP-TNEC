"use client";

// Tab Thành viên: danh sách nhân sự dự án (migration 111) + "Quyền hệ thống" trong
// dự án — quyết định ai sửa được gì và ai thấy tiền. Cờ quyền toàn công ty vẫn
// được ưu tiên (Ban lãnh đạo… không cần gán ở đây).
// Chỉ người gán được thành viên mới THẤY tab và đọc được bảng (migration 112):
// Ban lãnh đạo / Admin / GĐDA gán tay / người có cờ "GĐDA/Chỉ huy trưởng" đúng BĐH.
// Nhân sự thuộc đúng BĐH đã tự XEM được dự án, chỉ cần gán khi muốn cho quyền sửa.
//
// Mã/Tên dự án: lấy từ danh mục dự án (Cài đặt > Danh mục công việc) khớp theo
// Mã dự án ở tab Tổng quan — mỗi BĐH trỏ đúng 1 dự án.
// Phòng ban, chức danh, SĐT, email: chụp từ danh bạ nhân sự lúc thêm.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fetchProjectCatalog } from "@/lib/projectCatalog";
import {
  ROLES,
  MEMBER_STATUSES,
  roleLabel,
  pcErrorMessage,
  pcDelete,
  pcUpdate,
  type PcAccess,
  type PcMember,
  type PcMemberStatus,
  type PcProject,
  type PcRole,
} from "@/lib/projectControl";
import { Card, Field, Select, TextInput, PrimaryButton, ErrorLine, inputCls } from "./ui";
import EmployeePicker, { findEmployeeByEmail, listDirectoryDepartments, type PickedEmployee } from "./EmployeePicker";
import MembersImport from "./MembersImport";
import { buildMembersPdfDoc, type MembersPdfRow } from "./membersPdf";
import { buildMembersWorkbook } from "./membersXlsx";
import { Trash2, Loader2, UserPlus, FileDown, FileSpreadsheet, GripVertical, Plus, Pencil, X } from "lucide-react";

type Draft = {
  unit_group: string;
  department: string;
  role: PcRole;
  project_role: string;
  duty: string;
  reports_to: string;
  status: PcMemberStatus;
};

type TextKey =
  | "unit_group"
  | "project_role"
  | "duty"
  | "reports_to"
  // Chỉ gõ tay được ở dòng không gắn tài khoản (email trống), VD dòng "Thêm dòng mới".
  | "name"
  | "department"
  | "title"
  | "phone"
  | "contact_email";

export default function MembersTab({ project, access }: { project: PcProject; access: PcAccess }) {
  const canManage = access.can_manage_members;
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [members, setMembers] = useState<PcMember[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<{ code: string; name: string } | null>(null);
  const [picked, setPicked] = useState<PickedEmployee | null>(null);
  const [draft, setDraft] = useState<Draft>(() => ({
    unit_group: "",
    // Mặc định "Tất cả phòng ban": nhân sự khối văn phòng cũng tham gia dự án. Người
    // của BĐH vẫn xếp lên đầu danh sách (EmployeePicker bdhName).
    department: "",
    role: "VIEW",
    project_role: "",
    duty: "",
    reports_to: "",
    status: "JOINED",
  }));
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState<"pdf" | "xlsx" | null>(null);

  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);

  const load = useCallback(async () => {
    let res = await supabase
      .from("pc_project_members")
      .select("*")
      .eq("project_id", project.id)
      .order("sort_order")
      .order("created_at");
    // Chưa chạy migration 130 (chưa có cột sort_order) -> quay về thứ tự tạo.
    if (res.error) {
      res = await supabase.from("pc_project_members").select("*").eq("project_id", project.id).order("created_at");
    }
    const { data, error } = res;
    if (error) setErr(pcErrorMessage(error));
    const rows = (data as PcMember[]) || [];
    // Dòng thêm trước migration 111 chưa chụp phòng ban/chức danh → tra danh bạ để hiện.
    const filled = await Promise.all(
      rows.map(async (m) => {
        if (m.department || m.title || m.phone || m.contact_email) return m;
        const e = await findEmployeeByEmail(m.email || "");
        return e ? { ...m, department: e.department, title: e.role, phone: e.phone, contact_email: e.workEmail } : m;
      })
    );
    setMembers(filled);
    setLoading(false);
  }, [project.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  useEffect(() => {
    listDirectoryDepartments().then(setDepartments);
    fetchProjectCatalog().then((c) => {
      const code = (project.code || "").trim().toLowerCase();
      const hit = code ? c.projects.find((p) => p.code.trim().toLowerCase() === code) : undefined;
      setCatalog(hit ? { code: hit.code, name: hit.name } : null);
    });
  }, [project.code]);

  const projectCode = catalog?.code || project.code || "—";
  const projectName = catalog?.name || project.name;

  async function add() {
    const emp = picked;
    if (!emp) return setErr("Chọn nhân sự trong danh sách.");
    // Nhân sự chưa có email vẫn thêm được — chỉ để có trong danh sách (không email thì
    // không đăng nhập, không nhận quyền). Migration 114 bỏ NOT NULL cột email.
    const email = (emp.email || "").toLowerCase() || null;
    const sameName = (m: PcMember) => (m.name || "").trim().toLowerCase() === emp.name.trim().toLowerCase();
    if (members.some((m) => (email ? (m.email || "").toLowerCase() === email : !m.email && sameName(m))))
      return setErr(`${emp.name} đã có trong danh sách thành viên.`);
    setSaving(true);
    setErr(null);
    const { error } = await supabase.from("pc_project_members").insert({
      project_id: project.id,
      sort_order: members.reduce((mx, m) => Math.max(mx, m.sort_order ?? 0), 0) + 1,
      email,
      name: emp?.name || null,
      role: draft.role,
      unit_group: draft.unit_group.trim() || null,
      department: emp?.department && emp.department !== "Ngoài danh bạ" ? emp.department : draft.department || null,
      title: emp?.role || null,
      phone: emp?.phone || null,
      contact_email: emp?.workEmail || email,
      project_role: draft.project_role.trim() || null,
      duty: draft.duty.trim() || null,
      reports_to: draft.reports_to.trim() || null,
      status: draft.status,
    });
    setSaving(false);
    if (error) return setErr(pcErrorMessage(error));
    setPicked(null);
    setDraft((d) => ({ ...d, project_role: "", duty: "", reports_to: "" }));
    load();
  }

  // Thêm 1 dòng trống ở cuối bảng để gõ tay (không chọn từ danh bạ, không gắn email).
  async function addBlankRow() {
    setSaving(true);
    setErr(null);
    const { error } = await supabase.from("pc_project_members").insert({
      project_id: project.id,
      sort_order: members.reduce((mx, m) => Math.max(mx, m.sort_order ?? 0), 0) + 1,
      email: null,
      role: "VIEW",
      status: "JOINED",
    });
    setSaving(false);
    if (error) return setErr(pcErrorMessage(error));
    load();
  }

  // Đổi người ở dòng `m` sang nhân sự khác (bút chì cạnh thùng rác) — giữ nguyên
  // Nhóm đơn vị, Vai trò, Nhiệm vụ, Quản lý, Trạng thái, Quyền và vị trí dòng.
  async function replaceMember(m: PcMember, emp: PickedEmployee) {
    const email = (emp.email || "").toLowerCase() || null;
    const sameName = (x: PcMember) => (x.name || "").trim().toLowerCase() === emp.name.trim().toLowerCase();
    if (members.some((x) => x.id !== m.id && (email ? (x.email || "").toLowerCase() === email : !x.email && sameName(x))))
      return setErr(`${emp.name} đã có trong danh sách thành viên.`);
    setEditId(null);
    setErr(null);
    await patch(m, {
      email,
      name: emp.name || null,
      department: emp.department && emp.department !== "Ngoài danh bạ" ? emp.department : m.department,
      title: emp.role || null,
      phone: emp.phone || null,
      contact_email: emp.workEmail || email,
    });
  }

  async function patch(m: PcMember, change: Partial<PcMember>) {
    setMembers((list) => list.map((x) => (x.id === m.id ? { ...x, ...change } : x)));
    const e = await pcUpdate("pc_project_members", { id: m.id }, change);
    if (e) {
      setErr(e);
      load();
    }
  }

  // Kéo dòng `fromId` thả lên vị trí của dòng `toId`, rồi lưu lại thứ tự 1..n.
  async function moveRow(fromId: string, toId: string) {
    if (fromId === toId) return;
    const from = members.findIndex((m) => m.id === fromId);
    const to = members.findIndex((m) => m.id === toId);
    if (from < 0 || to < 0) return;
    const next = [...members];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    const renumbered = next.map((m, i) => ({ ...m, sort_order: i + 1 }));
    setMembers(renumbered);
    const changed = renumbered.filter((m, i) => (members.find((x) => x.id === m.id)?.sort_order ?? -1) !== i + 1);
    const errs = await Promise.all(changed.map((m) => pcUpdate("pc_project_members", { id: m.id }, { sort_order: m.sort_order })));
    const bad = errs.find((e) => e);
    if (bad) {
      setErr(bad);
      load();
    }
  }

  async function runExport(kind: "pdf" | "xlsx") {
    setExporting(kind);
    setErr(null);
    const meta = { projectCode, projectName, bdhName: project.bdh_name };
    try {
      if (kind === "pdf") await exportMembersPdf(members, meta);
      else await exportMembersXlsx(members, meta);
    } catch {
      setErr(`Không tạo được file ${kind === "pdf" ? "PDF" : "Excel"}. Thử lại sau.`);
    } finally {
      setExporting(null);
    }
  }

  async function remove(m: PcMember) {
    const e = await pcDelete("pc_project_members", { id: m.id });
    if (e) return setErr(e);
    load();
  }

  const setD = (k: keyof Draft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  // Ô gõ tay trong bảng: sửa tại chỗ, lưu khi rời ô; chữ dài tự xuống dòng.
  const textCell = (m: PcMember, k: TextKey) =>
    canManage ? (
      <AutoTextarea
        key={`${m.id}-${k}-${m[k] ?? ""}`}
        initial={m[k] || ""}
        className={`${inputCls} !py-1 !px-2 !text-[11px] ${TEXT_COL_WIDTH[k]}`}
        onCommit={(raw) => {
          const v = raw.trim() || null;
          if (v !== (m[k] || null)) patch(m, { [k]: v });
        }}
      />
    ) : (
      <span className={`block text-slate-600 whitespace-pre-wrap break-words ${TEXT_COL_WIDTH[k]}`}>{m[k] || "—"}</span>
    );

  return (
    <div className="space-y-4">
      {canManage && (
        <Card title="Thêm thành viên" action={<MembersImport project={project} members={members} onDone={load} />}>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <Field label="Nhóm đơn vị">
              <TextInput value={draft.unit_group} onChange={setD("unit_group")} placeholder="VD: Ban điều hành" />
            </Field>
            <Field label="Phòng ban/Bộ phận">
              <Select
                value={draft.department}
                onChange={(e) => {
                  setDraft((d) => ({ ...d, department: e.target.value }));
                  setPicked(null);
                }}
              >
                <option value="">— Tất cả phòng ban —</option>
                {departments.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="space-y-1 md:col-span-2">
              <span className="block text-[10px] font-bold text-slate-500">Họ và tên</span>
              <EmployeePicker
                value={picked}
                onChange={setPicked}
                bdhName={project.bdh_name}
                department={draft.department || undefined}
                freeText="email"
              />
            </div>
            <Field label="Chức danh (tự điền)">
              <div className={`${inputCls} bg-slate-50 truncate`}>{picked?.role || "—"}</div>
            </Field>
            <Field label="SĐT (tự điền)">
              <div className={`${inputCls} bg-slate-50 truncate`}>{picked?.phone || "—"}</div>
            </Field>
            <Field label="Email (tự điền, ưu tiên mail công ty)" className="md:col-span-2">
              <div className={`${inputCls} bg-slate-50 truncate`}>{picked?.workEmail || picked?.email || "—"}</div>
            </Field>
            <Field label="Vai trò">
              <TextInput value={draft.project_role} onChange={setD("project_role")} />
            </Field>
            <Field label="Nhiệm vụ">
              <TextInput value={draft.duty} onChange={setD("duty")} />
            </Field>
            <Field label="Quản lý/Báo cáo">
              <TextInput value={draft.reports_to} onChange={setD("reports_to")} />
            </Field>
            <Field label="Trạng thái">
              <Select value={draft.status} onChange={setD("status")}>
                {MEMBER_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Quyền hệ thống" className="md:col-span-3">
              <Select value={draft.role} onChange={setD("role")}>
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>
            <PrimaryButton onClick={add} busy={saving}>
              <UserPlus size={13} /> Thêm
            </PrimaryButton>
          </div>
        </Card>
      )}

      <Card
        title={`Thành viên dự án (${members.length})`}
        action={
          canManage || members.length > 0 ? (
            <div className="flex gap-2">
              {canManage && (
                <PrimaryButton tone="green" busy={saving} onClick={addBlankRow}>
                  <Plus size={13} /> Thêm dòng mới
                </PrimaryButton>
              )}
              {members.length > 0 && (
                <>
                  <PrimaryButton tone="green" busy={exporting === "xlsx"} disabled={exporting !== null} onClick={() => runExport("xlsx")}>
                    <FileSpreadsheet size={13} /> Tải Excel
                  </PrimaryButton>
                  <PrimaryButton tone="green" busy={exporting === "pdf"} disabled={exporting !== null} onClick={() => runExport("pdf")}>
                    <FileDown size={13} /> Xuất PDF
                  </PrimaryButton>
                </>
              )}
            </div>
          ) : null
        }
      >
        <ErrorLine msg={err} />
        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="animate-spin text-[#005BAC]" size={22} />
          </div>
        ) : members.length === 0 ? (
          <p className="text-xs italic text-slate-400 text-center py-4">Chưa gán ai. Nên gán Giám đốc dự án trước.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="bg-[#005BAC] text-[10px] font-extrabold uppercase tracking-wider text-white text-left whitespace-nowrap">
                  {canManage && <th className="w-5" />}
                  <th className="py-1.5 pr-2 w-8 text-center">STT</th>
                  <th className="py-1.5 px-1">Mã dự án</th>
                  <th className="py-1.5 px-1">Tên dự án</th>
                  <th className="py-1.5 px-1">Nhóm đơn vị</th>
                  <th className="py-1.5 px-1">Phòng ban/Bộ phận</th>
                  <th className="py-1.5 px-1">Họ và tên</th>
                  <th className="py-1.5 px-1">Chức danh</th>
                  <th className="py-1.5 px-1">Vai trò</th>
                  <th className="py-1.5 px-1">Nhiệm vụ</th>
                  <th className="py-1.5 px-1">Quản lý/Báo cáo</th>
                  <th className="py-1.5 px-1">SĐT</th>
                  <th className="py-1.5 px-1">Email</th>
                  <th className="py-1.5 px-1">Trạng thái</th>
                  <th className="py-1.5 px-1">Quyền hệ thống</th>
                  {canManage && <th className="w-8" />}
                </tr>
              </thead>
              <tbody>
                {members.map((m, i) => {
                  const st = MEMBER_STATUSES.find((s) => s.value === (m.status || "JOINED")) || MEMBER_STATUSES[1];
                  return (
                    <tr
                      key={m.id}
                      onDragOver={(e) => {
                        if (!dragId) return;
                        e.preventDefault();
                        if (overId !== m.id) setOverId(m.id);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragId) moveRow(dragId, m.id);
                        setDragId(null);
                        setOverId(null);
                      }}
                      className={`border-t border-slate-100 align-top [&>td]:py-1.5 ${dragId === m.id ? "opacity-40" : ""} ${
                        dragId && overId === m.id && dragId !== m.id ? "bg-blue-50" : ""
                      }`}
                    >
                      {canManage && (
                        <td className="px-0.5 pt-2">
                          <span
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.effectAllowed = "move";
                              setDragId(m.id);
                            }}
                            onDragEnd={() => {
                              setDragId(null);
                              setOverId(null);
                            }}
                            className="cursor-grab active:cursor-grabbing text-slate-300 hover:text-[#005BAC] inline-block"
                            title="Kéo để đổi vị trí"
                          >
                            <GripVertical size={14} />
                          </span>
                        </td>
                      )}
                      <td className="py-1.5 pr-2 text-center font-bold text-slate-500">{i + 1}</td>
                      <td className="px-1 font-bold text-slate-700 whitespace-nowrap">{projectCode}</td>
                      <td className="px-1 text-slate-600 min-w-[160px]">{projectName}</td>
                      <td className="px-1">{textCell(m, "unit_group")}</td>
                      {editId === m.id ? (
                        <>
                          <td className="px-1 text-slate-600 whitespace-nowrap">{m.department || "—"}</td>
                          <td className="px-1 min-w-[220px]">
                            <EmployeePicker
                              value={null}
                              onChange={(emp) => emp && replaceMember(m, emp)}
                              bdhName={project.bdh_name}
                              freeText="email"
                              placeholder={`Đổi ${m.name || "người này"} sang…`}
                            />
                          </td>
                          <td className="px-1 text-slate-600 whitespace-nowrap">{m.title || "—"}</td>
                        </>
                      ) : canManage && !m.email ? (
                        <>
                          <td className="px-1">{textCell(m, "department")}</td>
                          <td className="px-1">{textCell(m, "name")}</td>
                          <td className="px-1">{textCell(m, "title")}</td>
                        </>
                      ) : (
                        <>
                          <td className="px-1 text-slate-600 whitespace-nowrap">{m.department || "—"}</td>
                          <td className="px-1 font-semibold text-slate-700 whitespace-nowrap">{m.name || m.email || "—"}</td>
                          <td className="px-1 text-slate-600 whitespace-nowrap">{m.title || "—"}</td>
                        </>
                      )}
                      <td className="px-1">{textCell(m, "project_role")}</td>
                      <td className="px-1">{textCell(m, "duty")}</td>
                      <td className="px-1">{textCell(m, "reports_to")}</td>
                      {canManage && !m.email ? (
                        <>
                          <td className="px-1">{textCell(m, "phone")}</td>
                          <td className="px-1">{textCell(m, "contact_email")}</td>
                        </>
                      ) : (
                        <>
                          <td className="px-1 text-slate-600 whitespace-nowrap font-mono">{m.phone || "—"}</td>
                          <td className="px-1 text-slate-600 whitespace-nowrap">{m.contact_email || m.email || "Chưa có"}</td>
                        </>
                      )}
                      <td className="px-1">
                        {canManage ? (
                          <select
                            value={m.status || "JOINED"}
                            onChange={(e) => patch(m, { status: e.target.value as PcMemberStatus })}
                            className={`${inputCls} !py-1 !px-2 !text-[11px] min-w-[150px]`}
                          >
                            {MEMBER_STATUSES.map((s) => (
                              <option key={s.value} value={s.value}>
                                {s.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${st.cls}`}>{st.label}</span>
                        )}
                      </td>
                      <td className="px-1">
                        {canManage ? (
                          <select
                            value={m.role}
                            onChange={(e) => patch(m, { role: e.target.value as PcRole })}
                            className={`${inputCls} !py-1 !px-2 !text-[11px] min-w-[130px]`}
                          >
                            {/* Dòng gán tay cũ (GDDA/TC_KT) vẫn hiện đúng nhãn, đổi sang Xem/Chỉnh sửa được. */}
                            {!ROLES.some((r) => r.value === m.role) && <option value={m.role}>{roleLabel(m.role)}</option>}
                            {ROLES.map((r) => (
                              <option key={r.value} value={r.value}>
                                {r.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-50 text-[#005BAC] whitespace-nowrap">
                            {roleLabel(m.role)}
                          </span>
                        )}
                      </td>
                      {canManage && (
                        <td className="px-1 text-center whitespace-nowrap">
                          <button
                            onClick={() => setEditId(editId === m.id ? null : m.id)}
                            className={`mr-1.5 ${editId === m.id ? "text-[#005BAC]" : "text-slate-300 hover:text-[#005BAC]"}`}
                            title={editId === m.id ? "Huỷ đổi người" : "Đổi sang người khác"}
                          >
                            {editId === m.id ? <X size={13} /> : <Pencil size={13} />}
                          </button>
                          <button onClick={() => remove(m)} className="text-slate-300 hover:text-rose-500" title="Gỡ thành viên">
                            <Trash2 size={13} />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// Độ rộng tối thiểu cho các cột gõ tay — cột chữ dài rộng hơn để ít phải xuống dòng.
const TEXT_COL_WIDTH: Record<TextKey, string> = {
  unit_group: "min-w-[140px]",
  project_role: "min-w-[240px]",
  duty: "min-w-[260px]",
  reports_to: "min-w-[160px]",
  name: "min-w-[150px]",
  department: "min-w-[130px]",
  title: "min-w-[130px]",
  phone: "min-w-[110px]",
  contact_email: "min-w-[180px]",
};

// Ô nhiều dòng tự cao theo nội dung (không bị cắt chữ như input 1 dòng).
function AutoTextarea({ initial, className, onCommit }: { initial: string; className: string; onCommit: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  useLayoutEffect(fit, []);
  return (
    <textarea
      ref={ref}
      rows={1}
      defaultValue={initial}
      onInput={fit}
      onBlur={(e) => onCommit(e.target.value)}
      className={`${className} block resize-none overflow-hidden leading-snug whitespace-pre-wrap break-words`}
    />
  );
}

// Dữ liệu thành viên -> hàng xuất file (dùng chung cho PDF và Excel).
function toPdfRows(members: PcMember[]): MembersPdfRow[] {
  return members.map((m) => {
    const status = m.status || "JOINED";
    return {
      name: m.name || m.email || "",
      unitGroup: m.unit_group || "",
      department: m.department || "",
      title: m.title || "",
      projectRole: m.project_role || "",
      duty: m.duty || "",
      reportsTo: m.reports_to || "",
      phone: m.phone || "",
      email: m.contact_email || m.email || "Chưa có",
      status,
      statusLabel: MEMBER_STATUSES.find((x) => x.value === status)?.label || "",
      role: m.role,
      roleLabel: roleLabel(m.role),
    };
  });
}

// Xuất PDF: dựng file ngay trong trình duyệt bằng pdfmake (font Roboto kèm sẵn, đủ
// dấu tiếng Việt) rồi tải thẳng về máy. Thư viện chỉ nạp khi bấm nút. Bố cục/màu
// nằm ở membersPdf.ts.
async function exportMembersPdf(
  members: PcMember[],
  meta: { projectCode: string; projectName: string; bdhName: string }
): Promise<void> {
  const [pdfMake, vfsMod] = await Promise.all([import("pdfmake/build/pdfmake"), import("pdfmake/build/vfs_fonts")]);
  pdfMake.addVirtualFileSystem(vfsMod.default);

  const now = new Date();
  const today = now.toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  const stamp = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }); // yyyy-mm-dd
  const rows = toPdfRows(members);
  const doc = buildMembersPdfDoc(rows, { ...meta, today });
  await pdfMake.createPdf(doc as Parameters<typeof pdfMake.createPdf>[0]).download(`DS-thanh-vien-${meta.projectCode || "du-an"}-${stamp}.pdf`);
}

// Tải Excel: dựng workbook mới bằng exceljs (đã có sẵn trong dự án), tải thẳng về máy.
// Thư viện chỉ nạp khi bấm nút. Bố cục/màu ở membersXlsx.ts, dùng chung với bản PDF.
async function exportMembersXlsx(
  members: PcMember[],
  meta: { projectCode: string; projectName: string; bdhName: string }
): Promise<void> {
  const ExcelJS = (await import("exceljs")).default;
  const now = new Date();
  const today = now.toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  const stamp = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }); // yyyy-mm-dd
  const wb = await buildMembersWorkbook(ExcelJS.Workbook, toPdfRows(members), { ...meta, today });
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `DS-thanh-vien-${meta.projectCode || "du-an"}-${stamp}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
