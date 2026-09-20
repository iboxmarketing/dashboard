"use client";

import { useState } from "react";

import { Drawer } from "../ui/drawer";
import { FormField, SelectInput, TextInput } from "../ui/form";
import { PasswordField } from "./password-field";
import { NAV_GROUP_LABELS, permissionGroups, togglePermission } from "@/lib/auth-permissions";
import { checkEmail, checkTemporaryPassword } from "@/lib/auth-password";
import { ROLES, ROLE_LABELS, type AuthUser, type NewUser, type Permission, type Role, type UserPatch } from "@/lib/auth-types";

/**
 * Grouped permission checkboxes — never a raw JSON editor, because an admin
 * editing JSON is one typo away from locking a team out.
 *
 * For ADMIN the boxes render checked and disabled: the role grants everything, so
 * showing an editable list would imply the admin's access depends on it.
 */
function PermissionPicker({ role, permissions, onToggle }: {
  role: Role; permissions: readonly Permission[]; onToggle: (permission: Permission) => void;
}) {
  const isAdmin = role === "ADMIN";
  return (
    <div className="auth-perm-groups">
      {isAdmin && <p className="auth-perm-note">Admin barcha bo‘limlarga kiradi — ruxsatlarni alohida belgilash kerak emas.</p>}
      {permissionGroups().map((group) => (
        <fieldset key={group.group} className="auth-perm-group" disabled={isAdmin}>
          <legend>{NAV_GROUP_LABELS[group.group]}</legend>
          {group.entries.map((entry) => (
            <label key={entry.permission} className="auth-perm-row">
              <input type="checkbox" checked={isAdmin || permissions.includes(entry.permission)}
                disabled={isAdmin} onChange={() => onToggle(entry.permission)} />
              <span className="auth-perm-label">{entry.label}<small>{entry.description}</small></span>
            </label>
          ))}
        </fieldset>
      ))}
      {!isAdmin && <p className="auth-perm-note">Belgilanmagan bo‘lim foydalanuvchiga butunlay ko‘rinmaydi.</p>}
    </div>
  );
}

/**
 * Create / edit user.
 *
 * A temporary password is write-only: it is sent once and never read back, so the
 * drawer cannot display a saved password later. On edit the field is empty and
 * only submitted when the admin deliberately types a new one.
 *
 * `selfId` guards the one client-preventable footgun: an admin deactivating or
 * demoting their own account and locking themselves out.
 */
export function UserDrawer({ open, user, selfId, onClose, onCreate, onPatch }: {
  open: boolean;
  user: AuthUser | null;
  selfId: string | null;
  onClose: () => void;
  onCreate: (body: NewUser) => Promise<void>;
  onPatch: (body: UserPatch) => Promise<void>;
}) {
  const editing = user !== null;
  const isSelf = editing && user!.id === selfId;
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? "MEMBER");
  const [active, setActive] = useState(user?.active ?? true);
  const [permissions, setPermissions] = useState<Permission[]>(user?.permissions ?? ["dashboard"]);
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [mustChange, setMustChange] = useState(user ? user.mustChangePassword : true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = (message: string) => typeof window === "undefined" || window.confirm(message);

  const save = async () => {
    if (!name.trim()) return setError("Ismni kiriting");
    const emailCheck = checkEmail(email);
    if (!emailCheck.ok) return setError(emailCheck.error);

    if (!editing) {
      const passwordCheck = checkTemporaryPassword(temporaryPassword);
      if (!passwordCheck.ok) return setError(passwordCheck.error);
      if (role === "ADMIN" && !confirmed(`${name.trim()} ADMIN sifatida yaratiladi va barcha bo‘limlarga kiradi. Davom etamizmi?`)) return;
    } else {
      if (isSelf && !active) return setError("O‘z hisobingizni faolsizlantira olmaysiz");
      if (isSelf && role !== "ADMIN" && user!.role === "ADMIN") return setError("O‘zingizni ADMIN’dan tushira olmaysiz");
      if (role === "ADMIN" && user!.role !== "ADMIN" && !confirmed(`${name.trim()} ADMIN bo‘ladi va barcha bo‘limlarga kiradi. Davom etamizmi?`)) return;
      if (!active && user!.active && !confirmed(`${name.trim()} faolsizlantiriladi va tizimga kira olmaydi. Davom etamizmi?`)) return;
      if (temporaryPassword) {
        const passwordCheck = checkTemporaryPassword(temporaryPassword);
        if (!passwordCheck.ok) return setError(passwordCheck.error);
        if (!confirmed(`${name.trim()} uchun parol almashtiriladi. Eski parol ishlamaydi. Davom etamizmi?`)) return;
      }
    }

    setBusy(true); setError(null);
    try {
      if (!editing) {
        await onCreate({
          name: name.trim(), email: email.trim(), role, temporaryPassword,
          mustChangePassword: mustChange, permissions: role === "ADMIN" ? [] : permissions,
        });
      } else {
        await onPatch({
          id: user!.id, name: name.trim(), email: email.trim(), role, active,
          permissions: role === "ADMIN" ? [] : permissions,
          mustChangePassword: mustChange,
          ...(temporaryPassword ? { temporaryPassword } : {}),
        });
      }
      setTemporaryPassword("");
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Saqlanmadi");
    } finally { setBusy(false); }
  };

  return (
    <Drawer open={open} title={editing ? "Foydalanuvchini tahrirlash" : "Yangi foydalanuvchi"}
      context="Foydalanuvchilar" dirty={Boolean(name || email) && !busy} onClose={onClose}
      footer={<>
        <button type="button" className="button secondary" onClick={onClose} disabled={busy}>Bekor qilish</button>
        <button type="button" className="button" onClick={save} disabled={busy}>{busy ? "Saqlanmoqda…" : "Saqlash"}</button>
      </>}>
      <FormField label="Ism" required><TextInput value={name} onChange={(event) => setName(event.target.value)} data-autofocus /></FormField>
      <FormField label="Email" required><TextInput type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></FormField>
      <FormField label="Rol" required hint={isSelf ? "O‘z rolingizni pasaytira olmaysiz" : undefined}>
        <SelectInput value={role} onChange={(event) => setRole(event.target.value as Role)}>
          {ROLES.map((option) => <option key={option} value={option}>{ROLE_LABELS[option]}</option>)}
        </SelectInput>
      </FormField>

      {editing && (
        <FormField label="Holat" hint={isSelf ? "O‘z hisobingizni faolsizlantira olmaysiz" : undefined}>
          <label className="auth-switch">
            <input type="checkbox" checked={active} disabled={isSelf} onChange={(event) => setActive(event.target.checked)} />
            <span>{active ? "Faol" : "Faol emas"}</span>
          </label>
        </FormField>
      )}

      <FormField label={editing ? "Vaqtinchalik parol (ixtiyoriy)" : "Vaqtinchalik parol"}
        required={!editing}
        hint={editing
          ? "Faqat parolni almashtirmoqchi bo‘lsangiz to‘ldiring. Saqlangan parol hech qachon ko‘rsatilmaydi."
          : "Foydalanuvchiga og‘zaki yoki xavfsiz kanal orqali yetkazing. Keyin hech qayerda ko‘rinmaydi."}>
        <PasswordField value={temporaryPassword} onChange={setTemporaryPassword} autoComplete="new-password" />
      </FormField>

      <FormField label="Keyingi kirishda parol almashtirilsin">
        <label className="auth-switch">
          <input type="checkbox" checked={mustChange} onChange={(event) => setMustChange(event.target.checked)} />
          <span>{mustChange ? "Ha" : "Yo‘q"}</span>
        </label>
      </FormField>

      <FormField label="Bo‘lim ruxsatlari">
        <PermissionPicker role={role} permissions={permissions}
          onToggle={(permission) => setPermissions((current) => togglePermission(current, permission))} />
      </FormField>

      {error && <p className="form-error" role="alert">{error}</p>}
    </Drawer>
  );
}
