import type { ReactNode, SelectHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from "react";

/**
 * Form primitives.
 *
 * Every settings, project, page, widget and share control renders through
 * these, so control height, typography, focus ring, disabled and error styling
 * are decided once instead of per-panel.
 *
 * Deliberately free of icons and app state: this module is plain React, so the
 * required/error/helper states can be rendered and asserted in tests.
 *
 * These components carry no validation of their own — business rules stay in
 * `lib/*`; `error` here is display only.
 */

export type FieldProps = {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  className?: string;
  children: ReactNode;
};

/** Label + control + helper/error text, in a consistent vertical rhythm. */
export function FormField({ label, htmlFor, hint, error, required, className, children }: FieldProps) {
  return (
    <div className={`form-field${error ? " has-error" : ""}${className ? ` ${className}` : ""}`}>
      <label className="form-label" htmlFor={htmlFor}>
        {label}
        {required && <span className="form-required" aria-hidden="true">*</span>}
        {required && <span className="sr-only">(majburiy)</span>}
      </label>
      {children}
      {error
        ? <p className="form-error" role="alert">{error}</p>
        : hint ? <p className="form-hint">{hint}</p> : null}
    </div>
  );
}

type BaseInput = Omit<InputHTMLAttributes<HTMLInputElement>, "className">;

const control = (error?: string | null) => `form-control${error ? " is-invalid" : ""}`;

export function TextInput({ error, ...props }: BaseInput & { error?: string | null }) {
  return <input type="text" {...props} className={control(error)} aria-invalid={error ? true : undefined} />;
}

export function NumberInput({ error, ...props }: BaseInput & { error?: string | null }) {
  return <input inputMode="numeric" {...props} type="number" className={control(error)} aria-invalid={error ? true : undefined} />;
}

export function DateInput({ error, ...props }: BaseInput & { error?: string | null }) {
  // Native picker kept on purpose — the styling below makes it match.
  return <input {...props} type="date" className={`${control(error)} form-control-date`} aria-invalid={error ? true : undefined} />;
}

export function TimeInput({ error, ...props }: BaseInput & { error?: string | null }) {
  return <input {...props} type="time" className={`${control(error)} form-control-date`} aria-invalid={error ? true : undefined} />;
}

export function SelectInput({ error, children, ...props }: Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> & { error?: string | null }) {
  return (
    <select {...props} className={`${control(error)} form-select`} aria-invalid={error ? true : undefined}>
      {children}
    </select>
  );
}

export function Textarea({ error, rows = 3, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> & { error?: string | null }) {
  return <textarea {...props} rows={rows} className={`${control(error)} form-textarea`} aria-invalid={error ? true : undefined} />;
}

/**
 * A checkbox that stays a real focusable checkbox.
 *
 * The previous card selectors hid the input with `display:none` and painted a
 * substitute, which removed them from the keyboard order entirely. Here the
 * input is visually hidden but still focusable, and `:focus-visible` on it
 * styles the card.
 */
export function CheckCard({ checked, onChange, disabled, title, meta, hint }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  title: ReactNode;
  meta?: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className={`check-card${checked ? " selected" : ""}${disabled ? " disabled" : ""}`}>
      <input
        type="checkbox"
        className="check-card-input"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="check-card-box" aria-hidden="true" />
      <span className="check-card-body">
        <strong>{title}</strong>
        {meta ? <small>{meta}</small> : null}
        {hint ? <small>{hint}</small> : null}
      </span>
    </label>
  );
}
