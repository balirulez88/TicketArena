import type { Metadata } from "next";
import { AdminDashboard } from "@/components/admin/admin-dashboard";

export const metadata: Metadata = { title: "Admin · TicketArena" };

// Reached only with a valid admin cookie: proxy.ts redirects everyone else to /admin/login.
export default function AdminPage() {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-12">
      <h1 className="font-semibold text-3xl tracking-tight">Admin dashboard</h1>
      <AdminDashboard />
    </main>
  );
}
