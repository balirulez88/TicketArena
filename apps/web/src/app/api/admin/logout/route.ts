import { handleAdminLogout } from "@/server/identity/admin-login";

export function POST(request: Request): Response {
  return handleAdminLogout(request);
}
