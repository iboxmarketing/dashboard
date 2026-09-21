"use client";

import { Loader2, ShieldAlert, ShieldCheck, TriangleAlert, UserX } from "lucide-react";
import type { ReactNode } from "react";

import { FORBIDDEN_MESSAGE } from "@/lib/auth-adapter";
import { ROLE_LABELS, type Role } from "@/lib/auth-types";

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span className={`auth-badge role-${role.toLowerCase()}`}>
      {role === "ADMIN" ? <ShieldCheck size={11} aria-hidden="true" /> : null}
      {ROLE_LABELS[role]}
    </span>
  );
}

export function ActiveBadge({ active }: { active: boolean }) {
  return active
    ? <span className="auth-badge active">Faol</span>
    : <span className="auth-badge inactive"><UserX size={11} aria-hidden="true" />Faol emas</span>;
}

/** Full-screen gate while `/api/auth/me` resolves. No navigation renders yet. */
export function AuthLoadingScreen({ label = "Tekshirilmoqda…" }: { label?: string }) {
  return (
    <div className="auth-screen" role="status" aria-live="polite">
      <div className="auth-card auth-card-centered">
        <Loader2 size={24} className="spin" aria-hidden="true" />
        <p>{label}</p>
      </div>
    </div>
  );
}

/** Shown when the API refuses a section. Presentation only — never enforcement. */
export function ForbiddenState({ onBack }: { onBack?: () => void }) {
  return (
    <div className="auth-inline-state" role="alert">
      <ShieldAlert size={22} aria-hidden="true" />
      <strong>{FORBIDDEN_MESSAGE}</strong>
      <p>Agar bu xato bo‘lsa, administratorga murojaat qiling.</p>
      {onBack && <button type="button" className="button secondary small" onClick={onBack}>Ruxsat berilgan bo‘limga qaytish</button>}
    </div>
  );
}

/** A MEMBER with an empty permission list. Not an error — an unfinished setup. */
export function NoSectionsState({ email }: { email?: string }) {
  return (
    <div className="auth-inline-state" role="status">
      <ShieldAlert size={22} aria-hidden="true" />
      <strong>Sizga hali bo‘lim biriktirilmagan</strong>
      <p>Administrator sizga bo‘lim ruxsatini bergach, shu yerda ko‘rinadi.{email ? ` (${email})` : ""}</p>
    </div>
  );
}

export function AuthErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="auth-inline-state error" role="alert">
      <TriangleAlert size={22} aria-hidden="true" />
      <strong>Xatolik</strong>
      <p>{message}</p>
      {onRetry && <button type="button" className="button secondary small" onClick={onRetry}>Qayta urinish</button>}
    </div>
  );
}

/**
 * The card only — the surrounding full-height `.auth-screen` belongs to the gate,
 * so a screen can place its own siblings (a sign-out escape) beside the card.
 */
export function AuthCard({ title, subtitle, children, footer }: {
  title: string; subtitle?: string; children: ReactNode; footer?: ReactNode;
}) {
  return (
    <div className="auth-card">
      <div className="auth-brand"><span>IBOX</span> Dashboard</div>
      <h1>{title}</h1>
      {subtitle && <p className="auth-sub">{subtitle}</p>}
      {children}
      {footer && <div className="auth-card-footer">{footer}</div>}
    </div>
  );
}
