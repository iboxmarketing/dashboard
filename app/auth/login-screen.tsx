"use client";

import { useState } from "react";

import { AuthCard } from "./auth-primitives";
import { PasswordField } from "./password-field";
import { FormField, TextInput } from "../ui/form";
import { AuthError } from "@/lib/auth-adapter";
import type { LoginRequest } from "@/lib/auth-types";

/**
 * Login.
 *
 * There is no "forgot password" link: the backend contract has no reset flow, and
 * a link that goes nowhere is worse than its absence. An admin issues a temporary
 * password instead, which is the documented path.
 *
 * No Cloudflare or hosting-account wording appears here — this is the product's
 * own sign-in, and mentioning infrastructure would only confuse staff.
 */
export function LoginScreen({ onLogin, initialError }: {
  onLogin: (body: LoginRequest) => Promise<void>;
  initialError?: string | null;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!email.trim() || !password) { setError("Email va parolni kiriting"); return; }
    setBusy(true); setError(null);
    try {
      await onLogin({ email: email.trim(), password });
    } catch (caught) {
      // The adapter already collapses wrong-password, unknown-email and
      // deactivated into one message, so nothing here can leak account state.
      setError(caught instanceof AuthError ? caught.message : "Kirish amalga oshmadi. Keyinroq urinib ko‘ring.");
      setPassword("");
    } finally { setBusy(false); }
  };

  return (
    <AuthCard title="Tizimga kirish" subtitle="Ishchi email va parolingiz bilan kiring.">
      <form onSubmit={submit} noValidate>
        <FormField label="Email" required>
          <TextInput type="email" value={email} autoComplete="username" inputMode="email"
            onChange={(event) => setEmail(event.target.value)} data-autofocus autoFocus disabled={busy} />
        </FormField>
        <FormField label="Parol" required>
          <PasswordField value={password} onChange={setPassword} autoComplete="current-password" />
        </FormField>
        {error && <p className="form-error auth-form-error" role="alert">{error}</p>}
        <button type="submit" className="button auth-submit" disabled={busy}>
          {busy ? "Kirilmoqda…" : "Kirish"}
        </button>
      </form>
      <p className="auth-hint">
        Parolni bilmasangiz yoki hisobingiz ishlamasa, administratorga murojaat qiling — u vaqtinchalik parol beradi.
      </p>
    </AuthCard>
  );
}
