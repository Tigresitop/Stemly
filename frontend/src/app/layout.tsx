import type { Metadata } from "next";

import { Toaster } from "@/components/ui/sonner";
import { mono, sans } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stemly",
  description: "Separa voz, batería, bajo y más de cualquier canción. 100% local, con IA.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es" className="dark">
      <body
        className={`${sans.className} ${sans.variable} ${mono.variable} bg-[#0c0c0d] text-zinc-100 antialiased`}
      >
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
