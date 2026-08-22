import { getD1 } from "@/db";
import { ensurePageSchema } from "./custom-pages-storage";
import * as store from "./share-store";
import type { ShareDb } from "./share-store";

/**
 * D1 wiring for share links. All logic lives in `share-store`; this module only
 * supplies the binding and guarantees the parent Custom Page tables exist
 * before the share tables reference them.
 */
async function db(): Promise<ShareDb> {
  await ensurePageSchema();
  return getD1() as unknown as ShareDb;
}

export type { ResolvedShare } from "./share-store";

export const listShares = async () => store.listShares(await db());
export const getShare = async (id: string) => store.getShare(await db(), id);
export const revokeShare = async (id: string) => store.revokeShare(await db(), id);
export const touchShareAccess = async (shareId: string) => store.touchShareAccess(await db(), shareId);
export const deleteSharesForPage = async (pageId: string) => store.deleteSharesForPage(await db(), pageId);
export const deleteShareWidgetLinks = async (widgetId: string) => store.deleteShareWidgetLinks(await db(), widgetId);

export const createShare = async (input: { pageId: string; label: string; expiresAt: string | null; widgetIds: string[] }) =>
  store.createShare(await db(), input);

export const updateShare = async (id: string, input: { label: string; expiresAt: string | null; widgetIds: string[] }) =>
  store.updateShare(await db(), id, input);

export const resolveShareByToken = async (rawToken: string, now?: Date) =>
  store.resolveShareByToken(await db(), rawToken, now);
