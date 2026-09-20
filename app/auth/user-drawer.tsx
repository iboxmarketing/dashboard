"use client";

import { useState } from "react";

import { Drawer } from "../ui/drawer";
import { FormField, SelectInput, TextInput } from "../ui/form";
import { PasswordField } from "./password-field";
import { ASSIGNABLE_PERMISSIONS, NAV_GROUP_LABELS, permissionGroups, togglePermission } from "@/lib/auth-permissions";
import { PASSWORD_RULE_HINT, checkEmail, checkTemporaryPassword, normalizeEmailInput } from "@/lib/auth-password";
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
      {!isAdmin && <p className="auth-perm-note">
        Belgilanmagan bo‘lim foydalanuvchiga butunlay ko‘rinmaydi va uning API’si ham 403 qaytaradi.
        Foydalanuvchilar bo‘limi faqat ADMIN uchun — uni MEMBER’ga berib bo‘lmaydi.
      </p>}
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
  // `users` can never be granted to a MEMBER, so it is filtered out of whatever
  // the server sent rather than shown as an unassignable box.
  const [permissions, setPermissions] = useState<Permission[]>(
    (user?.permissions ?? ["dashboard"]).filter((permission) => ASSIGNABLE_PERMISSIONS.includes(permission)),
  );
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [mustChange, setMustChange] = useState(user ? user.mustChangePassword : true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = (message: string) => typeof window === "undefined" || window.confirm(message);

  const save = async () => {
    const trimmedName = name.trim();
    if (trimmedName.length < 2 || trimmedName.length > 120) return setError("Ism 2–120 belgi bo‘lishi kerak");
    const emailCheck = checkEmail(email);
    if (!emailCheck.ok) return setError(emailCheck.error);
    // The server lowercases on write; sending the same value keeps the row and
    // the form in agreement after a save.
    const normalizedEmail = normalizeEmailInput(email);

    if (!editing) {
      const passwordCheck = checkTemporaryPassword(temporaryPassword);
      if (!passwordCheck.ok) return setError(passwordCheck.error);
      if (role === "ADMIN" && !confirmed(`${trimmedName} ADMIN sifatida yaratiladi va barcha bo‘limlarga kiradi. Davom etamizmi?`)) return;
    } else {
      // Mirrors the server, which refuses both outright; showing the refusal here
      // saves a round trip but is not what makes it safe.
      if (isSelf && !active) return setError("Administrator o‘zini o‘chira olmaydi");
      if (isSelf && role !== "ADMIN" && user!.role === "ADMIN") return setError("Administrator o‘z rolini olib tashlay olmaydi");
      if (role === "ADMIN" && user!.role !== "ADMIN" && !confirmed(`${trimmedName} ADMIN bo‘ladi va barcha bo‘limlarga kiradi. Davom etamizmi?`)) return;
      if (!active && user!.active && !confirmed(`${trimmedName} faolsizlantiriladi, ochiq seanslari yopiladi va tizimga kira olmaydi. Davom etamizmi?`)) return;
      if (temporaryPassword) {
        const passwordCheck = checkTemporaryPassword(temporaryPassword);
        if (!passwordCheck.ok) return setError(passwordCheck.error);
        if (!confirmed(`${trimmedName} uchun parol almashtiriladi. Eski parol ishlamaydi va ochiq seanslari yopiladi. Davom etamizmi?`)) return;
      }
    }

    setBusy(true); setError(null);
    try {
      if (!editing) {
        await onCreate({
          name: trimmedName, email: normalizedEmail, role, temporaryPassword,
          // A new account always starts on a temporary password; the server
          // forces this regardless of what the form sends.
          mustChangePassword: true, permissions: role === "ADMIN" ? [] : permissions,
        });
      } else {
        await onPatch({
          id: user!.id, name: trimmedName, email: normalizedEmail, role, active,
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
          ? `Faqat parolni almashtirmoqchi bo‘lsangiz to‘ldiring. ${PASSWORD_RULE_HINT} Saqlangan parol hech qachon ko‘rsatilmaydi.`
          : `${PASSWORD_RULE_HINT} Foydalanuvchiga og‘zaki yoki xavfsiz kanal orqali yetkazing — keyin hech qayerda ko‘rinmaydi.`}>
        <PasswordField value={temporaryPassword} onChange={setTemporaryPassword} autoComplete="new-password" />
      </FormField>

      {editing ? (
        <FormField label="Keyingi kirishda parol almashtirilsin"
          hint="Yangi vaqtinchalik parol kiritsangiz, server buni baribir majburiy qiladi.">
          <label className="auth-switch">
            <input type="checkbox" checked={mustChange} onChange={(event) => setMustChange(event.target.checked)} />
            <span>{mustChange ? "Ha" : "Yo‘q"}</span>
          </label>
        </FormField>
      ) : (
        <p className="form-hint">Yangi foydalanuvchi birinchi kirishda parolini albatta almashtiradi.</p>
      )}

      <FormField label="Bo‘lim ruxsatlari">
        <PermissionPicker role={role} permissions={permissions}
          onToggle={(permission) => setPermissions((current) => togglePermission(current, permission))} />
      </FormField>

      {error && <p className="form-error" role="alert">{error}</p>}
    </Drawer>
  );
}
