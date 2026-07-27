import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GB/C Lab — Browser Game Boy Emulator",
  description: "A from-scratch DMG and CGB emulator with hardware-inspired LCD response, frame blending, audio, and local cartridge saves.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
