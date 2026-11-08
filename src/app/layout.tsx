import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Commit2Value | 代码价值翻译器",
  description:
    "开源工具：把 GitHub / GitLab 提交翻译成客户看得懂的工作成果汇报，附带工时估算、报价与提交活跃度。",
  openGraph: {
    title: "Commit2Value | 代码价值翻译器",
    description: "把 Git 提交变成客户看得懂的成果汇报。开源、可自托管。",
    type: "website",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
