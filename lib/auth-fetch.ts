/**
 * The one authenticated request path in the browser.
 *
 * Every call the signed-in app makes — Sales sections, Finance, Projects,
 * Pages, Settings, Stage Control, Users — goes through `authFetch`. It changes
 * exactly one thing about `fetch`: a 401 means the session is gone (expired,
 * revoked, the account deactivated), so it tells the auth shell once, and the
 * shell unmounts the restricted app and shows the login screen.
 *
 * Only 401 does that. A 403 is a permission answer for one section and is left
 * to the caller, which shows the forbidden state — signing someone out for
 * opening a section they lack would be wrong. A 5xx or a network failure is an
 * error, never a sign-out.
 *
 * No loop is possible: the shell reacts by setting its signed-out state
 * directly, and the login screen talks to `/api/auth/login` through the auth
 * adapter's own transport, which never reports here.
 */

type Listener = () => void;
const listeners = new Set<Listener>();
let lost = false;

/** The auth shell subscribes; returns the unsubscribe. */
export function onSessionLost(listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Called for a 401. Fires listeners once per signed-in period, not per request. */
export function reportSessionLost() {
  if (lost) return;
  lost = true;
  for (const listener of [...listeners]) listener();
}

/** Called when a session is (re-)established, re-arming the notification. */
export function resetSessionLost() { lost = false; }

export class SessionLostError extends Error {
  constructor() { super("Sessiya tugadi. Qaytadan kiring."); this.name = "SessionLostError"; }
}

/**
 * `fetch` for authenticated calls. Resolves with the response for every status
 * except 401, where it reports the lost session and rejects, so no caller ever
 * renders a "not signed in" body as data.
 */
export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(input, { credentials: "same-origin", ...init });
  if (response.status === 401) {
    reportSessionLost();
    throw new SessionLostError();
  }
  return response;
}
