import { validatePassword } from "./auth/password";

/**
 * Client-side password feedback.
 *
 * Advisory only, and deliberately the *same* rule the server enforces:
 * `validatePassword` in `lib/auth/password.ts` is the policy, and this module
 * calls it rather than restating it. A client rule that were looser would send
 * users into a rejection they could not predict; one that were stricter would
 * refuse passwords the server accepts.
 */

/** Minimum length, read from the server policy rather than repeated here. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_RULE_HINT = "Kamida 12 ta belgi, katta va kichik harf hamda raqam.";

export type PasswordCheck = { ok: boolean; error: string | null };

function policy(value: string): PasswordCheck {
  const checked = validatePassword(value);
  return checked.ok ? { ok: true, error: null } : { ok: false, error: checked.error };
}

export function checkNewPassword(current: string, next: string, confirm: string): PasswordCheck {
  if (!current) return { ok: false, error: "Hozirgi parolni kiriting" };
  if (!next) return { ok: false, error: "Yangi parolni kiriting" };
  const checked = policy(next);
  if (!checked.ok) return checked;
  if (next === current) return { ok: false, error: "Yangi parol hozirgisidan farq qilishi kerak" };
  if (next !== confirm) return { ok: false, error: "Parollar mos kelmadi" };
  return { ok: true, error: null };
}

/** Temporary password the admin sets for a new or reset user. */
export function checkTemporaryPassword(value: string): PasswordCheck {
  if (!value) return { ok: false, error: "Vaqtinchalik parolni kiriting" };
  return policy(value);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function checkEmail(value: string): PasswordCheck {
  const email = value.trim();
  if (!email) return { ok: false, error: "Emailni kiriting" };
  if (!EMAIL.test(email)) return { ok: false, error: "Email formati noto‘g‘ri" };
  return { ok: true, error: null };
}

/** The server stores emails lowercased; the UI sends what the server will store. */
export const normalizeEmailInput = (value: string) => value.trim().toLowerCase();
