import type { Metadata } from "next";
import { AdminLoginForm, loginFailureFrom } from "@/components/admin/admin-login-form";

export const metadata: Metadata = { title: "Admin login · TicketArena" };

export default async function AdminLoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 px-4 py-12">
      <h1 className="font-semibold text-3xl tracking-tight">Admin login</h1>
      <AdminLoginForm failure={loginFailureFrom(await searchParams)} />
    </main>
  );
}
