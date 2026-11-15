import type { MetadataRoute } from "next";

// Web App Manifest — biến web thành PWA "cài được" lên màn hình chính iPhone/Android.
// Tên/mô tả lấy theo biến môi trường tenant (giống layout), thiếu thì fallback Lodeza EOP.
export default function manifest(): MetadataRoute.Manifest {
  const title = process.env.NEXT_PUBLIC_SYSTEM_TITLE || "Lodeza EOP";
  return {
    name: title,
    short_name: process.env.NEXT_PUBLIC_SYSTEM_SHORT_NAME || "Lodeza EOP",
    description:
      process.env.NEXT_PUBLIC_SYSTEM_DESCRIPTION ||
      "Phần mềm Quản lý Hành chính Nhân sự - Lodeza EOP",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#F7F9FC",
    theme_color: "#005BAC",
    lang: "vi",
    dir: "ltr",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
