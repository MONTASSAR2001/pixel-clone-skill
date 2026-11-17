import type { Metadata } from "next";
import "./globals.css";

// PIXEL-CLONE: set title/description/lang from extraction.json -> page.title / page.lang
export const metadata: Metadata = {
  title: "Clone",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
