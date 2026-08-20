import type { PipelineOption } from "./types";

export function normalizePipelineName(name: string) {
  return name.trim().toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, " ").trim();
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
