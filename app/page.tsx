import DashboardClient from "./dashboard-client";

/**
 * The dashboard client is itself the auth gate: it renders nothing until
 * `/api/auth/me` has answered, so there is no separate auth shell to route to.
 */
export default function Home() {
  return <DashboardClient />;
}
