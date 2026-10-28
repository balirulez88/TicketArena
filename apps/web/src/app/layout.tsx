import type { Metadata } from "next";
import type { ReactNode } from "react";
import { TRPCReactProvider } from "@/trpc/react";
import "./globals.css";

export const metadata: Metadata = {
  title: "TicketArena",
  description: "High-traffic ticket booking with a fair digital waiting room.",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <TRPCReactProvider>{children}</TRPCReactProvider>
      </body>
    </html>
  );
}
