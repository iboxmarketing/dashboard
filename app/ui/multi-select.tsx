"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";

import { selectionSummary, toggleSelection, type Selection } from "../../lib/record-filters";

export type MultiSelectOption = { id: string; name: string };

/** Show the search box only once scanning the list stops being practical. */
const SEARCH_THRESHOLD = 8;

/**
 * The open panel: presentational, so its checkbox list can be rendered and
 * asserted without a DOM. All state lives in `MultiSelect` below.
 */
export function MultiSelectPanel({ id, label, options, selected, onChange, query, onQuery, searchable = true }: {
  id?: string;
  label: string;
  options: MultiSelectOption[];
  selected: Selection;
  onChange: (next: string[]) => void;
  query: string;
  onQuery: (next: string) => void;
  searchable?: boolean;
}) {
  const needle = query.trim().toLocaleLowerCase();
  const visible = needle ? options.filter((option) => option.name.toLocaleLowerCase().includes(needle)) : options;

  return (
    <div className="multi-select-panel" id={id} role="group" aria-label={label}>
      <div className="multi-select-head">
        <strong>{label}</strong>
        {selected.length > 0 && (
          <button type="button" className="multi-select-clear" onClick={() => onChange([])}>
            <X size={13} aria-hidden="true" />Tozalash
          </button>
        )}
      </div>

      {searchable && options.length > SEARCH_THRESHOLD && (
        <input
          className="multi-select-search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Qidirish…"
          aria-label={`${label} — qidirish`}
        />
      )}

      <div className="multi-select-options">
        {visible.map((option) => {
          const checked = selected.includes(option.id);
          return (
            <label key={option.id} className={`multi-select-option ${checked ? "checked" : ""}`}>
              <input type="checkbox" checked={checked} onChange={() => onChange(toggleSelection(selected, option.id))} />
              <span className="multi-select-box" aria-hidden="true">{checked && <Check size={12} />}</span>
              <span className="multi-select-name">{option.name}</span>
            </label>
          );
        })}
        {!visible.length && <p className="multi-select-empty">Natija topilmadi</p>}
      </div>

      <p className="multi-select-note">
        {selected.length ? `${selected.length} tanlandi — birlashtirilgan natija` : "Hech biri tanlanmagan — barchasi"}
      </p>
    </div>
  );
}

/**
 * Checkbox dropdown for a filter dimension that accepts several values.
 *
 * An empty selection means "all", so the button reads as the unfiltered label
 * rather than as an empty state. Values commit per click instead of behind a
 * Done button: the dashboard recomputes from a `useMemo`, so each toggle is
 * already cheap and a confirm step would only delay the result.
 *
 * Native `<select multiple>` is deliberately not used — it needs ctrl/cmd-click,
 * which is undiscoverable on desktop and unusable on touch.
 */
export function MultiSelect({ label, allLabel, options, selected, onChange, searchable = true }: {
  label: string;
  allLabel: string;
  options: MultiSelectOption[];
  selected: Selection;
  onChange: (next: string[]) => void;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shellRef = useRef<HTMLDivElement>(null);
  const panelId = `${useId()}-panel`;

  // Pointer-down, not click: a click listener would also catch the press that
  // opened the panel, and closing on blur would break clicking a checkbox.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!shellRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [open]);

  const labelOf = (value: string) => options.find((option) => option.id === value)?.name ?? value;

  return (
    <div className={`multi-select ${selected.length ? "has-selection" : ""}`} ref={shellRef}>
      <button
        type="button"
        className="multi-select-button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="true"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="multi-select-value">{selectionSummary(selected, allLabel, labelOf)}</span>
        {selected.length > 1 && <span className="multi-select-count">{selected.length}</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open && (
        <MultiSelectPanel
          id={panelId} label={label} options={options} selected={selected}
          onChange={onChange} query={query} onQuery={setQuery} searchable={searchable}
        />
      )}
    </div>
  );
}
