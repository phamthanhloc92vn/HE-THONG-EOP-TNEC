"use client";

// ============================================================
// CHẤM CÔNG GPS — trang nhân sự BĐH chấm công tại công trường (mobile-first).
//
// Luồng: nhận diện BĐH -> lấy GPS -> nếu NGOÀI bán kính thì popup + dừng (không
// mở camera, không ghi) -> nếu trong vùng thì ép chụp ảnh (overlay giờ + toạ độ
// + dự án, nén < 2MB) -> upload storage + insert gps_checkins. Giờ chính thức,
// khoảng cách và tính hợp lệ đều do TRIGGER server quyết (xem migration 067).
//
// HTTPS bắt buộc: Geolocation + camera chỉ chạy trên https:// hoặc localhost.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import Sidebar from "@/components/Sidebar";
import Header from "@/components/Header";
import { supabase } from "@/lib/supabase";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { emailFieldMatches } from "@/lib/emailMatch";
import { useDepartments, OFFICE_LOCATION_NAME } from "@/lib/departments";
import { parseLatLng } from "@/app/vi-tri-du-an/LocationEditor";
import {
  MapPin, Navigation, Camera, Loader2, LogIn, LogOut, AlertTriangle,
  CheckCircle2, X, RefreshCw, ShieldAlert, SwitchCamera,
} from "lucide-react";

type LocRow = {
  bdh_name: string;
  lat: number;
  lng: number;
  radius_m: number | null;
  shift_in: string | null;
  shift_out: string | null;
};

type Phase = "idle" | "locating" | "camera" | "uploading";
type Kind = "in" | "out";

// Haversine (mét) — trùng công thức hàm gps_distance_m ở server.
function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const r = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const hhmm = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Ho_Chi_Minh",
  }).format(d);

const todayVN = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());

export default function GpsCheckinPage() {
  const user = useCurrentUser();
  const deps = useDepartments();

  // Đơn vị mục tiêu: BĐH hoặc phòng ban (khối Văn phòng) của người dùng; Admin
  // (hoặc người chưa xếp đơn vị) được chọn tay để kiểm thử/hỗ trợ.
  const [selectedBdh, setSelectedBdh] = useState<string>("");
  const isBdhStaff = !user.loading &&
    (deps.bdh.includes(user.department) || deps.phongBan.includes(user.department));
  const canPick = !user.loading && (user.isAdmin || !isBdhStaff);
  const activeBdh = isBdhStaff ? user.department : selectedBdh;
  // Phòng ban dùng chung toạ độ "Văn phòng công ty"; BĐH dùng toạ độ của chính BĐH.
  const isOffice = deps.phongBan.includes(activeBdh);
  const locName = isOffice ? OFFICE_LOCATION_NAME : activeBdh;
  const canEditOffice = !user.loading && user.isAdmin;

  const [loc, setLoc] = useState<LocRow | null>(null);
  const [locLoading, setLocLoading] = useState(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [pendingKind, setPendingKind] = useState<Kind>("in");
  const [facing, setFacing] = useState<"environment" | "user">("environment"); // mặc định cam sau
  const [gps, setGps] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  const [dist, setDist] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [alertMsg, setAlertMsg] = useState("");
  const [okMsg, setOkMsg] = useState("");

  // Trạng thái đã chấm hôm nay
  const [doneIn, setDoneIn] = useState<string | null>(null);   // giờ đã chấm VÀO
  const [doneOut, setDoneOut] = useState<string | null>(null); // giờ đã chấm RA

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Chống bấm trùng trong lúc ghi.
  const busyRef = useRef(false);

  const empRef = useRef<{ code: string; name: string }>({ code: "", name: "" });

  // ─── Lấy mã NV + tên chuẩn từ danh bạ (dùng cho bản ghi) ───
  useEffect(() => {
    if (user.loading || !user.email) return;
    (async () => {
      const { data } = await supabase
        .from("employees_directory")
        .select("name, employee_code, email")
        .ilike("email", `%${user.email}%`);
      const row = (data || []).find((r) => emailFieldMatches(r.email, user.email));
      empRef.current = { code: row?.employee_code || "", name: row?.name || user.name };
    })();
  }, [user.loading, user.email, user.name]);

  // ─── Tải toạ độ BĐH đang chọn ───
  const loadLoc = useCallback(async (bdh: string) => {
    if (!bdh) { setLoc(null); return; }
    setLocLoading(true);
    const { data } = await supabase
      .from("project_locations")
      .select("bdh_name, lat, lng, radius_m, shift_in, shift_out")
      .eq("bdh_name", bdh)
      .limit(1);
    setLoc((data?.[0] as LocRow) || null);
    setLocLoading(false);
  }, []);

  // ─── Trạng thái đã chấm hôm nay ───
  const loadToday = useCallback(async () => {
    if (user.loading || !user.email) return;
    const { data } = await supabase
      .from("gps_checkins")
      .select("kind, captured_at")
      .ilike("user_email", user.email)
      .eq("is_valid", true)
      .order("captured_at", { ascending: false })
      .limit(50);
    const today = todayVN();
    let din: string | null = null, dout: string | null = null;
    (data || []).forEach((r: { kind: string; captured_at: string }) => {
      const d = new Date(r.captured_at);
      const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(d);
      if (dayKey !== today) return;
      if (r.kind === "in" && !din) din = hhmm(d);
      if (r.kind === "out" && !dout) dout = hhmm(d);
    });
    setDoneIn(din);
    setDoneOut(dout);
  }, [user.loading, user.email]);

  useEffect(() => { if (locName) loadLoc(locName); }, [locName, loadLoc]);

  // ─── Ghim toạ độ Văn phòng công ty (Admin / cờ quản lý vị trí dự án) ───
  const [officeForm, setOfficeForm] = useState({ link: "", radius: "100", shiftIn: "08:00", shiftOut: "17:00" });
  const [officeMsg, setOfficeMsg] = useState("");
  const [officeSaving, setOfficeSaving] = useState(false);
  useEffect(() => {
    if (!isOffice || !loc) return;
    setOfficeForm({
      link: `${loc.lat}, ${loc.lng}`,
      radius: String(loc.radius_m ?? 100),
      shiftIn: loc.shift_in || "08:00",
      shiftOut: loc.shift_out || "17:00",
    });
  }, [isOffice, loc]);

  async function saveOffice() {
    const coords = parseLatLng(officeForm.link);
    if (!coords) { setOfficeMsg("Không đọc được toạ độ. Dán link Google Maps đầy đủ hoặc dạng \"10.77, 106.70\"."); return; }
    setOfficeSaving(true);
    const { error } = await supabase.from("project_locations").upsert({
      bdh_name: OFFICE_LOCATION_NAME,
      name: OFFICE_LOCATION_NAME,
      lat: coords[0],
      lng: coords[1],
      radius_m: Math.max(10, parseInt(officeForm.radius) || 100),
      shift_in: officeForm.shiftIn,
      shift_out: officeForm.shiftOut,
    }, { onConflict: "bdh_name" });
    setOfficeSaving(false);
    setOfficeMsg(error ? error.message : "Đã lưu vị trí Văn phòng công ty.");
    if (!error) loadLoc(OFFICE_LOCATION_NAME);
  }
  useEffect(() => { loadToday(); }, [loadToday]);

  // ─── Dọn camera khi rời trang ───
  useEffect(() => () => stopCamera(), []);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  function bindStream(stream: MediaStream) {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch(() => {});
    }
  }

  async function getCamStream(f: "environment" | "user"): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: f }, audio: false });
  }

  async function openCamera(kind: Kind) {
    try {
      const stream = await getCamStream(facing);
      streamRef.current = stream;
      setPendingKind(kind);
      setPhase("camera");
      // gán stream sau khi <video> đã render
      setTimeout(() => bindStream(stream), 60);
    } catch {
      setErr("Không mở được camera. Kiểm tra quyền camera của trình duyệt.");
      setPhase("idle");
    }
  }

  // ─── Đổi camera trước ↔ sau ───
  async function switchCamera() {
    if (phase === "uploading") return;
    const next = facing === "environment" ? "user" : "environment";
    setFacing(next);
    try {
      stopCamera();
      const stream = await getCamStream(next);
      streamRef.current = stream;
      bindStream(stream);
    } catch {
      // Máy chỉ có 1 camera / trình duyệt từ chối -> quay lại camera cũ.
      setFacing(facing);
      try {
        const back = await getCamStream(facing);
        streamRef.current = back;
        bindStream(back);
      } catch {
        setErr("Không chuyển được camera trên thiết bị này.");
      }
    }
  }

  // ─── Bấm VÀO / RA: lấy GPS, chặn ngoài vùng, mở camera ───
  function startCheckin(kind: Kind) {
    setErr(""); setOkMsg("");
    if (!loc) {
      setErr(isOffice
        ? "Văn phòng công ty chưa được ghim toạ độ — báo HR/Admin cập nhật tại trang này."
        : "BĐH chưa được ghim toạ độ — báo HR/Admin cập nhật ở Vị trí dự án.");
      return;
    }
    if (!navigator.geolocation) { setErr("Thiết bị không hỗ trợ định vị GPS."); return; }
    const radius = loc.radius_m ?? 100;
    setPhase("locating");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        setGps({ lat: latitude, lng: longitude, acc: accuracy });
        const d = distanceM(latitude, longitude, loc.lat, loc.lng);
        setDist(d);
        if (accuracy > 100) {
          setAlertMsg(`Bạn đang cách ${isOffice ? "Văn phòng công ty" : "vị trí BĐH"} ~${Math.round(d)}m (bán kính ${radius}m).\n\nTín hiệu GPS quá yếu (sai số ~${Math.round(accuracy)}m). Ra nơi thoáng, bật GPS độ chính xác cao rồi thử lại.`);
          setPhase("idle"); return;
        }
        if (d > radius) {
          setAlertMsg(`Bạn đang cách ${isOffice ? "Văn phòng công ty" : "vị trí BĐH"} ~${Math.round(d)}m, ngoài bán kính ${radius}m.\n\nHệ thống KHÔNG ghi nhận lượt chấm ngoài vùng.`);
          setPhase("idle"); return;
        }
        openCamera(kind);
      },
      () => { setErr("Không lấy được vị trí. Hãy cấp quyền định vị cho trình duyệt."); setPhase("idle"); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  // ─── Chụp ảnh + overlay + nén < 2MB, upload, insert ───
  async function capture() {
    if (busyRef.current) return;
    const video = videoRef.current;
    if (!video || !gps || !loc) return;
    busyRef.current = true;
    setPhase("uploading");
    try {
      const w = video.videoWidth || 720;
      const h = video.videoHeight || 960;
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(video, 0, 0, w, h);

      // Overlay minh chứng ở đáy ảnh
      const now = new Date();
      const lines = [
        `${activeBdh}`,
        `${new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "medium", timeZone: "Asia/Ho_Chi_Minh" }).format(now)}`,
        `GPS: ${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)} (±${Math.round(gps.acc)}m)`,
        `Cách ${isOffice ? "VP" : "BĐH"}: ~${Math.round(dist ?? 0)}m`,
      ];
      const pad = Math.round(w * 0.03);
      const fs = Math.max(16, Math.round(w * 0.032));
      const lh = Math.round(fs * 1.35);
      const boxH = lh * lines.length + pad;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, h - boxH, w, boxH);
      ctx.fillStyle = "#fff";
      ctx.font = `600 ${fs}px system-ui, sans-serif`;
      ctx.textBaseline = "top";
      lines.forEach((ln, i) => ctx.fillText(ln, pad, h - boxH + pad / 2 + i * lh));

      const MAX_BYTES = 2 * 1024 * 1024;
      const encode = (q: number): Promise<Blob> =>
        new Promise((res, rej) =>
          canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/jpeg", q));
      let quality = 0.7, blob = await encode(quality);
      while (blob.size > MAX_BYTES && quality > 0.3) { quality -= 0.15; blob = await encode(quality); }
      if (blob.size > MAX_BYTES) throw new Error("Ảnh quá lớn (>2MB), thử lại.");

      const ym = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", timeZone: "Asia/Ho_Chi_Minh" })
        .format(now).slice(0, 7);
      const path = `${user.email}/${ym}/${crypto.randomUUID()}.jpg`;
      const up = await supabase.storage.from("gps-checkins").upload(path, blob, {
        contentType: "image/jpeg", upsert: false,
      });
      if (up.error) throw new Error(up.error.message);

      const ins = await supabase.from("gps_checkins").insert({
        user_email: user.email,
        employee_code: empRef.current.code || null,
        employee_name: empRef.current.name || user.name,
        bdh_name: activeBdh,
        kind: pendingKind,
        lat: gps.lat,
        lng: gps.lng,
        accuracy_m: gps.acc,
        photo_path: path,
        device: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 200) : null,
      });
      if (ins.error) {
        // Ghi hỏng -> gỡ ảnh vừa upload để không rác kho.
        await supabase.storage.from("gps-checkins").remove([path]);
        throw new Error(ins.error.message);
      }

      stopCamera();
      setPhase("idle");
      setOkMsg(`Đã chấm ${pendingKind === "in" ? "VÀO" : "RA"} lúc ${hhmm(now)} tại ${activeBdh}.`);
      loadToday();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Ghi nhận thất bại, thử lại.");
      setPhase("camera");
    } finally {
      busyRef.current = false;
    }
  }

  function cancelCamera() {
    stopCamera();
    setPhase("idle");
    setErr("");
  }

  const radius = loc?.radius_m ?? 100;

  // ─── Người không thuộc BĐH & không phải Admin: chặn ───
  const blocked = !user.loading && !isBdhStaff && !user.isAdmin;

  return (
    <div className="flex min-h-screen bg-[#F7F9FC]">
      <Sidebar />
      <div className="ml-0 lg:ml-60 flex-1 flex flex-col min-w-0">
        <Header title="Chấm công GPS" subtitle="Điểm danh tại công trường / văn phòng bằng GPS + ảnh" />
        <main className="flex-1 p-4 sm:p-6 flex justify-center">
          <div className="w-full max-w-md space-y-4">

            {blocked ? (
              <div className="glass bg-white rounded-2xl p-6 border border-slate-200/50 shadow-premium text-center space-y-3">
                <div className="w-14 h-14 rounded-2xl bg-amber-50 text-amber-500 flex items-center justify-center mx-auto">
                  <ShieldAlert size={26} />
                </div>
                <h3 className="font-heading font-extrabold text-slate-800 text-sm">Chưa thuộc phòng ban / BĐH</h3>
                <p className="text-xs text-slate-500 leading-relaxed">
                  Chấm công GPS dành cho nhân sự Văn phòng công ty và các Ban điều hành dự án. Tài khoản của bạn
                  ({user.department || "chưa xếp phòng"}) không thuộc phòng ban / BĐH nào.
                </p>
              </div>
            ) : (
              <>
                {/* Chọn BĐH (Admin / người hỗ trợ) */}
                {canPick && (
                  <div className="glass bg-white rounded-2xl p-4 border border-slate-200/50 shadow-premium space-y-2">
                    <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500">
                      <MapPin size={12} className="text-[#005BAC]" /> Chọn phòng ban / Ban điều hành
                    </label>
                    <select
                      value={selectedBdh}
                      onChange={(e) => setSelectedBdh(e.target.value)}
                      className="w-full text-sm font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:border-[#00AEEF]"
                    >
                      <option value="">-- Chọn đơn vị --</option>
                      <optgroup label="Văn phòng công ty">
                        {deps.phongBan.map((b) => <option key={b} value={b}>{b}</option>)}
                      </optgroup>
                      <optgroup label="Ban điều hành">
                        {deps.bdh.map((b) => <option key={b} value={b}>{b}</option>)}
                      </optgroup>
                    </select>
                  </div>
                )}

                {/* Thẻ BĐH + trạng thái định vị */}
                <div className="glass bg-white rounded-2xl p-5 border border-slate-200/50 shadow-premium space-y-4">
                  <div className="flex items-start gap-3">
                    <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-blue-600 to-cyan-500 flex items-center justify-center shadow-md shadow-blue-500/25 shrink-0">
                      <MapPin size={20} className="text-white" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-heading font-extrabold text-slate-800 text-sm truncate">
                        {activeBdh || "Chưa chọn đơn vị"}
                      </p>
                      {isOffice && <p className="text-[10px] text-slate-400 font-semibold">{OFFICE_LOCATION_NAME}</p>}
                      {locLoading ? (
                        <p className="text-[11px] text-slate-400 font-semibold flex items-center gap-1 mt-0.5">
                          <Loader2 size={11} className="animate-spin" /> Đang tải vị trí…
                        </p>
                      ) : loc ? (
                        <p className="text-[11px] text-emerald-600 font-bold mt-0.5">
                          Đã định vị · bán kính {radius}m · ca {loc.shift_in || "08:00"}–{loc.shift_out || "17:00"}
                        </p>
                      ) : activeBdh ? (
                        <p className="text-[11px] text-rose-500 font-bold mt-0.5">Chưa ghim toạ độ</p>
                      ) : (
                        <p className="text-[11px] text-slate-400 font-semibold mt-0.5">—</p>
                      )}
                    </div>
                    <button
                      onClick={() => { loadLoc(locName); loadToday(); }}
                      className="p-2 text-slate-400 hover:text-[#005BAC] hover:bg-blue-50 rounded-xl transition-all"
                      title="Tải lại"
                    >
                      <RefreshCw size={15} />
                    </button>
                  </div>

                  {/* Trạng thái đã chấm hôm nay */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className={`rounded-xl border p-3 text-center ${doneIn ? "bg-emerald-50 border-emerald-100" : "bg-slate-50 border-slate-100"}`}>
                      <p className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400">Vào (sáng)</p>
                      <p className={`text-lg font-black mt-0.5 ${doneIn ? "text-emerald-600" : "text-slate-300"}`}>{doneIn || "--:--"}</p>
                    </div>
                    <div className={`rounded-xl border p-3 text-center ${doneOut ? "bg-blue-50 border-blue-100" : "bg-slate-50 border-slate-100"}`}>
                      <p className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400">Ra (chiều)</p>
                      <p className={`text-lg font-black mt-0.5 ${doneOut ? "text-[#005BAC]" : "text-slate-300"}`}>{doneOut || "--:--"}</p>
                    </div>
                  </div>

                  {/* Nút VÀO / RA */}
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => startCheckin("in")}
                      disabled={!loc || !!doneIn || phase === "locating" || phase === "uploading"}
                      className="flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-sm shadow-sm shadow-emerald-500/20 transition-all active:scale-[0.98]"
                    >
                      <LogIn size={17} /> {doneIn ? "Đã chấm vào" : "Chấm VÀO"}
                    </button>
                    <button
                      onClick={() => startCheckin("out")}
                      disabled={!loc || !!doneOut || phase === "locating" || phase === "uploading"}
                      className="flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-[#005BAC] hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-sm shadow-sm shadow-blue-500/20 transition-all active:scale-[0.98]"
                    >
                      <LogOut size={17} /> {doneOut ? "Đã chấm ra" : "Chấm RA"}
                    </button>
                  </div>

                  {phase === "locating" && (
                    <p className="flex items-center justify-center gap-2 text-xs font-semibold text-[#005BAC]">
                      <Navigation size={13} className="animate-pulse" /> Đang lấy vị trí GPS…
                    </p>
                  )}
                  {err && (
                    <p className="flex items-start gap-1.5 text-[11px] font-semibold text-rose-500">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {err}
                    </p>
                  )}
                  {okMsg && (
                    <p className="flex items-start gap-1.5 text-[11px] font-bold text-emerald-600">
                      <CheckCircle2 size={13} className="mt-0.5 shrink-0" /> {okMsg}
                    </p>
                  )}
                </div>

                {/* Ghim vị trí Văn phòng công ty (dùng chung mọi phòng ban) */}
                {isOffice && canEditOffice && (
                  <div className="glass bg-white rounded-2xl p-4 border border-slate-200/50 shadow-premium space-y-2.5">
                    <p className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500">
                      <MapPin size={12} className="text-[#005BAC]" /> Vị trí {OFFICE_LOCATION_NAME} (áp cho mọi phòng ban)
                    </p>
                    <input
                      value={officeForm.link}
                      onChange={(e) => setOfficeForm((f) => ({ ...f, link: e.target.value }))}
                      placeholder="Dán link Google Maps hoặc toạ độ 10.77, 106.70"
                      className="w-full text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:border-[#00AEEF]"
                    />
                    <div className="grid grid-cols-3 gap-2">
                      <label className="text-[10px] font-bold text-slate-400">Bán kính (m)
                        <input type="number" min={10} value={officeForm.radius}
                          onChange={(e) => setOfficeForm((f) => ({ ...f, radius: e.target.value }))}
                          className="mt-1 w-full text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-xl px-2 py-2 focus:outline-none focus:border-[#00AEEF]" />
                      </label>
                      <label className="text-[10px] font-bold text-slate-400">Giờ vào
                        <input type="time" value={officeForm.shiftIn}
                          onChange={(e) => setOfficeForm((f) => ({ ...f, shiftIn: e.target.value }))}
                          className="mt-1 w-full text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-xl px-2 py-2 focus:outline-none focus:border-[#00AEEF]" />
                      </label>
                      <label className="text-[10px] font-bold text-slate-400">Giờ ra
                        <input type="time" value={officeForm.shiftOut}
                          onChange={(e) => setOfficeForm((f) => ({ ...f, shiftOut: e.target.value }))}
                          className="mt-1 w-full text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-xl px-2 py-2 focus:outline-none focus:border-[#00AEEF]" />
                      </label>
                    </div>
                    <button
                      onClick={saveOffice}
                      disabled={officeSaving}
                      className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#005BAC] hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-xs"
                    >
                      {officeSaving ? <Loader2 size={13} className="animate-spin" /> : <MapPin size={13} />} Lưu vị trí văn phòng
                    </button>
                    {officeMsg && <p className="text-[11px] font-semibold text-slate-500">{officeMsg}</p>}
                  </div>
                )}
              </>
            )}
          </div>
        </main>
      </div>

      {/* Camera overlay */}
      {phase === "camera" || phase === "uploading" ? (
        <div className="fixed inset-0 z-[100] bg-black flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 text-white">
            <span className="font-bold text-sm flex items-center gap-2">
              <Camera size={16} /> Chụp ảnh chấm {pendingKind === "in" ? "VÀO" : "RA"}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={switchCamera}
                disabled={phase === "uploading"}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20 text-[11px] font-bold disabled:opacity-50"
                title="Đổi camera trước / sau"
              >
                <SwitchCamera size={16} /> {facing === "environment" ? "Cam sau" : "Cam trước"}
              </button>
              <button onClick={cancelCamera} className="p-2 rounded-full hover:bg-white/10" title="Huỷ">
                <X size={20} />
              </button>
            </div>
          </div>
          <div className="flex-1 relative overflow-hidden flex items-center justify-center">
            <video
              ref={videoRef}
              playsInline
              muted
              className="max-h-full max-w-full object-contain"
              style={{ transform: facing === "user" ? "scaleX(-1)" : undefined }}
            />
            <div className="absolute bottom-3 left-3 right-3 text-white text-[11px] font-semibold bg-black/50 rounded-xl px-3 py-2 space-y-0.5">
              <p>{activeBdh}</p>
              {gps && <p>GPS: {gps.lat.toFixed(6)}, {gps.lng.toFixed(6)} · cách {isOffice ? "VP" : "BĐH"} ~{Math.round(dist ?? 0)}m</p>}
            </div>
          </div>
          {err && (
            <p className="flex items-start gap-1.5 px-5 pt-3 bg-black text-[12px] font-semibold text-rose-400">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {err}
            </p>
          )}
          <div className="p-5 flex justify-center bg-black">
            <button
              onClick={capture}
              disabled={phase === "uploading"}
              className="flex items-center gap-2 px-8 py-3.5 rounded-2xl bg-white text-slate-900 font-bold text-sm disabled:opacity-60 active:scale-95 transition-all"
            >
              {phase === "uploading"
                ? (<><Loader2 size={17} className="animate-spin" /> Đang ghi nhận…</>)
                : (<><Camera size={17} /> Chụp & ghi nhận</>)}
            </button>
          </div>
        </div>
      ) : null}

      {/* Popup ngoài phạm vi / GPS yếu */}
      {alertMsg && (
        <div onClick={() => setAlertMsg("")} className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-3xl shadow-2xl max-w-sm w-full p-6 text-center space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-rose-50 text-rose-500 flex items-center justify-center mx-auto"><AlertTriangle size={26} /></div>
            <h3 className="font-heading font-extrabold text-slate-800 text-base">Ngoài phạm vi chấm công</h3>
            <p className="text-xs text-slate-500 leading-relaxed whitespace-pre-line">{alertMsg}</p>
            <button onClick={() => setAlertMsg("")} className="w-full py-3 rounded-2xl bg-[#005BAC] text-white font-bold text-sm">Đã hiểu</button>
          </div>
        </div>
      )}
    </div>
  );
}
