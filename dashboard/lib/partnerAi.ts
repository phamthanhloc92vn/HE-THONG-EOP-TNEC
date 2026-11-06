"use client";

// ============================================================
// partnerAi.ts — Nhập Danh bạ đối tác bằng AI (GPT-6.1 Sol)
//
// Nguồn: ảnh chụp (danh thiếp, tin nhắn Zalo/Viber, hồ sơ năng lực), PDF, mã QR trong
// ảnh, Excel/CSV, Word, văn bản dán vào. AI trả về danh sách đối tác -> người dùng
// XEM LẠI rồi mới lưu (không tự lưu).
//
// GỌI OPENAI THẲNG TỪ TRÌNH DUYỆT (cùng khuôn paymentDossierExtract / meetingOpenAI):
// Vercel gói Free cắt hàm ở 60 giây và giới hạn thân yêu cầu 4.5MB — ảnh chụp điện thoại
// và PDF hồ sơ năng lực vượt cả hai. Khoá nằm trong localStorage của chính người dùng,
// KHÔNG đi qua máy chủ của hệ thống. Khoá dùng chung `openai_api_key_hanh_chinh` với các
// module khác (nhập một lần chạy mọi nơi); model riêng của module này, mặc định gpt-6.1-sol.
// ============================================================

import OpenAI from "openai";
import {
  type PartnerInput,
  type PartnerKind,
  type PartnerRegion,
  type PartnerRow,
  emptyInput,
  inputFromRow,
  cleanTaxCode,
  REGION_ORDER,
  REGION_LABELS,
} from "./partnerDirectory";
import { normalizeName } from "./approvers";
import { findProvinces, regionsFromWords, norm as vnNorm } from "./vnRegions";

// ─── Cấu hình khoá + model ───
const KEY_SHARED = "openai_api_key_hanh_chinh";
const KEY_LEGACY = "openai_api_key";
const MODEL_KEY = "openai_model_doi_tac";
export const AI_MODELS = [
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol (đọc ảnh, PDF, bảng chính xác nhất)" },
  { id: "gpt-6.1-terra", label: "GPT-6.1 Terra (nhanh & rẻ hơn)" },
];
export const DEFAULT_AI_MODEL = AI_MODELS[0].id;
// Dòng 6.1 là model suy luận: KHÔNG truyền temperature, dùng reasoning_effort.
const REASONING_EFFORT = "medium" as const;

export function loadAiConfig(): { apiKey: string; model: string } {
  try {
    const saved = localStorage.getItem(MODEL_KEY) || "";
    return {
      apiKey: localStorage.getItem(KEY_SHARED) || localStorage.getItem(KEY_LEGACY) || "",
      // Model cũ (gpt-4o…) đã gỡ khỏi danh sách -> về mặc định.
      model: AI_MODELS.some((m) => m.id === saved) ? saved : DEFAULT_AI_MODEL,
    };
  } catch {
    return { apiKey: "", model: DEFAULT_AI_MODEL };
  }
}

export function saveAiConfig(apiKey: string, model: string): void {
  try {
    localStorage.setItem(KEY_SHARED, apiKey.trim());
    localStorage.setItem(MODEL_KEY, model);
  } catch {
    /* trình duyệt chặn lưu trữ: người dùng phải nhập lại lần sau */
  }
}

function client(apiKey: string) {
  return new OpenAI({ apiKey, dangerouslyAllowBrowser: true, timeout: 5 * 60 * 1000, maxRetries: 1 });
}

// ─── Prompt ───
const SYSTEM_PROMPT = `
Bạn là trợ lý nhập liệu "Danh bạ đối tác" của một công ty xây dựng tại Việt Nam. Từ ảnh danh thiếp, ảnh chụp tin nhắn Zalo/Viber, ảnh hoặc PDF hồ sơ năng lực, báo giá, bảng Excel, văn bản hoặc nội dung mã QR, hãy trích xuất thông tin các ĐỐI TÁC: nhà thầu phụ, nhà cung cấp vật tư/thiết bị, tổ đội thi công.

Trả về DUY NHẤT một JSON: { "partners": [ { ... } ] }. Mỗi đối tác một object. Một nguồn có thể chứa NHIỀU đối tác (bảng Excel nhiều dòng). Không có đối tác nào -> { "partners": [] }.

QUY TẮC TUYỆT ĐỐI: chỉ ghi thông tin CÓ TRONG NGUỒN. Không biết thì để chuỗi rỗng "" (hoặc mảng rỗng []). KHÔNG bịa số điện thoại, email, mã số thuế, địa chỉ. KHÔNG suy ra mã số thuế từ tên công ty.

Mỗi object có các khoá sau:
- "kind": "nha_thau_phu" (thi công, lắp đặt, dịch vụ chuyên môn) | "nha_cung_cap" (bán vật tư, thiết bị, hàng hoá) | "to_doi" (tổ đội, thợ, nhóm thi công nhỏ do một người đứng đầu). Không chắc thì để "".
- "name": tên doanh nghiệp / tổ đội, viết đúng chính tả tiếng Việt, KHÔNG kèm số điện thoại hay chức danh.
- "short_name": tên gọi tắt / thương hiệu nếu nguồn có (VD "Phan Vũ"), không có thì "".
- "tax_code": mã số thuế, CHỈ chữ số (10 số, hoặc 13 số dạng 0123456789-001). Không có thì "".
- "address": địa chỉ trụ sở / văn phòng.
- "website": địa chỉ website nếu có.
- "contact_name", "contact_title": NGƯỜI LIÊN HỆ cụ thể (người trên danh thiếp, người nhắn tin, cột "Người liên hệ") và chức danh của họ.
- "legal_rep_name", "legal_rep_title": NGƯỜI ĐẠI DIỆN PHÁP LUẬT — CHỈ điền khi nguồn nêu rõ "đại diện theo pháp luật" / "người đại diện". Nếu nguồn chỉ có một người thì điền vào contact_*, KHÔNG điền cả hai.
- "phone", "phone2": số điện thoại. Chuẩn hoá về dạng liền, giữ số 0 đầu (VD "0903889001", "02837816888"), bỏ dấu cách, dấu chấm, dấu gạch. Số chính vào phone, số thứ hai vào phone2.
- "email": email (chữ thường).
- "zalo", "viber", "whatsapp", "telegram": CHỈ điền khi nguồn nói rõ số/tên trên nền tảng đó (VD "Zalo: 0903...", link zalo.me/..., t.me/..., wa.me/...). Không tự gán số điện thoại thường vào các ô này.
- "regions": mảng, mỗi phần tử một trong "bac" | "trung" | "nam" | "toan_quoc". Suy từ phạm vi hoạt động hoặc từ tỉnh/thành của địa chỉ (miền Bắc: Hà Nội, Hải Phòng, Quảng Ninh, Bắc Ninh, Hưng Yên, Thái Nguyên, Phú Thọ… ; miền Trung: từ Thanh Hoá/Nghệ An tới Khánh Hoà/Lâm Đồng/Tây Nguyên, gồm Đà Nẵng, Huế; miền Nam: TP Hồ Chí Minh, Đồng Nai, Tây Ninh, Cần Thơ, miền Tây…). "toan_quoc" nếu nguồn nói toàn quốc / cả nước / hoạt động ba miền.
- "provinces": mảng tên tỉnh/thành nơi trụ sở hoặc nơi hoạt động nêu trong nguồn, viết chuẩn (VD "TP Hồ Chí Minh", "Hà Nội", "Đồng Nai", "Bình Dương").
- "fields": mảng nhóm ngành / lĩnh vực ngắn gọn, tối đa 5 (VD "Bê tông thương phẩm", "Cọc ly tâm", "Cơ điện MEP & PCCC", "Chống thấm").
- "capability": 1–3 câu tóm tắt năng lực, mặt hàng/dịch vụ chính, theo đúng nguồn, không quảng cáo thêm.
- "source": nơi/người cung cấp thông tin về đối tác nếu nguồn ghi rõ (VD "Mr Lộc giới thiệu", "FB Ads", "Hotline", "Zalo của Ms Thương"); không có thì "".
- "note": thông tin hữu ích khác không có ô riêng (VD "Báo giá có hiệu lực 30 ngày"), ngắn gọn; không có thì "".
- "uncertain": mảng tên các khoá ở trên mà bạn KHÔNG chắc chắn (chữ mờ, nhập nhằng, suy đoán).

SỐ ĐIỆN THOẠI — QUY TẮC NGHIÊM NGẶT (sai một chữ số là mất liên lạc với đối tác):
- Chép ĐÚNG TỪNG CHỮ SỐ như nhìn thấy. KHÔNG sửa, KHÔNG thêm, KHÔNG bớt, KHÔNG "hoàn chỉnh" số cho đủ 10 chữ số, KHÔNG suy luận số từ số khác.
- Chữ số mờ, bị che, bị cắt ở mép ảnh, hoặc không chắc: KHÔNG đoán. Để trống ô số đó, ghi tên khoá vào "uncertain", và ghi số đọc dở vào "note" (VD "SĐT đọc dở: 0909 0488 4?").
- Số bị GẠCH NGANG / gạch xoá là số cũ đã huỷ: KHÔNG dùng làm phone. Số VIẾT TAY đè lên hoặc ghi bên cạnh là số mới: dùng số viết tay (nếu đọc rõ), và ghi "phone" vào "uncertain" vì chữ viết tay dễ đọc nhầm.
- Số điện thoại Việt Nam hợp lệ: di động 10 chữ số, bắt đầu 03, 05, 07, 08 hoặc 09; cố định bắt đầu 02 (10–11 chữ số); tổng đài 1800/1900. Đọc ra số không khớp dạng này thì xem là đọc sai: để trống và ghi vào "uncertain".
- Giữ đúng nhóm chữ số như in, chỉ bỏ khoảng trắng, dấu chấm, dấu gạch: "0834 70 75 79" -> "0834707579".
- Số có nhãn "M" / "Mobile" / "DĐ" cạnh tên một cá nhân là số của người đó -> phone. Số có nhãn "T" / "Tel" / "ĐT" thuộc khối thông tin công ty -> điền phone2 nếu đã có số cá nhân, nếu không có số cá nhân thì điền phone.
- Ảnh có thể bị XOAY NGANG hoặc ngược (ảnh chụp danh thiếp nằm trên bàn): hãy đọc đúng chiều chữ, không bỏ sót số vì ảnh bị xoay.
KHÔNG trích số tài khoản ngân hàng (hệ thống danh bạ không lưu). Nếu nguồn là mã QR chuyển khoản VietQR thì chỉ lấy tên đơn vị nhận nếu có.

Về nội dung mã QR (nếu được cung cấp): có thể là vCard (BEGIN:VCARD…, FN/ORG/TEL/EMAIL/ADR), link Zalo (zalo.me/số), link website/Facebook, hoặc văn bản. Dùng đúng thông tin trong đó.

Về bảng Excel/CSV: tiêu đề cột có thể gọi khác nhau (Tên công ty, Đơn vị, MST, Mã số thuế, SĐT, Điện thoại, Người liên hệ, Chức vụ, Khu vực, Tỉnh, Lĩnh vực, Ghi chú…). Hãy ánh xạ cột theo ý nghĩa. Bỏ qua dòng tiêu đề, dòng tổng, dòng trống. Mỗi dòng dữ liệu là một đối tác.
`.trim();

// ─── Kiểu dữ liệu ───
export type AiSource =
  | { id: string; kind: "file"; name: string; file: File }
  | { id: string; kind: "text"; name: string; text: string };

export type AiItem = {
  id: string;
  source: string;
  input: PartnerInput;
  uncertain: string[];
  // Lý do trùng với đối tác đã có / đã trích trước đó (null = không trùng). Chỉ CẢNH BÁO.
  dup: string | null;
  // Chế độ "ghi đè": id đối tác đã có trong danh bạ sẽ được cập nhật bằng dữ liệu của mục này
  // (khớp theo MST, hoặc đúng tên). null = thêm mới.
  matchId: string | null;
  matchName: string | null;
  // Số dòng trùng trong chính tệp đã được gộp vào mục này (chế độ ghi đè).
  merged: number;
  action?: "created" | "updated";
  selected: boolean;
  status: "idle" | "saving" | "saved" | "error";
  error?: string;
  // "searching" = nguồn không có MST, AI đang tìm theo tên + khu vực (xem findTaxCodeByName).
  tax: "none" | "searching" | "pending" | "done" | "notfound" | "error";
  // MST do AI tìm trên web (đã đối chiếu tên với nguồn tra cứu), không phải bóc từ nguồn.
  taxByAi?: boolean;
  // Vì sao AI tìm MST không điền được (để người dùng biết mà tự kiểm tra).
  taxNote?: string;
};

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
export const SHEET_EXT = /\.(xlsx|xls|xlsm|csv)$/i;
export const MAX_SOURCE_BYTES = 30 * 1024 * 1024;

export function sourceKindOf(file: File): "image" | "pdf" | "sheet" | "word" | "text" | "heic" | "unknown" {
  const n = file.name.toLowerCase();
  if (/\.(heic|heif)$/.test(n)) return "heic";
  if (IMAGE_EXT.test(n) || file.type.startsWith("image/")) return "image";
  if (n.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
  if (SHEET_EXT.test(n)) return "sheet";
  if (/\.(docx|doc)$/.test(n)) return "word";
  if (n.endsWith(".txt") || file.type === "text/plain") return "text";
  return "unknown";
}

// ─── Đọc tệp ───
function toDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error || new Error("Không đọc được tệp"));
    r.readAsDataURL(file);
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Không mở được ảnh "${file.name}".`));
    };
    img.src = url;
  });
}

function drawScaled(img: HTMLImageElement, maxSide: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Trình duyệt không hỗ trợ xử lý ảnh.");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, ctx };
}

// Ảnh chụp điện thoại 5–10MB: thu nhỏ về cạnh dài ≤ 2000px, JPEG — đủ đọc chữ, nhẹ hơn nhiều,
// và đủ nhỏ để gửi trực tiếp. Đồng thời thử giải mã mã QR (thử 2 cỡ, vì QR nhỏ trong ảnh to
// đôi khi chỉ đọc được sau khi thu nhỏ, hoặc ngược lại).
export async function prepareImage(file: File): Promise<{ dataUrl: string; qr: string[] }> {
  const img = await loadImage(file);
  const main = drawScaled(img, 2000);
  const dataUrl = main.canvas.toDataURL("image/jpeg", 0.88);
  const found = new Set<string>();
  try {
    const { default: jsQR } = await import("jsqr");
    for (const side of [1600, 900]) {
      const { canvas, ctx } = drawScaled(img, side);
      const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const res = jsQR(id.data, id.width, id.height, { inversionAttempts: "attemptBoth" });
      if (res?.data) found.add(res.data.trim());
    }
  } catch {
    /* không giải mã được QR thì AI vẫn đọc phần chữ của ảnh */
  }
  return { dataUrl, qr: Array.from(found) };
}

// Bảng tính -> các khối văn bản CSV. Mỗi khối ≤ CHUNK dòng dữ liệu, lặp lại dòng tiêu đề.
const CHUNK_ROWS = 20;
const MAX_SHEET_ROWS = 1500;
export async function sheetToChunks(file: File): Promise<{ label: string; text: string }[]> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const out: { label: string; text: string }[] = [];
  for (const sheetName of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName], { blankrows: false });
    const lines = csv.split(/\r?\n/).filter((l) => l.replace(/[,;\s"]/g, "") !== "");
    if (lines.length === 0) continue;
    const header = lines[0];
    const rows = lines.slice(1, MAX_SHEET_ROWS + 1);
    if (rows.length === 0) {
      out.push({ label: sheetName, text: header });
      continue;
    }
    for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
      out.push({ label: `${sheetName} (dòng ${i + 1}–${Math.min(i + CHUNK_ROWS, rows.length)})`, text: `Sheet: ${sheetName}\n${header}\n${rows.slice(i, i + CHUNK_ROWS).join("\n")}` });
    }
  }
  return out;
}

async function wordToText(file: File): Promise<string> {
  type Mammoth = { extractRawText: (o: { arrayBuffer: ArrayBuffer }) => Promise<{ value?: string }> };
  // @ts-expect-error — bản browser của mammoth không kèm .d.ts
  const raw = (await import("mammoth/mammoth.browser")) as unknown as Mammoth & { default?: Mammoth };
  const mammoth: Mammoth = raw.default || raw;
  const res = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return String(res?.value || "").trim();
}

// ─── Gọi AI ───
type RawPartner = Record<string, unknown>;

async function callText(openai: OpenAI, model: string, userText: string): Promise<RawPartner[]> {
  const c = await openai.chat.completions.create({
    model,
    reasoning_effort: REASONING_EFFORT,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userText },
    ],
  });
  return parsePartners(c.choices?.[0]?.message?.content);
}

function parseImageResult(content: string | null | undefined): { partners: RawPartner[]; rotation: number } {
  const partners = parsePartners(content);
  let rotation = 0;
  try {
    const r = Number((JSON.parse(content || "{}") as { image_rotation?: unknown }).image_rotation);
    if (r === 90 || r === 180 || r === 270) rotation = r;
  } catch {
    /* parsePartners đã báo lỗi định dạng */
  }
  return { partners, rotation };
}

async function callImageOnce(openai: OpenAI, model: string, dataUrl: string, qr: string[], hint: string): Promise<{ partners: RawPartner[]; rotation: number }> {
  const qrText = qr.length ? `\n\nNội dung mã QR quét được trong ảnh:\n${qr.map((q, i) => `[QR ${i + 1}] ${q}`).join("\n")}` : "";
  const c = await openai.chat.completions.create({
    model,
    reasoning_effort: REASONING_EFFORT,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Trích xuất đối tác từ ảnh này.${hint}${qrText}\n\nNgoài khoá "partners", thêm khoá "image_rotation": số độ cần xoay ảnh THEO CHIỀU KIM ĐỒNG HỒ để chữ trong ảnh đọc xuôi, thẳng (0, 90, 180 hoặc 270; ảnh đã thẳng thì 0).`,
          },
          { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
        ],
      },
    ],
  });
  return parseImageResult(c.choices?.[0]?.message?.content);
}

// Xoay ảnh (độ, theo chiều kim đồng hồ) rồi trả về data URL mới.
async function rotateDataUrl(dataUrl: string, deg: number): Promise<string> {
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("Không xoay được ảnh."));
    img.src = dataUrl;
  });
  const swap = deg === 90 || deg === 270;
  const w = swap ? img.naturalHeight : img.naturalWidth;
  const h = swap ? img.naturalWidth : img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Trình duyệt không hỗ trợ xử lý ảnh.");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  return canvas.toDataURL("image/jpeg", 0.9);
}

// ─── Bước kiểm chứng số điện thoại ───
// Sai một chữ số là mất liên lạc nên số điện thoại được chép riêng, từng số một, bởi một lượt gọi
// chỉ làm đúng việc đó (không phải đoán cấu trúc đối tác). Số nào lượt đầu đọc khác lượt này
// thì không tin: bỏ và đánh dấu "cần kiểm tra".
const PHONE_PROMPT = `
Bạn là công cụ CHÉP SỐ ĐIỆN THOẠI từ ảnh. Nhiệm vụ duy nhất: liệt kê MỌI số điện thoại / di động / hotline / fax nhìn thấy trong ảnh.

Quy tắc:
- Chép CHÍNH XÁC từng chữ số như nhìn thấy, giữ nguyên cách nhóm (VD "0834 70 75 79"). KHÔNG sửa, KHÔNG thêm hay bớt chữ số, KHÔNG đoán. Chữ số không đọc được thay bằng dấu "?".
- Mỗi số ghi các trường:
  "text": đúng chuỗi như thấy (kèm "?" nếu có chữ số không đọc được).
  "label": nhãn đứng ngay trước số (T, M, Tel, Hotline, ĐT, Zalo…), không có thì "".
  "owner": "person" nếu số nằm cạnh / dưới tên một cá nhân (số di động của người đó); "company" nếu thuộc khối thông tin chung của công ty / văn phòng; "unknown" nếu không rõ.
  "state": "clear" (in rõ) | "handwritten" (viết tay) | "struck_through" (bị gạch ngang / gạch xoá) | "cut_off" (bị cắt mép ảnh hoặc bị che, thiếu chữ số) | "unclear" (mờ, nhoè, không chắc).
- Số in bị gạch và có số viết tay thay thế: liệt kê CẢ HAI, mỗi số một dòng với "state" đúng.
- Ảnh có thể bị xoay ngang / ngược: vẫn đọc đủ.
- Không có số nào: {"phones": []}.
Trả về DUY NHẤT JSON: {"phones": [{"text":"","label":"","owner":"","state":""}]}
`.trim();

export type PhoneRead = { text: string; digits: string; label: string; owner: string; state: string };

const digitsOf = (s: string): string => s.replace(/[^\d?]/g, "");
// "+84…" / "84…" -> "0…"
const toLocal = (d: string): string => (/^84\d{9,10}$/.test(d) ? `0${d.slice(2)}` : d);
export const isValidVnPhone = (raw: string): boolean => {
  const d = toLocal(raw.replace(/\D/g, ""));
  return /^0[35789]\d{8}$/.test(d) || /^02\d{8,9}$/.test(d) || /^1[89]00\d{4,6}$/.test(d);
};

async function callPhonesPass(openai: OpenAI, model: string, dataUrl: string): Promise<PhoneRead[]> {
  const c = await openai.chat.completions.create({
    model,
    reasoning_effort: REASONING_EFFORT,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: PHONE_PROMPT },
      { role: "user", content: [{ type: "text", text: "Liệt kê mọi số điện thoại trong ảnh theo đúng quy tắc." }, { type: "image_url", image_url: { url: dataUrl, detail: "high" } }] },
    ],
  });
  let arr: unknown;
  try {
    arr = (JSON.parse(c.choices?.[0]?.message?.content || "{}") as { phones?: unknown }).phones;
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && typeof x === "object")
    .map((x) => {
      const o = x as Record<string, unknown>;
      const text = str(o.text);
      return { text, digits: digitsOf(text), label: str(o.label), owner: str(o.owner).toLowerCase(), state: str(o.state).toLowerCase() };
    })
    .filter((p) => p.digits.replace(/\?/g, "").length >= 6);
}

// Đối chiếu lượt bóc tách với lượt chép số. Chỉ số nào được lượt chép số xác nhận mới giữ lại.
export function reconcilePhones(partners: RawPartner[], reads: PhoneRead[]): RawPartner[] {
  const usable = reads.filter((p) => (p.state === "clear" || p.state === "handwritten") && !p.digits.includes("?") && isValidVnPhone(p.digits));
  const struck = new Set(reads.filter((p) => p.state === "struck_through").map((p) => toLocal(p.digits)));
  const doubtful = reads.filter((p) => !usable.includes(p) && p.state !== "struck_through");
  const addNote = (p: RawPartner, line: string) => {
    p.note = [str(p.note), line].filter(Boolean).join(" · ");
  };
  const flag = (p: RawPartner, key: string) => {
    const u = Array.isArray(p.uncertain) ? (p.uncertain as unknown[]).map(String) : [];
    if (!u.includes(key)) u.push(key);
    p.uncertain = u;
  };

  if (partners.length === 1) {
    // Danh thiếp / ảnh một đối tác: dựng lại SĐT từ lượt chép số (số cá nhân trước, số công ty sau).
    const p = { ...partners[0] };
    const ordered = [...usable.filter((u) => u.owner === "person"), ...usable.filter((u) => u.owner !== "person")];
    const before = [str(p.phone), str(p.phone2)].map((x) => toLocal(x.replace(/\D/g, ""))).filter(Boolean);
    p.phone = ordered[0] ? toLocal(ordered[0].digits) : "";
    p.phone2 = ordered[1] ? toLocal(ordered[1].digits) : "";
    const extra = ordered.slice(2).map((u) => u.text);
    if (extra.length) addNote(p, `SĐT khác: ${extra.join(", ")}`);
    const hand = ordered.slice(0, 2).some((u) => u.state === "handwritten");
    // Lượt bóc tách đầu ra số khác với số đã chép -> nghi ngờ.
    const disagree = before.some((b) => !ordered.some((u) => toLocal(u.digits) === b));
    if (hand || disagree) flag(p, "phone");
    if (doubtful.length) {
      addNote(p, `SĐT chưa đọc rõ: ${doubtful.map((d) => d.text).join(", ")}`);
      flag(p, "phone");
    }
    if (struck.size) addNote(p, `SĐT cũ bị gạch: ${reads.filter((r) => r.state === "struck_through").map((r) => r.text).join(", ")}`);
    return [p];
  }

  // Ảnh nhiều đối tác: chỉ giữ số được lượt chép số xác nhận; số lạ bị bỏ (không phải đoán gán lại).
  return partners.map((orig) => {
    const p = { ...orig };
    for (const key of ["phone", "phone2"] as const) {
      const v = str(p[key]);
      const d = toLocal(v.replace(/\D/g, ""));
      if (!d) continue;
      if (struck.has(d)) p[key] = "";
      else if (!usable.some((u) => toLocal(u.digits) === d)) {
        p[key] = "";
        addNote(p, `SĐT chưa kiểm chứng: ${v}`);
        flag(p, key);
      }
    }
    return p;
  });
}

async function callImage(openai: OpenAI, model: string, dataUrl: string, qr: string[], hint: string): Promise<RawPartner[]> {
  let url = dataUrl;
  let res = await callImageOnce(openai, model, url, qr, hint);
  // Ảnh nằm ngang / ngược: xoay về thẳng rồi đọc lại (chữ xoay làm sai chữ số nhiều nhất).
  if (res.rotation) {
    try {
      url = await rotateDataUrl(url, res.rotation);
      res = await callImageOnce(openai, model, url, qr, hint);
    } catch {
      /* không xoay được thì dùng kết quả lượt đầu */
    }
  }
  if (res.partners.length === 0) return [];
  try {
    const reads = await callPhonesPass(openai, model, url);
    return reconcilePhones(res.partners, reads);
  } catch {
    // Lượt chép số lỗi (hạn mức, mạng…): vẫn trả kết quả, nhưng mọi số bị đánh dấu chưa chắc.
    return res.partners.map((p) => ({ ...p, uncertain: [...(Array.isArray(p.uncertain) ? (p.uncertain as unknown[]).map(String) : []), "phone"] }));
  }
}
async function callPdf(openai: OpenAI, model: string, file: File, hint: string): Promise<RawPartner[]> {
  const dataUrl = await toDataUrl(file);
  const resp = await openai.responses.create({
    model,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: `${SYSTEM_PROMPT}\n\nTrích xuất đối tác từ tệp PDF này.${hint}` },
          { type: "input_file", filename: file.name, file_data: dataUrl },
        ],
      },
    ],
    text: { format: { type: "json_object" } },
    reasoning: { effort: REASONING_EFFORT },
  });
  return parsePartners(resp.output_text);
}

function parsePartners(content: string | null | undefined): RawPartner[] {
  if (!content) return [];
  let j: unknown;
  try {
    j = JSON.parse(content);
  } catch {
    throw new Error("AI trả về dữ liệu không đọc được. Thử lại.");
  }
  const arr = (j as { partners?: unknown })?.partners;
  return Array.isArray(arr) ? (arr.filter((x) => x && typeof x === "object") as RawPartner[]) : [];
}

// ─── Chuẩn hoá kết quả AI về PartnerInput ───
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : typeof v === "string" && v.trim() ? v.split(/[;,]/).map((s) => s.trim()).filter(Boolean) : [];

// Excel hay làm rụng số 0 đầu: 903889001 -> 0903889001, 2837816888 -> 02837816888.
function fixPhone(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  const keepPlus = s.startsWith("+");
  const d = s.replace(/\D/g, "");
  if (!d) return "";
  if (keepPlus) return `+${d}`;
  if (/^[35789]\d{8}$/.test(d)) return `0${d}`;
  if (/^2\d{9}$/.test(d)) return `0${d}`;
  return d;
}

// MST 10 số bị rụng số 0 đầu còn 9 số -> thêm lại.
function fixTax(raw: string): string {
  const c = cleanTaxCode(raw);
  const [main, suffix] = c.split("-");
  if (!main) return "";
  const m = main.length === 9 ? `0${main}` : main;
  return suffix ? `${m}-${suffix}` : m;
}

const KINDS: PartnerKind[] = ["nha_thau_phu", "nha_cung_cap", "to_doi"];

export function normalizeRaw(raw: RawPartner, kindOverride: PartnerKind | "auto"): { input: PartnerInput; uncertain: string[] } {
  const kindRaw = str(raw.kind) as PartnerKind;
  const kind: PartnerKind = kindOverride !== "auto" ? kindOverride : KINDS.includes(kindRaw) ? kindRaw : "nha_thau_phu";
  const regions = arr(raw.regions).filter((r): r is PartnerRegion => (REGION_ORDER as string[]).includes(r));
  const input: PartnerInput = {
    ...emptyInput(kind),
    name: str(raw.name).replace(/\s+/g, " "),
    short_name: str(raw.short_name),
    tax_code: fixTax(str(raw.tax_code)),
    address: str(raw.address),
    website: str(raw.website),
    contact_name: str(raw.contact_name),
    contact_title: str(raw.contact_title),
    legal_rep_name: str(raw.legal_rep_name),
    legal_rep_title: str(raw.legal_rep_title),
    phone: fixPhone(str(raw.phone)),
    phone2: fixPhone(str(raw.phone2)),
    email: str(raw.email).toLowerCase(),
    zalo: str(raw.zalo),
    viber: str(raw.viber),
    whatsapp: str(raw.whatsapp),
    telegram: str(raw.telegram),
    regions: Array.from(new Set(regions)),
    provinces: Array.from(new Set(arr(raw.provinces))),
    fields: Array.from(new Set(arr(raw.fields))).slice(0, 8),
    capability: str(raw.capability),
    note: str(raw.note),
    source: str(raw.source),
  };
  // AI (hoặc bảng) bỏ trống tỉnh / miền: suy từ địa chỉ và từ tên tỉnh bằng bảng tỉnh — không cần hỏi lại AI.
  if (input.provinces.length === 0 && input.address) {
    const last = findProvinces(input.address).pop();
    if (last) input.provinces = [last.name];
  }
  if (input.regions.length === 0 && input.provinces.length > 0) {
    const rs = new Set<PartnerRegion>();
    for (const p of input.provinces) for (const f of findProvinces(p)) rs.add(f.region);
    input.regions = REGION_ORDER.filter((r) => rs.has(r));
  }
  // Chỉ có người đại diện, không có người liên hệ: dùng làm người liên hệ để form đủ trường bắt buộc.
  if (!input.contact_name && input.legal_rep_name) {
    input.contact_name = input.legal_rep_name;
    input.contact_title = input.contact_title || input.legal_rep_title;
  }
  const uncertain = arr(raw.uncertain);
  // Số điện thoại không đúng dạng Việt Nam (thiếu / thừa chữ số, đầu số lạ): để nguyên giá trị nhưng báo cần kiểm tra.
  if (input.phone && !isValidVnPhone(input.phone) && !uncertain.includes("phone")) uncertain.push("phone");
  if (input.phone2 && !isValidVnPhone(input.phone2) && !uncertain.includes("phone2")) uncertain.push("phone2");
  return { input, uncertain };
}

// ─── Đọc Excel / CSV BẰNG QUY TẮC CỘT (không tốn API) ───
// Bảng có tiêu đề cột rõ (Tên công ty, MST, SĐT, Người liên hệ…) thì ánh xạ trực tiếp theo
// tên cột: nhanh, miễn phí và chính xác hơn AI. Chỉ khi KHÔNG nhận ra tiêu đề mới nhờ AI.
// Hiểu được: tiêu đề hai tầng, siêu liên kết trong ô (link hồ sơ năng lực/website), ô "Số điện
// thoại" ghi kèm tên người ("Mr Quân - 0944168880"), nhiều sheet trong một tệp, sheet là biểu mẫu
// một đối tác (bỏ qua), tên sheet gợi ý loại đối tác.
const SYN: Record<string, string[]> = {
  name: ["ten cong ty", "ten doanh nghiep", "cong ty", "doanh nghiep", "don vi", "ten don vi", "ten nha thau", "nha thau", "ten nha cung cap", "nha cung cap", "ten doi tac", "doi tac", "ten", "ten to doi", "to doi", "ten giao dich", "company", "company name", "name", "ten ncc", "ncc", "ten nt"],
  code: ["ma", "ma doi tac", "ma nt", "ma ncc", "ma to doi"],
  short_name: ["ten viet tat", "ten goi tat", "viet tat", "ten thuong hieu", "thuong hieu"],
  tax_code: ["mst", "ma so thue", "ma so thue mst", "tax code", "tax id", "tin", "ma so dn", "ma so doanh nghiep"],
  address: ["dia chi", "dia chi tru so", "tru so", "tru so chinh", "dia chi cong ty", "address", "van phong", "dia chi lien he"],
  website: ["website", "web", "trang web", "fanpage", "website fanpage"],
  profile_url: ["profile", "ho so nang luc", "hsnl", "ho so", "company profile", "link profile"],
  catalogue: ["catalogue", "catalog"],
  contact_name: ["nguoi lien he", "ten nguoi lien he", "lien he", "nguoi dau moi", "dau moi", "nguoi phu trach", "contact", "contact person", "ten lien he", "can bo lien he", "nguoi dai dien kinh doanh"],
  contact_title: ["chuc vu nguoi lien he", "chuc danh nguoi lien he"],
  title: ["chuc vu", "chuc danh", "vi tri", "position", "title"],
  legal_rep_name: ["nguoi dai dien", "nguoi dai dien phap luat", "dai dien phap luat", "giam doc", "tong giam doc", "chu doanh nghiep", "ho va ten", "ho ten"],
  legal_rep_title: ["chuc vu nguoi dai dien", "chuc danh nguoi dai dien", "chuc vu dai dien"],
  phone: ["sdt", "so dien thoai", "dien thoai", "phone", "tel", "hotline", "di dong", "mobile", "sdt 1", "so dt", "dt", "sdt lien he", "so dien thoai lien he", "so dien thoai 1", "dien thoai lien he", "lien lac", "thong tin lien lac"],
  phone2: ["sdt 2", "so dien thoai 2", "dien thoai 2", "phone 2", "sdt khac", "so khac", "sdt phu", "dt 2"],
  email: ["email", "e mail", "mail", "thu dien tu", "email nguoi lien he", "email lien he"],
  zalo: ["zalo", "so zalo"],
  viber: ["viber"],
  whatsapp: ["whatsapp", "whats app"],
  telegram: ["telegram"],
  regions: ["khu vuc", "mien", "vung", "vung mien", "khu vuc hoat dong", "pham vi hoat dong", "pham vi", "mien hoat dong"],
  provinces: ["tinh", "tinh thanh", "tinh thanh pho", "thanh pho", "noi hoat dong", "dia ban", "dia ban hoat dong", "tinh thanh hoat dong"],
  fields: ["linh vuc", "nganh nghe", "nhom nganh", "nhom linh vuc", "nganh", "hang muc", "chuyen mon", "nhom hang", "nganh nghe kinh doanh"],
  fields_long: ["linh vuc hoat dong", "linh vuc hoat dong chinh", "san pham", "mat hang"],
  capability: ["nang luc", "mo ta", "mo ta nang luc", "gioi thieu", "dich vu", "san pham dich vu", "nang luc kinh nghiem"],
  coop: ["loai hinh hop tac", "hinh thuc hop tac"],
  source: ["nguon gioi thieu", "nguon", "nguon thong tin"],
  note: ["ghi chu", "note", "chu thich", "luu y"],
  kind: ["loai", "phan loai", "loai hinh", "nhom", "nhom doi tac", "loai doi tac"],
};
const IGNORABLE_HEADERS = new Set(["stt", "tt", "so thu tu", "no"]);

function matchField(header: string): string | null {
  const h = vnNorm(header).trim();
  if (!h) return null;
  for (const f of Object.keys(SYN)) if (SYN[f].includes(h)) return f;
  // Tiêu đề dài hơn từ đồng nghĩa ("Tên công ty (đầy đủ)"): chọn từ đồng nghĩa DÀI nhất có trong tiêu đề.
  let best: { f: string; len: number } | null = null;
  for (const f of Object.keys(SYN))
    for (const s of SYN[f]) if (s.length >= 6 && h.includes(s) && (!best || s.length > best.len)) best = { f, len: s.length };
  return best ? best.f : null;
}

// Giá trị "trống giả" hay gặp trong bảng tay.
const EMPTYISH = /^(n\/a|na|n\.a\.?|-+|—|–|x|\?|chưa có|chua co|không có|khong co|đang cập nhật|dang cap nhat)$/i;
const cleanCell = (v: unknown): string => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return EMPTYISH.test(s) ? "" : s;
};

// Danh sách theo gạch đầu dòng: " + A + B", "- A\n- B", "A; B", "A, B". KHÔNG tách theo dấu gạch ngang
// giữa dòng: "Điện - TBA", "Hạ tầng - Giao thông" là MỘT tên nhóm.
function splitList(s: string): string[] {
  return s
    .split(/[\n;|+•]+|,(?!\d)/)
    .map((x) => x.replace(/^[\s\-•+:]+/, "").trim())
    .filter(Boolean);
}
// Đoạn mô tả nhiều gạch đầu dòng -> một dòng "A; B; C".
const bulletsToText = (s: string): string => splitList(s).join("; ");

const PHONE_RE = /\+?\d[\d .\-()]{7,}\d/;
// Một ô có thể chứa nhiều số: "0903 123 456 - 0908 111 222", "0903.123.456 / 0908...", xuống dòng.
// Tách theo dấu phân cách (gạch có khoảng trắng hai bên, chấm phẩy, phẩy, gạch chéo, xuống dòng) rồi
// mới gom chữ số của từng phần; phần dính liền hai số 10 chữ số thì cắt đôi.
function extractPhones(s: string): string[] {
  const out: string[] = [];
  for (const piece of s.split(/\s+[-–—]\s+|[;,/\n|]+/)) {
    const d = piece.replace(/[^\d+]/g, "");
    const digits = d.replace(/\D/g, "");
    if (digits.length < 9) continue;
    if (digits.length >= 18) out.push(...(digits.match(/0\d{9,10}/g) || [d]));
    else out.push(d);
  }
  return Array.from(new Set(out));
}

// Ô "Số điện thoại" / "Liên lạc" ghi cả tên người: "Mr Quân - 0944168880",
// "Mr Trí - 0975 744 569 (Nhân viên KD miền Nam)", "Hotline 0919939897", "0934.206.965".
const GENERIC_WORDS = /\b(hotline|sdt|sđt|đt|dt|tel|phone|zalo|di động|di dong|liên hệ|lien he|số điện thoại|so dien thoai|điện thoại|dien thoai)\b\.?:?/gi;
export function parseContactCell(text: string): { name: string; title: string; phones: string[] } {
  const raw = cleanCell(text);
  if (!raw) return { name: "", title: "", phones: [] };
  const phones = extractPhones(raw);
  const m = raw.match(PHONE_RE);
  let before = m && m.index != null ? raw.slice(0, m.index) : phones.length ? "" : raw;
  let title = "";
  const after = m && m.index != null ? raw.slice(m.index + m[0].length) : "";
  const paren = (after.match(/\(([^)]+)\)/) || before.match(/\(([^)]+)\)/) || [])[1];
  if (paren) title = paren.trim();
  before = before.replace(/\([^)]*\)/g, " ").replace(GENERIC_WORDS, " ");
  // Chỉ lấy người ĐẦU TIÊN nếu ô ghi nhiều người ("Mr A - 090…; Mr B - 091…").
  const name = before.split(/[;,/\n|]/)[0].replace(/[-–—:.\s]+$/g, "").replace(/^[-–—:.\s]+/g, "").trim();
  return { name: /\d/.test(name) ? "" : name, title, phones };
}

const URL_LIKE = /^(https?:\/\/\S+|www\.\S+|[\w-]+(\.[\w-]+)+\/?\S*)$/i;
const asUrl = (s: string): string => (/^https?:\/\//i.test(s) ? s : `https://${s}`);

function kindFromText(s: string): PartnerKind | "" {
  const t = vnNorm(s);
  if (/ to doi /.test(t)) return "to_doi";
  if (/ cung cap | ncc | vat tu | thiet bi /.test(t)) return "nha_cung_cap";
  if (/ thau phu | thi cong | nha thau | dich vu | lien danh /.test(t)) return "nha_thau_phu";
  return "";
}

// Tên sheet gợi ý loại đối tác và lĩnh vực.
const GENERIC_SHEET = /^ (nha thau phu|nha cung cap|to doi|lien danh|sheet ?\d*|danh sach.*|data|du lieu) $/;
function sheetKind(sheetName: string): PartnerKind | "" {
  const t = vnNorm(sheetName);
  if (/ to doi /.test(t)) return "to_doi";
  if (/ nha cung cap | ncc | to cung ung /.test(t)) return "nha_cung_cap";
  if (/ nha thau phu | lien danh | thuy loi | dien | tba | ha tang | coc /.test(t)) return "nha_thau_phu";
  return "";
}
const sheetField = (sheetName: string): string => {
  if (GENERIC_SHEET.test(vnNorm(sheetName))) return "";
  const s = sheetName.trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export type LocalSheetResult = {
  ok: boolean; // false = không nhận ra tiêu đề cột -> nên nhờ AI
  items: { input: PartnerInput; uncertain: string[] }[];
  info: string;
};

export async function parseSheetLocal(file: File, kindHint: PartnerKind | "auto"): Promise<LocalSheetResult> {
  const XLSX = await import("xlsx");
  const isCsv = /\.csv$/i.test(file.name);
  const wb = isCsv ? XLSX.read(await file.text(), { type: "string" }) : XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  const items: { input: PartnerInput; uncertain: string[] }[] = [];
  const unused = new Set<string>();
  const usedSheets: string[] = [];
  const skippedSheets: string[] = [];
  let skippedRows = 0;

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws["!ref"]) continue;
    const ref = XLSX.utils.decode_range(ws["!ref"]);
    // blankrows: true để chỉ số dòng khớp với dòng thật trong sheet (cần khi lấy siêu liên kết).
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "", blankrows: true });
    const linkAt = (ri: number, ci: number): string => {
      const c = ws[XLSX.utils.encode_cell({ r: ref.s.r + ri, c: ref.s.c + ci })] as { l?: { Target?: string }; f?: string } | undefined;
      if (!c) return "";
      // Siêu liên kết thường, hoặc công thức =HYPERLINK("đường dẫn","chữ hiển thị") (file của TNEC dùng kiểu này).
      if (c.l?.Target) return String(c.l.Target).trim();
      const m = c.f ? c.f.match(/^\s*HYPERLINK\(\s*"([^"]*)"/i) : null;
      return m ? m[1].trim() : "";
    };

    // Dòng tiêu đề = dòng (trong 15 dòng đầu) nhận ra được nhiều cột nhất, và phải có cột Tên.
    let headerIdx = -1;
    let bestCount = 0;
    for (let i = 0; i < Math.min(15, rows.length); i++) {
      const fields = (rows[i] || []).map((c) => matchField(String(c ?? "")));
      const distinct = new Set(fields.filter((x): x is string => !!x));
      if (distinct.has("name") && distinct.size >= 2 && distinct.size > bestCount) {
        bestCount = distinct.size;
        headerIdx = i;
      }
    }
    if (headerIdx < 0) {
      if (rows.some((r) => (r || []).some((c) => String(c ?? "").trim()))) skippedSheets.push(sheetName);
      continue;
    }

    // Tiêu đề hai tầng: dòng ngay dưới tiêu đề không có tên đối tác nhưng gọi tên các cột con
    // ("Hồ sơ năng lực", "Website", "Catalogue") cho những cột tiêu đề chính còn trống.
    const head = (rows[headerIdx] || []).map((c) => String(c ?? "").trim());
    const sub = (rows[headerIdx + 1] || []).map((c) => String(c ?? "").trim());
    const nameCol = head.findIndex((h) => matchField(h) === "name");
    const subIsHeader = nameCol >= 0 && !sub[nameCol] && sub.some((s, ci) => s && !matchField(head[ci] || "") && matchField(s));
    const colField: (string | null)[] = head.map((h, ci) => matchField(h) || (subIsHeader ? matchField(sub[ci] || "") : null));
    colField.forEach((f, ci) => {
      const label = head[ci] || (subIsHeader ? sub[ci] : "");
      if (!f && label && !IGNORABLE_HEADERS.has(vnNorm(label).trim())) unused.add(label);
    });

    const colsOf = (f: string) => colField.map((x, ci) => (x === f ? ci : -1)).filter((ci) => ci >= 0);
    const has = (f: string) => colsOf(f).length > 0;
    // "Chức vụ" đứng cạnh cột người đại diện (không có cột người liên hệ riêng) = chức vụ người đại diện.
    const titleIsLegal = has("legal_rep_name") && !has("contact_name");
    // Có cả "Nhóm lĩnh vực" lẫn "Lĩnh vực hoạt động": nhóm là lĩnh vực, "hoạt động" (dài, mô tả) là năng lực.
    const longIsCapability = has("fields");
    const phoneCols = colsOf("phone");
    if (phoneCols.length > 1 && !has("phone2")) colField[phoneCols[1]] = "phone2";

    const sk = sheetKind(sheetName);
    const sf = sheetField(sheetName);
    let count = 0;

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const cell = (f: string): string => {
        const ci = colsOf(f)[0];
        return ci == null ? "" : cleanCell(r[ci]);
      };
      const name = cell("name");
      const filled = r.filter((c) => String(c ?? "").trim()).length;
      // Dòng tổng chỉ khi ô tên ĐÚNG là "Tổng" / "Tổng cộng" / "Cộng" — không dùng "bắt đầu bằng",
      // vì "Công ty …" cũng bắt đầu bằng "cong".
      if (!name || filled < 2 || /^(tong cong|tong so|tong|cong|total|grand total)\s*:?$/.test(vnNorm(name).trim())) {
        if (filled > 0 && !(subIsHeader && i === headerIdx + 1)) skippedRows++;
        continue;
      }

      // Liên hệ: ô SĐT có thể kèm tên người.
      const contactCells = [...colsOf("phone"), ...colsOf("phone2")].map((ci) => parseContactCell(String(r[ci] ?? "")));
      const allPhones = Array.from(new Set(contactCells.flatMap((c) => c.phones)));
      const withName = contactCells.find((c) => c.name);
      const extraPhones = allPhones.slice(2);

      // Link: siêu liên kết trong ô ưu tiên, không có thì chữ trong ô nếu trông như địa chỉ web.
      const urlFrom = (f: string): { url: string; text: string } => {
        for (const ci of colsOf(f)) {
          const link = linkAt(i, ci);
          const text = cleanCell(r[ci]);
          if (/^https?:\/\//i.test(link)) return { url: link, text };
          if (text && URL_LIKE.test(text) && !/\s/.test(text)) return { url: asUrl(text), text };
          if (text) return { url: "", text };
        }
        return { url: "", text: "" };
      };
      const web = urlFrom("website");
      const prof = urlFrom("profile_url");
      const cat = urlFrom("catalogue");

      const regionCell = cell("regions");
      const provCell = cell("provinces");
      const provFound = [...findProvinces(provCell), ...findProvinces(regionCell)];
      const provinces = provFound.length ? Array.from(new Set(provFound.map((p) => p.name))) : splitList(provCell);
      // Miền = từ khoá miền trong ô (khi ô có tên tỉnh thì chỉ nhận "miền X") + miền của các tỉnh tìm thấy.
      const regions = Array.from(new Set<PartnerRegion>([...regionsFromWords(regionCell, provFound.length > 0), ...provFound.map((p) => p.region)]));

      // Lĩnh vực: cột "nhóm lĩnh vực"; cột "lĩnh vực hoạt động" dài -> năng lực (nếu đã có cột nhóm).
      const fieldsRaw = [cell("fields"), longIsCapability ? "" : cell("fields_long")].filter(Boolean).join("; ");
      let fields = splitList(fieldsRaw);
      if (fields.length === 0 && sf) fields = [sf];
      const capability = [cell("capability"), longIsCapability ? cell("fields_long") : ""].filter(Boolean).map(bulletsToText).join(" — ");

      // Mã, hợp tác, nguồn, ghi chú, catalogue, chữ hồ sơ (không phải link), SĐT dư -> gộp vào ghi chú.
      const noteParts = [
        cell("code") && `Mã: ${cell("code")}`,
        cell("coop") && `Hợp tác: ${cell("coop")}`,
        cell("note"),
        cat.url && `Catalogue: ${cat.url}`,
        prof.text && !prof.url && !/^📁|^🌐|^🧮|xem .* tại đây/i.test(prof.text) && `Hồ sơ năng lực: ${prof.text}`,
        extraPhones.length > 0 && `SĐT khác: ${extraPhones.join(", ")}`,
      ].filter(Boolean) as string[];

      const taxMatch = cell("tax_code").match(/\d{10}(?:-\d{3})?|\d{13}/);
      const titleVal = cell("title");
      const raw: RawPartner = {
        kind: kindFromText(cell("kind")) || sk || "",
        name,
        short_name: cell("short_name"),
        tax_code: taxMatch ? taxMatch[0] : cell("tax_code"),
        address: cell("address"),
        website: web.url,
        profile_url: prof.url,
        contact_name: withName?.name || cell("contact_name"),
        contact_title: withName?.title || cell("contact_title") || (titleIsLegal ? "" : titleVal),
        legal_rep_name: cell("legal_rep_name"),
        legal_rep_title: cell("legal_rep_title") || (titleIsLegal ? titleVal : ""),
        phone: allPhones[0] || "",
        phone2: allPhones[1] || "",
        email: (cell("email").match(/[^\s,;<>()]+@[^\s,;<>()]+\.[^\s,;<>()]+/) || [""])[0],
        zalo: cell("zalo"),
        viber: cell("viber"),
        whatsapp: cell("whatsapp"),
        telegram: cell("telegram"),
        regions,
        provinces,
        fields,
        capability,
        note: noteParts.join(" · "),
        source: cell("source"),
        uncertain: [],
      };
      const out = normalizeRaw(raw, kindHint);
      // normalizeRaw không biết profile_url (không có trong lược đồ AI): gán trực tiếp.
      out.input.profile_url = prof.url;
      items.push(out);
      count++;
    }
    if (count > 0) usedSheets.push(`${sheetName} (${count})`);
  }

  if (items.length === 0) return { ok: false, items: [], info: "" };
  const parts = [`đọc bằng quy tắc cột, không dùng AI — ${items.length} dòng từ ${usedSheets.length} sheet: ${usedSheets.join(", ")}`];
  if (skippedSheets.length) parts.push(`bỏ qua sheet không phải bảng danh sách: ${skippedSheets.join(", ")}`);
  if (skippedRows) parts.push(`bỏ ${skippedRows} dòng trống/tổng/thiếu tên`);
  if (unused.size) parts.push(`cột chưa dùng: ${Array.from(unused).slice(0, 8).join(", ")}${unused.size > 8 ? "…" : ""}`);
  return { ok: true, items, info: parts.join("; ") };
}
// ─── Tìm MST theo tên công ty + khu vực (AI tìm trên web) ───
// Chỉ tìm khi biết khu vực (địa chỉ / tỉnh thành / miền) để không lấy nhầm công ty trùng tên nơi khác.
// Trả về MST ứng viên hoặc "" — nơi gọi PHẢI tra lại MST và so tên (sameCompany) trước khi điền.
export function taxSearchArea(input: PartnerInput): string {
  return [input.address, input.provinces.join(", "), input.regions.map((r) => REGION_LABELS[r]).join(", ")]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" | ");
}

export async function findTaxCodeByName(apiKey: string, model: string, input: PartnerInput): Promise<string> {
  const area = taxSearchArea(input);
  if (!input.name.trim() || !area) return "";
  const resp = await client(apiKey).responses.create({
    model,
    tools: [{ type: "web_search" }],
    input:
      `Tìm mã số thuế (MST) của doanh nghiệp Việt Nam sau.\n` +
      `Tên: ${input.name.trim()}\nKhu vực / địa chỉ: ${area}\n\n` +
      `Chỉ nhận khi tên doanh nghiệp khớp và trụ sở nằm đúng khu vực trên. Nếu không chắc chắn, có nhiều doanh nghiệp ` +
      `cùng tên mà không phân biệt được, hoặc không tìm thấy thì trả lời KHONG. ` +
      `Chỉ trả lời đúng một dòng: MST (10 số, hoặc 10 số-3 số cho chi nhánh) hoặc KHONG.`,
    reasoning: { effort: REASONING_EFFORT },
  });
  const m = (resp.output_text || "").match(/\b\d{10}(?:-\d{3})?\b/);
  return m ? m[0] : "";
}

// Cùng một doanh nghiệp: bỏ dấu, bỏ loại hình (công ty, cổ phần, TNHH…) rồi so phần tên riêng.
const LEGAL_FORM =
  /\b(cong ty|cty|co phan|cp|tnhh|trach nhiem huu han|mot thanh vien|mtv|hai thanh vien tro len|tap doan|doanh nghiep tu nhan|dntn|hop tac xa|htx)\b/g;
const coreName = (s: string) =>
  normalizeName(s).replace(/[^a-z0-9 ]/g, " ").replace(LEGAL_FORM, " ").replace(/\s+/g, " ").trim();
export function sameCompany(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = coreName(a || "");
  return !!x && x === coreName(b || "");
}

// ─── Chạy một nguồn -> danh sách đối tác ───
export type ExtractOutcome = {
  items: { input: PartnerInput; uncertain: string[] }[];
  via: "local" | "ai";
  info?: string;
};

export async function extractFromSource(opts: {
  apiKey: string;
  model: string;
  source: AiSource;
  kindHint: PartnerKind | "auto";
  forceAiForSheet?: boolean;
  onProgress?: (msg: string) => void;
}): Promise<ExtractOutcome> {
  const { apiKey, model, source, kindHint, forceAiForSheet, onProgress } = opts;
  const hint = kindHint === "auto" ? "" : ` Các đối tác trong nguồn này thuộc loại "${kindHint}".`;
  const ai = (): OpenAI => {
    if (!apiKey.trim()) throw new Error("Cần khoá OpenAI để AI đọc nguồn này. Bấm \"Nhập khoá OpenAI\" ở góc trên.");
    return client(apiKey.trim());
  };
  let raws: RawPartner[] = [];

  if (source.kind === "text") {
    if (source.text.trim().length < 5) throw new Error("Văn bản quá ngắn.");
    raws = await callText(ai(), model, `Trích xuất đối tác từ nội dung sau.${hint}\n\n--- NỘI DUNG ---\n${source.text}`);
  } else {
    const file = source.file;
    if (file.size > MAX_SOURCE_BYTES) throw new Error(`"${file.name}" lớn hơn ${MAX_SOURCE_BYTES / 1024 / 1024}MB.`);
    const k = sourceKindOf(file);
    if (k === "heic") throw new Error(`"${file.name}" là ảnh HEIC của iPhone, trình duyệt chưa đọc được. Chụp lại ở chế độ "Tương thích nhất" hoặc chụp màn hình rồi tải lên.`);
    if (k === "image") {
      const openai = ai();
      onProgress?.("Đang xử lý ảnh và quét mã QR…");
      const { dataUrl, qr } = await prepareImage(file);
      onProgress?.(qr.length ? `Tìm thấy ${qr.length} mã QR, đang đọc nội dung…` : "Đang đọc ảnh…");
      raws = await callImage(openai, model, dataUrl, qr, hint);
    } else if (k === "pdf") {
      const openai = ai();
      onProgress?.("Đang đọc PDF…");
      raws = await callPdf(openai, model, file, hint);
    } else if (k === "sheet") {
      if (!forceAiForSheet) {
        onProgress?.("Đang đọc bảng theo tiêu đề cột…");
        const local = await parseSheetLocal(file, kindHint);
        if (local.ok) return { items: local.items.filter((x) => x.input.name), via: "local", info: local.info };
        onProgress?.("Không nhận ra tiêu đề cột, chuyển sang AI…");
      }
      const openai = ai();
      const chunks = await sheetToChunks(file);
      if (chunks.length === 0) throw new Error("Bảng không có dữ liệu.");
      for (let i = 0; i < chunks.length; i++) {
        onProgress?.(`AI đang đọc bảng: phần ${i + 1}/${chunks.length}…`);
        raws.push(...(await callText(openai, model, `Trích xuất đối tác từ bảng sau (CSV).${hint}\n\n${chunks[i].text}`)));
      }
    } else if (k === "word") {
      const openai = ai();
      onProgress?.("Đang đọc tệp Word…");
      const text = await wordToText(file);
      if (text.length < 10) throw new Error("Văn bản trong tệp Word quá ngắn hoặc trống.");
      raws = await callText(openai, model, `Trích xuất đối tác từ nội dung sau.${hint}\n\n--- NỘI DUNG ---\n${text}`);
    } else if (k === "text") {
      const openai = ai();
      const text = (await file.text()).trim();
      if (text.length < 5) throw new Error("Tệp văn bản trống.");
      raws = await callText(openai, model, `Trích xuất đối tác từ nội dung sau.${hint}\n\n--- NỘI DUNG ---\n${text}`);
    } else {
      throw new Error(`"${file.name}": định dạng chưa hỗ trợ. Dùng ảnh, PDF, Excel/CSV, Word hoặc TXT.`);
    }
  }
  return { items: raws.map((r) => normalizeRaw(r, kindHint)).filter((x) => x.input.name), via: "ai" };
}
// ─── Cảnh báo trùng (KHÔNG chặn: danh bạ là kho thu thập gốc, user chốt 13/10/2026) ───
// Có MST thì so MST; chưa có MST thì so tên hoặc số điện thoại (9 chữ số cuối).
const phoneKey = (p: string): string | null => {
  const d = p.replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-9) : null;
};
const nameKey = (n: string) => normalizeName(n).replace(/\s+/g, " ");
const taxKey = (t: string) => cleanTaxCode(t);

// origin: "db" = đã có trong danh bạ (đã lưu); "batch" = mục khác trong cùng danh sách AI đang xem
// (chưa lưu). Báo rõ để người dùng biết trùng với bản đã lưu hay chỉ trùng ngay trong file.
type DupSubject = { name: string; tax_code: string | null; phone: string | null; phone2: string | null; origin?: "db" | "batch" };

const dupWhere = (p: DupSubject) => (p.origin === "batch" ? "mục khác trong danh sách này" : "đối tác đã có trong danh bạ");

export function findDup(input: PartnerInput, pool: DupSubject[], opts: { phoneOnly?: boolean } = {}): string | null {
  const tax = taxKey(input.tax_code);
  if (opts.phoneOnly) {
    const keys = [phoneKey(input.phone), phoneKey(input.phone2)].filter((k): k is string => !!k);
    if (!keys.length) return null;
    const hit = pool.find((p) => {
      const pk = [phoneKey(p.phone || ""), phoneKey(p.phone2 || "")];
      return keys.some((k) => pk.includes(k));
    });
    return hit ? `trùng số điện thoại với ${dupWhere(hit)} "${hit.name}"` : null;
  }
  if (tax) {
    const hit = pool.find((p) => p.tax_code && taxKey(p.tax_code) === tax);
    return hit ? `trùng mã số thuế với ${dupWhere(hit)} "${hit.name}"` : null;
  }
  const nk = nameKey(input.name);
  const byName = pool.find((p) => nameKey(p.name) === nk);
  if (byName) return `trùng tên với ${dupWhere(byName)} "${byName.name}"`;
  const keys = [phoneKey(input.phone), phoneKey(input.phone2)].filter((k): k is string => !!k);
  if (keys.length) {
    const hit = pool.find((p) => {
      const pk = [phoneKey(p.phone || ""), phoneKey(p.phone2 || "")];
      return keys.some((k) => pk.includes(k));
    });
    if (hit) return `trùng số điện thoại với ${dupWhere(hit)} "${hit.name}"`;
  }
  return null;
}

export function dupPoolFromRows(rows: PartnerRow[]): DupSubject[] {
  return rows.map((r) => ({ name: r.name, tax_code: r.tax_code, phone: r.phone, phone2: r.phone2, origin: "db" as const }));
}

// ─── Gộp & ghi đè ───
// Khoá nhận diện để GỘP / GHI ĐÈ (chặt hơn cảnh báo trùng): MST nếu có, không thì đúng tên.
// Số điện thoại KHÔNG dùng để gộp vì hai doanh nghiệp có thể dùng chung một số.
export const identityKey = (x: { tax_code: string | null | undefined; name: string }): string => {
  const tax = cleanTaxCode(x.tax_code || "");
  return tax ? `mst:${tax}` : `ten:${nameKey(x.name)}`;
};

export function findMatch(input: PartnerInput, rows: PartnerRow[]): PartnerRow | null {
  const tax = cleanTaxCode(input.tax_code);
  if (tax) {
    const byTax = rows.find((r) => r.tax_code && cleanTaxCode(r.tax_code) === tax);
    if (byTax) return byTax;
  }
  const nk = nameKey(input.name);
  return rows.find((r) => nameKey(r.name) === nk) || null;
}

// Hợp hai danh sách, không phân biệt hoa/thường ("Thủy lợi - cọc" = "Thủy lợi - Cọc"); giữ bản viết đầu tiên.
const unionList = (a: string[], b: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...a, ...b]) {
    const k = vnNorm(x).trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
};
const noteParts = (s: string) => s.split(" · ").map((x) => x.trim()).filter(Boolean);
export const noteUnion = (a: string, b: string): string => unionList(noteParts(a), noteParts(b)).join(" · ");

// Gộp hai bản ghi CỦA CÙNG MỘT TỆP (cùng công ty ở nhiều sheet): bản đầu giữ nguyên,
// bản sau chỉ điền vào ô còn trống; danh sách (miền, tỉnh, lĩnh vực) hợp lại; ghi chú nối.
export function mergeInputs(base: PartnerInput, extra: PartnerInput): PartnerInput {
  const out: PartnerInput = { ...base };
  for (const k of Object.keys(extra) as (keyof PartnerInput)[]) {
    const b = base[k];
    const e = extra[k];
    if (typeof b === "string" && typeof e === "string") {
      if (!b.trim() && e.trim()) (out[k] as string) = e;
    }
  }
  out.regions = unionList(base.regions, extra.regions) as PartnerInput["regions"];
  out.provinces = unionList(base.provinces, extra.provinces);
  out.fields = unionList(base.fields, extra.fields);
  out.note = noteUnion(base.note, extra.note);
  return out;
}

// GHI ĐÈ lên đối tác đã có: ô nào tệp CÓ dữ liệu thì chép đè, ô tệp để trống thì GIỮ NGUYÊN bản cũ
// (không xoá thông tin đã có). Loại đối tác, trạng thái, lý do, điểm đánh giá không đổi.
// Ghi chú thì nối thêm chứ không thay, để không mất ghi chú tay.
export function overlayOnRow(row: PartnerRow, input: PartnerInput): PartnerInput {
  const base = inputFromRow(row);
  const out: PartnerInput = { ...base };
  const protect = new Set<string>(["kind", "status", "status_reason", "rating", "rating_note"]);
  for (const k of Object.keys(input) as (keyof PartnerInput)[]) {
    if (protect.has(k) || k === "note") continue;
    const v = input[k];
    if (typeof v === "string") {
      if (v.trim()) (out[k] as string) = v;
    } else if (Array.isArray(v) && v.length > 0) {
      (out[k] as unknown) = v;
    }
  }
  out.note = noteUnion(base.note, input.note);
  return out;
}