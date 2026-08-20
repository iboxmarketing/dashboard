import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://bitrix-deal-dashboard.marketing237898.chatgpt.site"),
  title: "Bitrix24 Deal Processing Dashboard",
  description:
    "Yangi Bitrix24 Deal’lar qanchalik tez obrabotka qilinishini business minutes bo‘yicha o‘lchaydigan ichki analytics dashboard.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "Bitrix24 Deal Processing Dashboard",
    description: "Yangi Deal’lar qanchalik tez obrabotka qilinayotganini kuzating.",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Bitrix24 Deal Processing Dashboard" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Bitrix24 Deal Processing Dashboard",
    description: "Yangi Deal’lar qanchalik tez obrabotka qilinayotganini kuzating.",
    images: ["/og.png"],
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
