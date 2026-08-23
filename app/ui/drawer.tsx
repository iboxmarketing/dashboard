"use client";

import { useCallback, useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";

/**
 * Right-side management drawer.
 *
 * Replaces the full-width editor panels that used to render *below* the page,
 * which pushed the list out of view while editing. One drawer serves project
 * create/edit and update create/edit.
 *
 * Hand-rolled rather than pulling in a modal library: the behaviour needed here
 * is a focus trap, Escape, and a guarded backdrop, and that is less code than a
 * dependency plus its styling overrides.
 */
export function Drawer({ open, title, context, dirty, onClose, footer, children }: {
  open: boolean;
  title: string;
  context?: string;
  /** When true, Escape and backdrop clicks confirm before discarding. */
  dirty?: boolean;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const headingId = useId();

  const requestClose = useCallback(() => {
    if (dirty && !window.confirm("Saqlanmagan o‘zgarishlar bor. Yopilsinmi?")) return;
    onClose();
  }, [dirty, onClose]);

  // Remember the trigger so focus returns where the user left it.
  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    // querySelector returns the first match in document order, not the first
    // matching selector — a plain comma list focused the header close button.
    const target = panel.current?.querySelector<HTMLElement>("[data-autofocus]")
      ?? panel.current?.querySelector<HTMLElement>(".drawer-body input, .drawer-body select, .drawer-body textarea");
    target?.focus();
    return () => restoreTo.current?.focus?.();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      // React attaches its listeners at the document root, so a nested handler's
      // stopPropagation cannot stop this sibling listener on the same node.
      // `defaultPrevented` is the reliable signal that something inner — the
      // combobox dismissing its suggestions — already consumed this Escape.
      if (event.key === "Escape") { if (!event.defaultPrevented) requestClose(); return; }
      if (event.key !== "Tab" || !panel.current) return;
      // Keep Tab inside the drawer while it is open.
      const focusable = [...panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((node) => node.offsetParent !== null || node.tagName === "INPUT");
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    };
    // Bubble phase, not capture: a nested control that handles Escape itself —
    // the status combobox closing its suggestion list — calls stopPropagation,
    // and in capture phase the drawer would have swallowed that first and shut
    // the whole editor instead.
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, requestClose]);

  if (!open) return null;
  return (
    <div className="drawer-root">
      <div className="drawer-backdrop" onClick={requestClose} aria-hidden="true" />
      <div className="drawer-panel" role="dialog" aria-modal="true" aria-labelledby={headingId} ref={panel}>
        <header className="drawer-head">
          <div>
            <h2 id={headingId}>{title}</h2>
            {context ? <p>{context}</p> : null}
          </div>
          <button type="button" className="drawer-close" onClick={requestClose} aria-label="Yopish">×</button>
        </header>
        <div className="drawer-body">{children}</div>
        <footer className="drawer-foot">{footer}</footer>
      </div>
    </div>
  );
}
