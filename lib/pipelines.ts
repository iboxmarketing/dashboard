import type { PipelineOption } from "./types";

export function normalizePipelineName(name: string) {
  return name.normalize("NFKD").trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function resolvePipelineSelection(options: PipelineOption[], selectedIds: string[], selectedNames: string[]) {
  const byId = new Map(options.map((option) => [option.id, option]));
  const byName = new Map(options.map((option) => [normalizePipelineName(option.name), option]));
  const fromIds = selectedIds.map((id) => byId.get(String(id))).filter((item): item is PipelineOption => Boolean(item));
  const desiredNames = selectedNames.length ? selectedNames : ["IBOX Sales", "SD Sales"];
  const fromNames = desiredNames.map((name) => byName.get(normalizePipelineName(name))).filter((item): item is PipelineOption => Boolean(item));
  const unique = [...new Map((fromIds.length ? fromIds : fromNames).map((item) => [item.id, item])).values()];
  if (unique.length !== 2) {
    const available = options.map((option) => option.name).join(", ");
    throw new Error(`IBOX Sales va SD Sales pipeline’lari aniq topilmadi. Bitrix’dagi mavjud nomlar: ${available || "topilmadi"}`);
  }
  return unique;
}

function brand(name: string) {
  const normalized = normalizePipelineName(name);
  if (/\bibox\b/.test(normalized)) return "ibox";
  if (/\bsd\b/.test(normalized)) return "sd";
  return null;
}

export function resolvePostSalePipelines(options: PipelineOption[], selectedIds: string[], selectedNames: string[]) {
  const byId = new Map(options.map((option) => [option.id, option]));
  const explicit = selectedIds.map((id) => byId.get(String(id))).filter((item): item is PipelineOption => Boolean(item));
  if (explicit.length === 2) return explicit;
  const desired = selectedNames.map(normalizePipelineName);
  const postSaleWords = /обуч|сопров|obuch|training|support|onboard/;
  const candidates = options.filter((option) => postSaleWords.test(normalizePipelineName(option.name)));
  const matches = ["ibox", "sd"].flatMap((brandName) => {
    const exact = candidates.find((option) => brand(option.name) === brandName && desired.some((name) => name.includes(brandName) && (name === normalizePipelineName(option.name) || postSaleWords.test(name))));
    return exact ? [exact] : candidates.filter((option) => brand(option.name) === brandName).slice(0, 1);
  });
  return [...new Map(matches.map((item) => [item.id, item])).values()];
}
