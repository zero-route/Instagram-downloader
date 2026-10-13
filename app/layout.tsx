import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "InstaFetch - Instagram Downloader",
  description:
    "Unduh Reel dan post Instagram dengan cepat dan mudah.",
    icons: {
      icon: "/logo.png", 
      shortcut: "/logo.png", 
      apple: "/logo.png", 
    }, 
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0b0c",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
