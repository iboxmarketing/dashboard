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
  // Sprint 24 moved the project/update editors into <Drawer>, which renders
  // after the last page/widget </section>}, so the slice runs to the footer.
  // Sprint 25 moved the page/widget/template/share editors into <Drawer> too,
  // so the region is every drawer from the first one to the footer.
  const drawers = client.slice(client.indexOf("<Drawer open="), client.indexOf("<footer><span>Bitrix24"));
  assert.doesNotMatch(drawers, /<label>[^<]*<input/, "no bare label+input pairs remain");
  assert.doesNotMatch(drawers, /<label>[^<]*<select/, "no bare label+select pairs remain");
  assert.doesNotMatch(drawers, /<label className="wide-field">[^<]*<textarea/, "no bare textarea pairs remain");
  for (const primitive of ["<FormField", "<TextInput", "<SelectInput", "<Textarea", "<DateInput", "<NumberInput"]) {
    assert.ok(drawers.includes(primitive), `drawers use ${primitive}`);
  }
});

// ------------------------------------------------ settings visual layout ---

/**
 * Sprint 23.3 — visual acceptance found Settings unusable in three places.
 *
 * The cause was legacy chip CSS that still matched the new CheckCard markup,
 * because CheckCard renders a <label>. One of those rules was
 * `input { display: none }`, which silently re-hid the real checkbox and undid
 * the Sprint 23 keyboard fix — the reason these tests assert against the
 * *container* rules, not just the component's own.
 */

/** Extracts one CSS rule body by exact selector. */
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  return at === -1 ? "" : css.slice(at, css.indexOf("}", at) + 1);
};

test("no container rule re-hides a selection checkbox", () => {
  for (const container of [".pipeline-options", ".sql-stage-options", ".metric-options", ".share-widget-list", ".check-card"]) {
    for (const suffix of ["input", "> label", "label"]) {
      const body = rule(`${container} ${suffix}`);
      assert.doesNotMatch(body, /display:\s*none/,
        `${container} ${suffix} must not hide the checkbox — that removes it from the keyboard order`);
    }
  }
  // The only hiding is the opacity technique on the real input.
  assert.match(rule(".check-card-input"), /opacity:\s*0/);
});

test("selection cards are laid out on a grid wide enough to read", () => {
  const widths: Record<string, number> = { ".pipeline-options": 280, ".sql-stage-options": 180, ".metric-options": 170 };
  for (const [selector, min] of Object.entries(widths)) {
    const body = rule(selector);
    assert.match(body, /display:\s*grid/, `${selector} is a grid, not a shrink-to-fit flex row`);
    const match = body.match(/minmax\(min\((\d+)px,\s*100%\)/);
    assert.ok(match, `${selector} uses minmax(min(Npx, 100%), 1fr) so it cannot overflow a narrow viewport`);
    assert.equal(Number(match[1]), min, `${selector} minimum track is ${min}px`);
  }
});

test("labels are readable, not 8-9px, and are never truncated to ellipsis", () => {
  const strong = rule(".check-card-body strong");
  const small = rule(".check-card-body small");
  const size = (body: string) => Number((body.match(/font-size:\s*([\d.]+)px/) ?? [])[1]);
  assert.ok(size(strong) >= 12 && size(strong) <= 13, `primary label 12-13px, got ${size(strong)}`);
  assert.ok(size(small) >= 10 && size(small) <= 11, `secondary text 10-11px, got ${size(small)}`);

  // No rule may clip a selection label to an ellipsis.
  for (const selector of [".check-card", ".check-card-body", ".check-card-body strong"]) {
    assert.doesNotMatch(rule(selector), /text-overflow:\s*ellipsis|white-space:\s*nowrap/,
      `${selector} must not truncate the label`);
  }
  // break-word wraps at word boundaries; break-all would wrap per character.
  assert.match(strong, /overflow-wrap:\s*break-word/);
  assert.doesNotMatch(strong, /word-break:\s*break-all/);
});

test("the text column can shrink, so content flows horizontally", () => {
  const body = rule(".check-card-body");
  assert.match(body, /min-width:\s*0/, "without min-width:0 a flex child wraps one word per line");
  assert.match(body, /flex:\s*1 1 auto/);
});

test("stage options render the stage name with its id underneath", () => {
  const picker = client.slice(client.indexOf("function StagePicker"), client.indexOf("const SETTINGS_TABS"));
  assert.match(picker, /title=\{stage\.name\}/, "the full stage name, not a truncation");
  assert.match(picker, /meta=\{stage\.id\}/, "stage id shown as secondary text");

  const html = renderToStaticMarkup(<CheckCard checked onChange={() => {}} title="ОБРАБОТКА" meta="C3:UC_9SUEMM" />);
  assert.match(html, /ОБРАБОТКА/);
  assert.match(html, /C3:UC_9SUEMM/);
  assert.doesNotMatch(html, /ОБ\.\.\./, "never an abbreviated label");
});

test("dashboard metrics render full labels on their own grid", () => {
  // Selected metrics are now an ordered list; the unselected ones keep the
  // wider metric grid rather than the stage chip container.
  const picker = client.slice(client.indexOf("function DashboardMetricOrder"), client.indexOf("function SettingsView"));
  assert.match(picker, /<ol className="metric-order"/, "selected metrics render as an ordered list");
  assert.match(picker, /<div className="metric-options">\{available\.map/, "unselected metrics keep the wider grid");
  // Every canonical label must be renderable in full — no abbreviation step.
  // Labels now come from headlineCardLabel, which falls back to the registry
  // label for every card that does not rename itself.
  assert.match(picker, /title=\{headlineCardLabel\(id\)\}/, "the full card label is passed through");
  assert.match(picker, /\{label\(id\)\}/, "selected rows show the full label");
  assert.doesNotMatch(picker, /slice\(0,|substring\(|truncate/, "no label shortening");
});

test("the project card shows name, paired funnel and ids as separate lines", () => {
  const html = renderToStaticMarkup(
    <CheckCard checked onChange={() => {}} title="IBOX sales"
      meta="+ IBOX Обучение/Сопровождение" hint="Sales ID: 3 · Post-sale ID: 13" />);
  assert.match(html, /IBOX sales/);
  assert.match(html, /IBOX Обучение\/Сопровождение/);
  assert.match(html, /Sales ID: 3 · Post-sale ID: 13/);
  // Long secondary names wrap to at most two lines rather than pushing the card.
  assert.match(rule(".pipeline-options .check-card-body small:first-of-type"), /-webkit-line-clamp:\s*2/);
});

test("every selection grid collapses safely on a 390px viewport", () => {
  // min(Npx, 100%) means the track can never exceed the container, so a phone
  // gets one full-width column instead of a horizontally scrolling page.
  for (const selector of [".pipeline-options", ".sql-stage-options", ".metric-options"]) {
    assert.match(rule(selector), /minmax\(min\(\d+px,\s*100%\),\s*1fr\)/, `${selector} is overflow-safe`);
  }
  // The wider Settings grids still collapse at the existing breakpoint.
  const mobile = css.slice(css.indexOf("@media (max-width: 860px)"), css.indexOf("@media (max-width: 560px)"));
  for (const selector of [".config-fields", ".settings-grid", ".scoped-sync-grid"]) {
    assert.ok(mobile.includes(selector), `${selector} collapses to one column on mobile`);
  }
});
