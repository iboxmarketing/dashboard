"use client";

import { useId, useMemo, useRef, useState } from "react";

/**
 * Free-text combobox for project and update status.
 *
 * Status is deliberately not an enum — departments run different workflows, so
 * the suggestion list is drawn from values already in the data and is never a
 * constraint. Anything typed is accepted, including a value nobody has used
 * before.
 *
 * Replaces `<datalist>`, whose filtering, styling and keyboard behaviour differ
 * per browser and which offers no way to show that suggestions are optional.
 */
export function StatusCombobox({ value, options, onChange, placeholder, id, required }: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const listId = `${inputId}-list`;
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const matches = useMemo(() => {
    const query = value.trim().toLocaleLowerCase();
    const unique = [...new Set(options.filter(Boolean))];
    if (!query) return unique.slice(0, 8);
    return unique.filter((option) => option.toLocaleLowerCase().includes(query)).slice(0, 8);
  }, [options, value]);

  const choose = (option: string) => { onChange(option); setOpen(false); setActive(-1); };

  return (
    <div className="combobox">
      <input
        id={inputId}
        className="form-control"
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        required={required}
        value={value}
        placeholder={placeholder}
        onChange={(event) => { onChange(event.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => setOpen(true)}
        onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 120); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActive((i) => Math.min(matches.length - 1, i + 1)); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(-1, i - 1)); }
          else if (event.key === "Enter" && open && active >= 0) { event.preventDefault(); choose(matches[active]); }
          else if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); setActive(-1); }
          // Tab is left alone: it moves on and keeps whatever was typed.
        }}
      />
      {open && matches.length > 0 && (
        <ul className="combobox-list" id={listId} role="listbox">
          {matches.map((option, index) => (
            <li
              key={option}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? "active" : ""}
              onMouseDown={() => { if (blurTimer.current) clearTimeout(blurTimer.current); choose(option); }}
              onMouseEnter={() => setActive(index)}
            >
              {option}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
