import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 建站 Copilot",
  description: "用 DeepSeek 通过自然语言持续生成和修改网站。",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
