import { handleLogout } from "@/lib/auth/logout";
import { revokeSession } from "@/lib/auth/storage";

/** Every path clears the cookie — see lib/auth/logout.ts. */
export async function POST(request: Request) {
  return handleLogout(request, revokeSession);
}
