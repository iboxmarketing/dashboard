"use client";

import { KeyRound, LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { RoleBadge } from "./auth-primitives";
import type { AuthUser } from "@/lib/auth-types";

/**
 * Profile menu, replacing the static avatar.
 *
 * Shows who is signed in and offers only the two actions a user has over their
 * own account. Permission editing is never here — that is an admin action on the
 * Foydalanuvchilar screen, so a MEMBER has no path to it at all.
 */
export function ProfileMenu({ user, onChangePassword, onLogout }: {
  user: AuthUser;
  onChangePassword: () => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  const initials = user.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => { if (!shell.current?.contains(event.target as Node)) setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [open]);

  return (
    <div className="auth-profile" ref={shell}>
      <button type="button" className="auth-profile-trigger" aria-expanded={open} aria-haspopup="true"
        aria-label="Profil menyusi" onClick={() => setOpen((current) => !current)}>
        <span className="auth-avatar" aria-hidden="true">{initials}</span>
        <span className="auth-profile-name">{user.name}</span>
      </button>
      {open && (
        <div className="auth-profile-menu" role="menu">
          <div className="auth-profile-head">
            <strong>{user.name}</strong>
            <span>{user.email}</span>
            <RoleBadge role={user.role} />
          </div>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onChangePassword(); }}>
            <KeyRound size={14} aria-hidden="true" />Parolni o‘zgartirish
          </button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onLogout(); }}>
            <LogOut size={14} aria-hidden="true" />Chiqish
          </button>
        </div>
      )}
    </div>
  );
}
