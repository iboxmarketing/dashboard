import DashboardClient from "./dashboard-client";

/**
 * The dashboard client is itself the auth gate: it renders nothing until
 * `/api/auth/me` has answered, so there is no separate auth shell to route to.
 */
export default function Home() {
  // No project on the bare route: the dashboard asks which one, after sign-in.
  return <DashboardClient />;
}
