import { renderShareUnavailable } from "./share-render";

/**
 * Response shaping for the public share route.
 *
 * Split out from the route handler so the privacy headers are asserted against
 * the real object the recipient receives, not against the source that builds it.
 */
export const SHARE_RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  // Bearer-token business data: never store it in a shared or browser cache.
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  // The document is self-contained, so every external origin can be denied.
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
};

export function sharePageResponse(html: string) {
  return new Response(html, { status: 200, headers: SHARE_RESPONSE_HEADERS });
}

/**
 * Missing, revoked, expired, archived, or an internal error — one
 * indistinguishable 404, so token probing reveals nothing.
 */
export function shareUnavailableResponse() {
  return new Response(renderShareUnavailable(), { status: 404, headers: SHARE_RESPONSE_HEADERS });
}
