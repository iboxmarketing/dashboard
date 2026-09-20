"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { AuthErrorState, AuthLoadingScreen, NoSectionsState } from "./auth-primitives";
import { ChangePasswordScreen } from "./change-password-screen";
import { LoginScreen } from "./login-screen";
import { AuthError, createAuthAdapter, type AuthAdapter } from "@/lib/auth-adapter";
import { hasAnySection } from "@/lib/auth-permissions";
import type { AuthState, AuthUser, ChangePasswordRequest, LoginRequest } from "@/lib/auth-types";

export type AuthSession = {
  user: AuthUser;
  adapter: AuthAdapter;
  logout: () => void;
  changePassword: () => void;
  /** Re-read `/api/auth/me`, e.g. after an admin edits their own account. */
  refresh: () => void;
};

/**
 * Signing in against sample users would be a security incident, so a fixture
 * adapter is a hard failure in a production build rather than a silent
 * substitution. Fixtures are only ever reached by passing one explicitly.
 */
function assertAdapterAllowed(adapter: AuthAdapter) {
  if (adapter.source === "fixtures" && process.env.NODE_ENV === "production") {
    throw new Error("Auth fixtures are not usable in a production build.");
  }
}

/**
 * Startup gate.
 *
 * `GET /api/auth/me` decides everything before any section renders: the shell
 * stays in `loading` until the answer arrives, so restricted navigation is never
 * briefly visible to someone who may not open it.
 */
export function useAuth(adapter: AuthAdapter) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [fatal, setFatal] = useState<string | null>(null);
  const [voluntaryPassword, setVoluntaryPassword] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    let cancelled = false;
    // The whole read is awaited before touching state: writing state
    // synchronously inside an effect cascades renders.
    const start = async () => {
      try {
        const user = await adapter.me();
        if (cancelled) return;
        setFatal(null);
        setState(user
          ? user.mustChangePassword ? { status: "mustChangePassword", user } : { status: "authenticated", user }
          : { status: "unauthenticated", error: null });
      } catch (caught) {
        if (cancelled) return;
        // A server or network failure is not "signed out" — saying so would send
        // the user to a login form that cannot possibly work.
        setFatal(caught instanceof AuthError ? caught.message : "Sessiyani tekshirib bo‘lmadi.");
      }
    };
    void start();
    return () => { cancelled = true; };
  }, [adapter, reloadToken]);

  const settle = useCallback((user: AuthUser) => {
    if (!mounted.current) return;
    setVoluntaryPassword(false);
    setState(user.mustChangePassword ? { status: "mustChangePassword", user } : { status: "authenticated", user });
  }, []);

  const login = useCallback(async (body: LoginRequest) => { settle(await adapter.login(body)); }, [adapter, settle]);

  const changePassword = useCallback(async (body: ChangePasswordRequest) => {
    const user = await adapter.changePassword(body);
    // The backend clears the flag; defend against a response that forgets to, so
    // a successful change can never leave the user stuck on the gate.
    settle({ ...user, mustChangePassword: false });
  }, [adapter, settle]);

  const logout = useCallback(async () => {
    try { await adapter.logout(); } finally {
      if (mounted.current) { setVoluntaryPassword(false); setState({ status: "unauthenticated", error: null }); }
    }
  }, [adapter]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  return { state, fatal, login, logout, changePassword, refresh, voluntaryPassword, setVoluntaryPassword };
}

export function AuthGate({ adapter, children }: {
  adapter?: AuthAdapter;
  children: (session: AuthSession) => ReactNode;
}) {
  const resolved = useMemo(() => adapter ?? createAuthAdapter(), [adapter]);
  assertAdapterAllowed(resolved);
  const auth = useAuth(resolved);
  const { state, fatal, voluntaryPassword, setVoluntaryPassword } = auth;

  if (fatal) return <div className="auth-screen"><AuthErrorState message={fatal} onRetry={auth.refresh} /></div>;
  if (state.status === "loading") return <AuthLoadingScreen />;
  if (state.status === "unauthenticated") {
    return <div className="auth-screen"><LoginScreen onLogin={auth.login} initialError={state.error} /></div>;
  }
  if (state.status === "mustChangePassword") {
    return (
      <div className="auth-screen">
        <ChangePasswordScreen blocking email={state.user.email} onSubmit={auth.changePassword} />
        <button type="button" className="auth-screen-exit" onClick={() => void auth.logout()}>Chiqish</button>
      </div>
    );
  }
  if (voluntaryPassword) {
    return (
      <div className="auth-screen">
        <ChangePasswordScreen blocking={false} email={state.user.email}
          onSubmit={auth.changePassword} onCancel={() => setVoluntaryPassword(false)} />
      </div>
    );
  }
  // An account with no sections is a configuration mistake, not a blank
  // dashboard: say so instead of rendering an empty shell.
  if (!hasAnySection(state.user)) {
    return <div className="auth-screen"><NoSectionsState email={state.user.email} /><button type="button" className="auth-screen-exit" onClick={() => void auth.logout()}>Chiqish</button></div>;
  }

  return <>{children({
    user: state.user,
    adapter: resolved,
    logout: () => void auth.logout(),
    changePassword: () => setVoluntaryPassword(true),
    refresh: auth.refresh,
  })}</>;
}
