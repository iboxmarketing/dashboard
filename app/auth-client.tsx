"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import DashboardClient from "./dashboard-client";
import type { PublicAuthUser } from "@/lib/auth/types";

type AuthState = "loading" | "anonymous" | "authenticated";

export default function AuthClient() {
  const [state, setState] = useState<AuthState>("loading");
  const [user, setUser] = useState<PublicAuthUser | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/me", { cache: "no-store" });
      const payload = await response.json() as { user?: PublicAuthUser };
      if (!response.ok || !payload.user) { setUser(null); setState("anonymous"); return; }
      setUser(payload.user); setState("authenticated");
    } catch { setUser(null); setState("anonymous"); }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function login(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      const payload = await response.json() as { user?: PublicAuthUser; error?: string };
      if (!response.ok || !payload.user) throw new Error(payload.error ?? "Kirish bajarilmadi");
      setUser(payload.user); setState("authenticated"); setPassword("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Kirish bajarilmadi"); }
    finally { setBusy(false); }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault(); setError(null);
    if (newPassword !== confirmPassword) { setError("Yangi parollar bir xil emas"); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/auth/change-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword: password, newPassword }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Parol almashtirilmadi");
      setUser(null); setState("anonymous"); setPassword(""); setNewPassword(""); setConfirmPassword("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Parol almashtirilmadi"); }
    finally { setBusy(false); }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setUser(null); setState("anonymous");
  }

  if (state === "loading") return <div className="app-loading"><div className="loading-mark">B24</div><p>Sessiya tekshirilmoqda…</p></div>;
  if (state === "anonymous" || !user) return <main className="auth-page"><form className="auth-card" onSubmit={login}>
    <div className="auth-mark">B24</div><p className="eyebrow">IBOX DASHBOARD</p><h1>Kirish</h1><p className="auth-copy">Dashboard ma’lumotlari faqat ruxsat berilgan foydalanuvchilar uchun ochiq.</p>
    {error && <div className="notice error">{error}</div>}
    <label>Email<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
    <label>Parol<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
    <button className="button primary" disabled={busy}>{busy ? "Tekshirilmoqda…" : "Kirish"}</button>
  </form></main>;

  if (user.mustChangePassword) return <main className="auth-page"><form className="auth-card" onSubmit={changePassword}>
    <div className="auth-mark">B24</div><p className="eyebrow">XAVFSIZLIK</p><h1>Vaqtinchalik parolni almashtiring</h1><p className="auth-copy">Dashboard ochilishidan oldin shaxsiy parol o‘rnating.</p>
    {error && <div className="notice error">{error}</div>}
    <label>Vaqtinchalik parol<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
    <label>Yangi parol<input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={12} required /></label>
    <label>Yangi parolni takrorlang<input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={12} required /></label>
    <button className="button primary" disabled={busy}>{busy ? "Saqlanmoqda…" : "Parolni saqlash"}</button>
    <button type="button" className="button secondary" onClick={() => void logout()}>Chiqish</button>
  </form></main>;

  if (user.role !== "ADMIN" && user.permissions.length === 0) return <main className="auth-page"><section className="auth-card">
    <div className="auth-mark">B24</div><p className="eyebrow">ACCESS CONTROL</p><h1>Ruxsat biriktirilmagan</h1>
    <p className="auth-copy">Administrator sizga kamida bitta Dashboard bo‘limiga ruxsat berishi kerak.</p>
    <button className="button secondary" onClick={() => void logout()}>Chiqish</button>
  </section></main>;

  return <DashboardClient authUser={user} onLogout={() => void logout()} />;
}
