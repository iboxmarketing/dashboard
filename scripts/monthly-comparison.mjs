#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CERTIFICATION_TIMEZONE,
  buildCertificationReport,
  readCertificationInput,
} from "./validate-data-certification.mjs";

export const MONTHS = Object.freeze([
  { id: "2026-08", label: "August 2026", from: "2026-08-01", to: "2026-08-31" },
  { id: "2026-09", label: "September 2026", from: "2026-09-01", to: "2026-09-30" },
]);

export function buildMonthlyComparison(records, inputIssues = []) {
  const months = MONTHS.map((month) => {
    const certification = buildCertificationReport(records, {
      range: { from: month.from, to: month.to },
      inputIssues,
      reference: false,
    });
    const value = certification.metrics.values;
    return {
      ...month,
      timezone: CERTIFICATION_TIMEZONE,
      lead: value.lead,
      sql: value.sql,
      notRelevant: value.notRelevant,
      salesLost: value.salesLost,
      cohortSales: value.cohortSales,
      periodSales: value.periodSales,
      revenue: value.periodRevenue,
      currency: value.periodCurrency,
      leadToSql: value.leadToSql,
      sqlToSale: value.sqlToSale,
      leadToSale: value.leadToSale,
      certificationStatus: certification.certificationStatus,
      failedInvariants: certification.invariants.filter((check) => check.status === "FAIL").map((check) => check.id),
    };
  });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    timezone: CERTIFICATION_TIMEZONE,
    revenueDefinition: "Period Sales SUM(OPPORTUNITY)",
    months,
  };
}

function money(value, currency) {
  return value === null ? "BLOCKED" : `${value.toLocaleString("en-US")} ${currency ?? ""}`.trim();
}

export function renderMonthlyComparison(report) {
  const header = ["Metric", ...report.months.map((month) => month.label)];
  const rows = [
    ["Lead", ...report.months.map((month) => month.lead)],
    ["SQL", ...report.months.map((month) => month.sql)],
    ["Not Relevant", ...report.months.map((month) => month.notRelevant)],
    ["Sales Lost", ...report.months.map((month) => month.salesLost)],
    ["Cohort Sales", ...report.months.map((month) => month.cohortSales)],
    ["Period Sales", ...report.months.map((month) => month.periodSales)],
    ["Revenue (Period Sales)", ...report.months.map((month) => money(month.revenue, month.currency))],
    ["Lead -> SQL", ...report.months.map((month) => `${month.leadToSql}%`)],
    ["SQL -> Sale", ...report.months.map((month) => `${month.sqlToSale}%`)],
    ["Lead -> Sale", ...report.months.map((month) => `${month.leadToSale}%`)],
    ["Invariant status", ...report.months.map((month) => month.certificationStatus)],
  ];
  const widths = header.map((cell, index) => Math.max(String(cell).length, ...rows.map((row) => String(row[index]).length)));
  const line = (row) => row.map((cell, index) => String(cell).padEnd(widths[index])).join(" | ");
  return `${line(header)}\n${widths.map((width) => "-".repeat(width)).join("-+-")}\n${rows.map(line).join("\n")}\n`;
}

function usage() {
  return "Usage: node scripts/monthly-comparison.mjs --input <file|-> [--format text|json] [--output-dir <dir>]\n";
}

export function parseArgs(argv) {
  const options = { format: "text" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") options.input = argv[++index];
    else if (arg === "--format") options.format = argv[++index];
    else if (arg === "--output-dir") options.outputDir = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.help && !options.input) throw new Error("--input is required");
  if (!["text", "json"].includes(options.format)) throw new Error("--format must be text or json");
  return options;
}

async function writeReport(outputDir, report, textReport) {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(resolve(outputDir, "monthly-comparison.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }),
    writeFile(resolve(outputDir, "monthly-comparison.txt"), textReport, { mode: 0o600 }),
  ]);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }
  const input = await readCertificationInput(options.input);
  const report = buildMonthlyComparison(input.records, input.issues);
  const textReport = renderMonthlyComparison(report);
  if (options.outputDir) await writeReport(options.outputDir, report, textReport);
  process.stdout.write(options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : textReport);
  return report.months.some((month) => month.certificationStatus === "FAIL") ? 1 : 0;
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`Monthly comparison failed: ${String(error?.message ?? error).replace(/\s+/g, " ")}\n`);
    process.exitCode = 2;
  });
}
