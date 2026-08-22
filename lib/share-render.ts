import { WIDGET_SOURCE_LABELS } from "./custom-pages";
import { SHARE_UNAVAILABLE_MESSAGE } from "./share-tokens";
import type { SharePayload, SharedWidget } from "./share-model";

/**
 * Server-side HTML for a shared page.
 *
 * Deliberately a string renderer rather than a React tree: route handlers run
 * in the RSC environment, where `react-dom/server` throws at runtime
 * ("react-dom/server is not supported in React Server Components"), and a page
 * component would ship the framework runtime and an RSC payload to a recipient
 * who must never boot the authenticated app. The output here is complete HTML
 * with zero JavaScript — the whole page is in the first response.
 *
 * Every interpolation goes through `esc`. Nothing reaches the document except
 * through the helpers below, so there is no path for unescaped user text.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

const tag = (name: string, className: string, content: string) =>
  `<${name}${className ? ` class="${className}"` : ""}>${content}</${name}>`;

/** Escapes its text; use this for anything a person typed. */
const t = (name: string, className: string, value: unknown) => tag(name, className, esc(value));

const STYLES = `
:root{color-scheme:light dark;--bg:#f5f7fb;--panel:#fff;--ink:#0f1729;--muted:#5b6880;--line:#e3e8f0;--accent:#246bfd;--alert:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--panel:#141b2d;--ink:#eef2f9;--muted:#9aa7bd;--line:#232c42;--alert:#fb923c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:32px 20px 64px}
header.page{margin-bottom:28px}
header.page h1{margin:0 0 6px;font-size:28px;letter-spacing:-.02em}
header.page p{margin:0 0 10px;color:var(--muted);max-width:70ch}
.meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;color:var(--muted);font-size:13px}
.chip{border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:3px 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-bottom:14px}
.card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
.card .label{color:var(--muted);font-size:13px;margin-bottom:6px}
.card .value{font-size:26px;font-weight:650;letter-spacing:-.02em}
.card .detail{color:var(--muted);font-size:12px;margin-top:6px}
.panel{margin-bottom:14px}
.panel h3{margin:0 0 12px;font-size:16px}
.section{margin:26px 0 12px;padding-top:6px;border-top:1px solid var(--line)}
.section h2{margin:0;font-size:19px;letter-spacing:-.01em}
.section p{margin:4px 0 0;color:var(--muted);font-size:13px}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.summary div span{display:block;color:var(--muted);font-size:12px}
.summary div strong{font-size:20px}
.bar{margin-bottom:10px}
.bar .bar-head{display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px}
.bar .track{height:7px;background:var(--line);border-radius:999px;overflow:hidden}
.bar .fill{height:100%;background:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
tr:last-child td{border-bottom:0}
td.alert strong{color:var(--alert)}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:12px;color:var(--muted)}
.item{border-bottom:1px solid var(--line);padding:10px 0}
.item:last-child{border-bottom:0}
.item .head{display:flex;justify-content:space-between;gap:10px;align-items:center}
.item small{color:var(--muted)}
.empty{color:var(--muted);font-size:14px;padding:10px 0}
.note{white-space:pre-wrap;margin:0}
footer{margin-top:36px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
.unavailable{max-width:520px;margin:14vh auto;text-align:center}
`.trim();

function document_(title: string, body: string) {
  return `<!doctype html>
<html lang="uz">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`;
}

const fmtStamp = (value: string) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString().replace("T", " ").slice(0, 16) : "—";
};

function renderWidget(widget: SharedWidget): string {
  switch (widget.kind) {
    case "SECTION_HEADER":
      return `<div class="section">${t("h2", "", widget.title)}${widget.subtitle ? t("p", "", widget.subtitle) : ""}</div>`;

    case "KPI":
      return `<div class="card">${t("div", "label", widget.title)}${t("div", "value", widget.value)}` +
        `${t("div", "detail", `${widget.detail} · ${WIDGET_SOURCE_LABELS[widget.source]}`)}</div>`;

    case "NOTE":
      return `<article class="panel">${t("h3", "", widget.title)}` +
        `${t("p", "note", widget.body || "Matn kiritilmagan")}</article>`;

    case "SUMMARY":
      return `<article class="panel">${t("h3", "", widget.title)}<div class="summary">` +
        widget.items.map((item) => `<div>${t("span", "", item.label)}${t("strong", "", item.value)}</div>`).join("") +
        `</div></article>`;

    case "BARS":
      return `<article class="panel">${t("h3", "", widget.title)}` +
        (widget.rows.length
          ? widget.rows.map((row) =>
            `<div class="bar"><div class="bar-head">${t("span", "", row.label)}${t("span", "", row.value)}</div>` +
            `<div class="track"><div class="fill" style="width:${clampPercent(row.percent)}%"></div></div></div>`).join("")
          : t("div", "empty", widget.empty)) +
        `</article>`;

    case "TABLE":
      return `<article class="panel">${t("h3", "", widget.title)}` +
        (widget.rows.length
          ? `<table><thead><tr>${widget.columns.map((column) => t("th", "", column)).join("")}</tr></thead><tbody>` +
            widget.rows.map((row) =>
              `<tr>${row.cells.map((cell, index) =>
                index === 0
                  ? `<td class="${row.alert ? "alert" : ""}">${t("strong", "", cell)}</td>`
                  : index === 1 ? `<td>${t("span", "pill", cell)}</td>` : t("td", "", cell)).join("")}</tr>`).join("") +
            `</tbody></table>`
          : t("div", "empty", widget.empty)) +
        `</article>`;

    case "TIMELINE":
      return `<article class="panel">${t("h3", "", widget.title)}` +
        (widget.items.length
          ? widget.items.map((item) =>
            `<div class="item"><div class="head">${t("strong", "", item.title)}${t("span", "pill", item.status)}</div>` +
            `${t("small", "", item.meta)}</div>`).join("")
          : t("div", "empty", widget.empty)) +
        `</article>`;

    default:
      return "";
  }
}

/** Only numeric width ever reaches the style attribute. */
function clampPercent(value: number) {
  const percent = Number(value);
  return Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.round(percent))) : 0;
}

/**
 * Groups consecutive KPI cards into one responsive row, so a shared page reads
 * like the in-app page rather than one card per line.
 */
function renderBody(payload: SharePayload) {
  const chunks: string[] = [];
  let cards: string[] = [];
  const flush = () => {
    if (cards.length) chunks.push(`<div class="grid">${cards.join("")}</div>`);
    cards = [];
  };
  for (const widget of payload.widgets) {
    if (widget.kind === "KPI") cards.push(renderWidget(widget));
    else { flush(); chunks.push(renderWidget(widget)); }
  }
  flush();
  return chunks.join("");
}

export function renderSharePage(payload: SharePayload): string {
  const head = `<header class="page">${t("h1", "", payload.page.name)}` +
    `${payload.page.description ? t("p", "", payload.page.description) : ""}` +
    `<div class="meta">${payload.page.audience ? t("span", "chip", payload.page.audience) : ""}` +
    `${t("span", "", `Yangilangan: ${fmtStamp(payload.page.updatedAt)}`)}</div></header>`;

  const body = payload.widgets.length
    ? renderBody(payload)
    : t("div", "empty", "Bu havolada ko‘rsatiladigan widget yo‘q.");

  const foot = `<footer>${t("span", "", `Faqat o‘qish uchun · Ko‘rsatilgan vaqt: ${fmtStamp(payload.generatedAt)}`)}</footer>`;
  return document_(payload.page.name, head + body + foot);
}

/**
 * One response for every failure mode — missing, revoked, expired, archived —
 * so a probe cannot tell whether a token ever existed.
 */
export function renderShareUnavailable(): string {
  return document_("—", `<div class="unavailable"><h1>—</h1>${t("p", "", SHARE_UNAVAILABLE_MESSAGE)}</div>`);
}
