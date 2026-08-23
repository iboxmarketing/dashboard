import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CheckCard, DateInput, FormField, NumberInput, SelectInput, TextInput, Textarea,
} from "../app/ui/form";
import { isManagementView, isSalesView } from "../app/dashboard-client";

/**
 * Sprint 23 — UI foundation.
 *
 * The form primitives are plain React, so their required/error/helper states
 * are rendered and asserted here rather than eyeballed. Everything that lives
 * inside the stateful dashboard component is asserted against its source.
 */

const client = readFileSync(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

// ------------------------------------------------------------ primitives ---

test("FormField renders label, helper text and the required indicator", () => {
  const html = renderToStaticMarkup(
    <FormField label="Sahifa nomi" hint="Ixtiyoriy matn" required><TextInput value="" readOnly /></FormField>);
  assert.match(html, /Sahifa nomi/);
  assert.match(html, /form-hint/);
  assert.match(html, /Ixtiyoriy matn/);
  assert.match(html, /form-required/);
  assert.match(html, /\(majburiy\)/, "the required marker has a screen-reader equivalent");
  assert.doesNotMatch(html, /form-error/, "no error styling without an error");
});

test("FormField in an error state replaces the hint and announces itself", () => {
  const html = renderToStaticMarkup(
    <FormField label="Nomi" hint="yordam" error="Sahifa nomi kerak"><TextInput value="" error="x" readOnly /></FormField>);
  assert.match(html, /has-error/);
  assert.match(html, /role="alert"/, "errors are announced");
  assert.match(html, /Sahifa nomi kerak/);
  assert.doesNotMatch(html, /yordam/, "the hint gives way to the error");
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /is-invalid/);
});

test("every control renders the shared class, so sizing is decided once", () => {
  for (const [name, html] of [
    ["text", renderToStaticMarkup(<TextInput value="" readOnly />)],
    ["number", renderToStaticMarkup(<NumberInput value={1} readOnly />)],
    ["date", renderToStaticMarkup(<DateInput value="" readOnly />)],
    ["select", renderToStaticMarkup(<SelectInput value=""><option value="">a</option></SelectInput>)],
    ["textarea", renderToStaticMarkup(<Textarea value="" readOnly />)],
  ] as const) {
    assert.match(html, /class="form-control/, `${name} uses the shared control class`);
  }
  assert.match(renderToStaticMarkup(<NumberInput value={1} readOnly />), /type="number"/);
  assert.match(renderToStaticMarkup(<DateInput value="" readOnly />), /type="date"/);
});

test("disabled controls are rendered disabled, not merely greyed", () => {
  assert.match(renderToStaticMarkup(<TextInput value="" readOnly disabled />), /disabled/);
  assert.match(renderToStaticMarkup(<SelectInput value="" disabled><option value="">a</option></SelectInput>), /disabled/);
});

test("selection cards keep a real, focusable checkbox", () => {
  const html = renderToStaticMarkup(<CheckCard checked onChange={() => {}} title="IBOX sales" meta="+ post-sale" />);
  assert.match(html, /type="checkbox"/, "a real checkbox, not a painted substitute");
  assert.match(html, /checked/);
  assert.match(html, /IBOX sales/);
  assert.match(html, /\+ post-sale/);
  assert.match(html, /check-card selected/);
  // The input itself must stay in the accessibility tree: only the painted
  // box is aria-hidden, and nothing is display:none or type="hidden".
  assert.doesNotMatch(html, /display:\s*none/);
  assert.doesNotMatch(html, /type="hidden"/);
  const input = html.slice(html.indexOf("<input"), html.indexOf(">", html.indexOf("<input")));
  assert.doesNotMatch(input, /aria-hidden/, "the checkbox is never hidden from assistive tech");
});

test("the checkbox is hidden by opacity, never display:none, and shows a focus ring", () => {
  const rule = css.slice(css.indexOf(".check-card-input"), css.indexOf(".check-card-body"));
  assert.doesNotMatch(rule, /display:\s*none/, "display:none would remove it from the keyboard order");
  assert.match(rule, /opacity:\s*0/);
  assert.match(css, /\.check-card-input:focus-visible \+ \.check-card-box/, "focus is visible on the card");
  assert.match(css, /button:focus-visible/, "global focus-visible styling exists");
});

// ------------------------------------------------------- view separation ---

test("sales filters belong to sales views only", () => {
  for (const view of ["dashboard", "managers", "managerDetail", "leadFlow", "quality", "stages", "deals"]) {
    assert.equal(isSalesView(view), true, view);
    assert.equal(isManagementView(view), false, view);
  }
  for (const view of ["projects", "projectDetail", "pages", "pageDetail", "settings", "diagnostics"]) {
    assert.equal(isManagementView(view), true, view);
    assert.equal(isSalesView(view), false, `${view} must not show the sales filter bar`);
  }
});

test("the filter bar and the funnel/sync controls are gated on view type", () => {
  assert.match(client, /\{isSalesView\(view\) && <FiltersBar/, "FiltersBar is rendered only for sales views");
  assert.doesNotMatch(client, /view !== "settings" && view !== "diagnostics" && <FiltersBar/, "the old catch-all gate is gone");
  const topActions = client.slice(client.indexOf('<div className="top-actions">'), client.indexOf("</header>"));
  assert.match(topActions, /\{!isManagementView\(view\) && <>/, "top actions are gated on view type");
  for (const control of ["Sinxronizatsiya funnel", "Tanlangan funnelni sinxronlash", "Oxirgi sinxronizatsiya"]) {
    assert.ok(topActions.includes(control), `${control} lives inside the gated block`);
    const gateAt = topActions.indexOf("!isManagementView(view)");
    assert.ok(topActions.indexOf(control) > gateAt, `${control} appears after the gate`);
  }
});

// ------------------------------------------------------------- settings ----

test("Settings is grouped, shows readiness, and gates Full Sync", () => {
  for (const label of ["Asosiy", "Funnel qoidalari", "Dashboard", "SLA va ish vaqti", "Data va sinxronizatsiya"]) {
    assert.ok(client.includes(`label: "${label}"`), `Settings tab present: ${label}`);
  }
  assert.match(client, /role="tablist"/);
  assert.match(client, /aria-selected=\{tab === item\.id\}/, "tabs expose selection state");
  assert.match(client, /<ReadinessBar readiness=\{readiness\} lastSyncAt=/);
  assert.match(client, /disabled=\{saving \|\| syncing \|\| blockers\.length > 0\}/, "Full Sync is gated on blockers");
  assert.match(client, /fullSyncConfirmation\(funnelName, draft\.historyDays\)/, "Full Sync confirms first");
  assert.match(client, /if \(!canFullSync\(readiness\)\) return;/, "and refuses even if the button is bypassed");
});

test("Settings save is dirty-aware and always releases its busy state", () => {
  assert.match(client, /Saqlanmagan o‘zgarishlar/, "sticky unsaved-changes bar");
  assert.match(client, /Bekor qilish/);
  assert.match(client, /const dirty = isSettingsDirty\(savedSettings, draft\)/);
  // try / catch / finally with the reset in finally.
  const save = client.slice(client.indexOf("async function save()"), client.indexOf("function resetDraft()"));
  assert.match(save, /try \{/);
  assert.match(save, /catch \(caught\)/);
  assert.match(save, /finally \{\s*setSaving\(false\);/, "busy state resets even on failure");
  assert.match(save, /setSaveError\(/, "the user sees a safe error");
  assert.match(client, /addEventListener\("beforeunload"/, "reloading warns about unsaved edits");
  assert.match(client, /saqlanmagan o‘zgarishlar bor/i, "leaving Settings warns too");
});

test("the error boundary message is generic, not Settings-specific", () => {
  assert.match(client, /Sahifani ko‘rsatishda xato yuz berdi/);
  assert.doesNotMatch(client, /Sozlamalarni ochishda xato/, "the old Settings-only wording is gone");
  const boundary = client.slice(client.indexOf("class ViewErrorBoundary"), client.indexOf("type ProjectDraft"));
  assert.doesNotMatch(boundary, /\{error\.message\}|\{String\(error\)\}/, "no error internals reach the DOM");
});

test("editor drawers use the form system rather than raw controls", () => {
  const drawers = client.slice(client.indexOf("{pageDraft && <section"), client.lastIndexOf("</section>}"));
  assert.doesNotMatch(drawers, /<label>[^<]*<input/, "no bare label+input pairs remain");
  assert.doesNotMatch(drawers, /<label>[^<]*<select/, "no bare label+select pairs remain");
  assert.doesNotMatch(drawers, /<label className="wide-field">[^<]*<textarea/, "no bare textarea pairs remain");
  for (const primitive of ["<FormField", "<TextInput", "<SelectInput", "<Textarea", "<DateInput", "<NumberInput"]) {
    assert.ok(drawers.includes(primitive), `drawers use ${primitive}`);
  }
});
