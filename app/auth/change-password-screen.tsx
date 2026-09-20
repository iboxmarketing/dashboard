"use client";

import { useState } from "react";

import { AuthCard } from "./auth-primitives";
import { PasswordField } from "./password-field";
import { FormField } from "../ui/form";
import { AuthError } from "@/lib/auth-adapter";
import { PASSWORD_RULE_HINT, checkNewPassword } from "@/lib/auth-password";
import type { ChangePasswordRequest } from "@/lib/auth-types";

/**
 * Blocking password change.
 *
 * Rendered instead of the dashboard while `mustChangePassword` is true, so a user
 * on a temporary password cannot reach any section first. Client validation is
 * feedback only; the backend still decides.
 *
 * Also reachable voluntarily from the profile menu, where it is not blocking.
 */
export function ChangePasswordScreen({ onSubmit, onCancel, email, blocking = true }: {
  onSubmit: (body: ChangePasswordRequest) => Promise<void>;
  onCancel?: () => void;
  email?: string;
  blocking?: boolean;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const check = checkNewPassword(current, next, confirm);
    if (!check.ok) { setError(check.error); return; }
    setBusy(true); setError(null);
    try {
      await onSubmit({ currentPassword: current, newPassword: next });
      setCurrent(""); setNext(""); setConfirm("");
    } catch (caught) {
      setError(caught instanceof AuthError ? caught.message : "Parol o‘zgartirilmadi. Keyinroq urinib ko‘ring.");
    } finally { setBusy(false); }
  };

  return (
    <AuthCard
      title="Parolni o‘zgartirish"
      subtitle={blocking
        ? "Davom etish uchun vaqtinchalik parolni o‘zingizning parolingizga almashtiring."
        : "Yangi parol o‘ylab, quyida kiriting."}
    >
      <form onSubmit={submit} noValidate>
        {email && <p className="auth-sub auth-identity">{email}</p>}
        <FormField label="Hozirgi (vaqtinchalik) parol" required>
          <PasswordField value={current} onChange={setCurrent} autoComplete="current-password" autoFocus />
        </FormField>
        <FormField label="Yangi parol" required hint={PASSWORD_RULE_HINT}>
          <PasswordField value={next} onChange={setNext} autoComplete="new-password" />
        </FormField>
        <FormField label="Yangi parolni tasdiqlang" required>
          <PasswordField value={confirm} onChange={setConfirm} autoComplete="new-password" />
        </FormField>
        {error && <p className="form-error auth-form-error" role="alert">{error}</p>}
        <button type="submit" className="button auth-submit" disabled={busy}>
          {busy ? "Saqlanmoqda…" : "Parolni saqlash"}
        </button>
        {!blocking && onCancel && (
          <button type="button" className="button secondary auth-submit" onClick={onCancel} disabled={busy}>Bekor qilish</button>
        )}
      </form>
      {blocking && <p className="auth-hint">Parol o‘zgartirilmaguncha boshqa bo‘limlar ochilmaydi.</p>}
      <p className="auth-hint">Parol almashtirilgach barcha seanslar yopiladi — yangi parol bilan qaytadan kirasiz.</p>
    </AuthCard>
  );
}
