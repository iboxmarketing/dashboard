import { consumePasswordCheck, verifyPassword } from "./password";
import type { AuthUser } from "./types";

/** Credential comparison is deliberately account-enumeration resistant. */
export async function authenticateCredentials(user: AuthUser | null, password: string) {
  if (!user) { await consumePasswordCheck(password); return null; }
  const matches = await verifyPassword(password, user.passwordHash);
  return matches && user.active ? user : null;
}
