"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PERMISSIONS, type PermissionKey } from "@/lib/auth/permissions";
import type { AuthRole, PublicAuthUser } from "@/lib/auth/types";

type Draft = { id?: string; email: string; name: string; role: AuthRole; active: boolean; permissions: PermissionKey[]; temporaryPassword: string };
const emptyDraft = (): Draft => ({ email: "", name: "", role: "MEMBER", active: true, permissions: [], temporaryPassword: "" });

export function UsersView() {
  const [users, setUsers] = useState<PublicAuthUser[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/admin/users", { cache: "no-store" });
    const payload = await response.json() as { users?: PublicAuthUser[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Foydalanuvchilar yuklanmadi");
    setUsers(payload.users ?? []);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load().catch((caught) => setError(caught instanceof Error ? caught.message : "Foydalanuvchilar yuklanmadi")); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!draft) return; setBusy(true); setError(null);
    try {
      const response = await fetch("/api/admin/users", { method: draft.id ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...draft, temporaryPassword: draft.temporaryPassword || undefined }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Saqlab bo‘lmadi");
      setDraft(null); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Saqlab bo‘lmadi"); }
    finally { setBusy(false); }
  }
  function edit(user: PublicAuthUser) { setDraft({ id: user.id, email: user.email, name: user.name, role: user.role, active: user.active, permissions: user.permissions.filter((key): key is PermissionKey => PERMISSIONS.some((item) => item.key === key)), temporaryPassword: "" }); }
  return <><div className="page-title"><div><p className="eyebrow">ACCESS CONTROL</p><h1>Foydalanuvchilar</h1><p>Rol, bo‘lim ruxsatlari va vaqtinchalik parollar serverda boshqariladi.</p></div><button className="button primary" onClick={() => setDraft(emptyDraft())}>Yangi foydalanuvchi</button></div>
    {error && <div className="notice error page-notice">{error}</div>}
    <section className="panel"><div className="table-wrap"><table className="data-table"><thead><tr><th>Foydalanuvchi</th><th>Rol</th><th>Holat</th><th>Ruxsatlar</th><th /></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td><strong>{user.name}</strong><small>{user.email}</small></td><td>{user.role}</td><td>{user.active ? "Faol" : "O‘chirilgan"}</td><td>{user.role === "ADMIN" ? "Barcha bo‘limlar" : user.permissions.join(", ") || "Ruxsat yo‘q"}</td><td><button className="button small secondary" onClick={() => edit(user)}>Tahrirlash</button></td></tr>)}</tbody></table></div></section>
    {draft && <div className="auth-modal"><form className="auth-card user-form" onSubmit={submit}><h2>{draft.id ? "Foydalanuvchini tahrirlash" : "Yangi foydalanuvchi"}</h2>
      <label>Ism<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /></label>
      <label>Email<input type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} required /></label>
      <label>Rol<select value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value as AuthRole })}><option value="MEMBER">MEMBER</option><option value="ADMIN">ADMIN</option></select></label>
      {draft.id && <label className="check-line"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /> Faol</label>}
      {draft.role === "MEMBER" && <fieldset><legend>Bo‘lim ruxsatlari</legend>{PERMISSIONS.filter((item) => item.key !== "users").map((item) => <label className="check-line" key={item.key}><input type="checkbox" checked={draft.permissions.includes(item.key)} onChange={(event) => setDraft({ ...draft, permissions: event.target.checked ? [...draft.permissions, item.key] : draft.permissions.filter((key) => key !== item.key) })} /> {item.label}</label>)}</fieldset>}
      <label>{draft.id ? "Yangi vaqtinchalik parol (ixtiyoriy)" : "Vaqtinchalik parol"}<input type="password" autoComplete="new-password" value={draft.temporaryPassword} onChange={(event) => setDraft({ ...draft, temporaryPassword: event.target.value })} required={!draft.id} /></label>
      <div className="auth-actions"><button type="button" className="button secondary" onClick={() => setDraft(null)}>Bekor qilish</button><button className="button primary" disabled={busy}>{busy ? "Saqlanmoqda…" : "Saqlash"}</button></div>
    </form></div>}
  </>;
}
