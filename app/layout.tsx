import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bitrix24 Deal Processing Dashboard",
  description:
    "Yangi Bitrix24 Deal’lar qanchalik tez obrabotka qilinishini business minutes bo‘yicha o‘lchaydigan ichki analytics dashboard.",
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
    <html lang="uz">
      <body>{children}</body>
    </html>
  );
}
