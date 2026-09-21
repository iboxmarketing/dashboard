import { authenticateCredentials } from "@/lib/auth/authenticate";
import { handleLogin } from "@/lib/auth/login";
import { completeLogin, createSession, d1ThrottleStore, findUserByEmail, resolveSession } from "@/lib/auth/storage";

/** The logic, including the bounded throttle, lives in lib/auth/login.ts. */
export async function POST(request: Request) {
  try {
    return await handleLogin(request, {
      throttle: d1ThrottleStore, findUserByEmail, authenticate: authenticateCredentials, createSession, completeLogin, resolveSession,
    });
  } catch {
    // Never "wrong password" for a server fault: that would send the user
    // retrying credentials against an outage.
    return Response.json({ error: "Kirishni bajarib bo‘lmadi" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
