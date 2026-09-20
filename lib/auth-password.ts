/**
 * Client-side password feedback.
 *
 * Advisory only: the backend remains authoritative and may reject a password this
 * accepts. The point is to catch the obvious mistakes before a round trip, not to
 * be the policy.
 */
export const PASSWORD_MIN_LENGTH = 8;

export type PasswordCheck = { ok: boolean; error: string | null };

export function checkNewPassword(current: string, next: string, confirm: string): PasswordCheck {
  if (!current) return { ok: false, error: "Hozirgi parolni kiriting" };
  if (!next) return { ok: false, error: "Yangi parolni kiriting" };
  if (next.length < PASSWORD_MIN_LENGTH) return { ok: false, error: `Yangi parol kamida ${PASSWORD_MIN_LENGTH} belgidan iborat bo‘lsin` };
  if (next === current) return { ok: false, error: "Yangi parol hozirgisidan farq qilishi kerak" };
  if (next !== confirm) return { ok: false, error: "Parollar mos kelmadi" };
  return { ok: true, error: null };
}

/** Temporary password the admin sets for a new or reset user. */
export function checkTemporaryPassword(value: string): PasswordCheck {
  if (!value) return { ok: false, error: "Vaqtinchalik parolni kiriting" };
  if (value.length < PASSWORD_MIN_LENGTH) return { ok: false, error: `Parol kamida ${PASSWORD_MIN_LENGTH} belgidan iborat bo‘lsin` };
  return { ok: true, error: null };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function checkEmail(value: string): PasswordCheck {
  const email = value.trim();
  if (!email) return { ok: false, error: "Emailni kiriting" };
  if (!EMAIL.test(email)) return { ok: false, error: "Email formati noto‘g‘ri" };
  return { ok: true, error: null };
}
