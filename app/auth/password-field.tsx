"use client";

import { Eye, EyeOff } from "lucide-react";
import { useId, useState } from "react";

import { TextInput } from "../ui/form";

/**
 * Password input with a show/hide control.
 *
 * The toggle is a real button with `aria-pressed`, so a screen reader announces
 * whether the password is currently visible rather than just "button".
 */
export function PasswordField({ value, onChange, placeholder, autoComplete, id, autoFocus }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
  id?: string;
  autoFocus?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="auth-password">
      <TextInput
        id={inputId}
        type={visible ? "text" : "password"}
        value={value}
        autoComplete={autoComplete}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        {...(autoFocus ? { "data-autofocus": true, autoFocus: true } : {})}
      />
      <button
        type="button"
        className="auth-password-toggle"
        aria-pressed={visible}
        aria-label={visible ? "Parolni yashirish" : "Parolni ko‘rsatish"}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
      </button>
    </div>
  );
}
