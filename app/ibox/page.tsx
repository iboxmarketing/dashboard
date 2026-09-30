import DashboardClient from "../dashboard-client";

/** The IBOX workspace. The project is fixed by the route, so nothing else can load here. */
export default function IboxWorkspace() {
  return <DashboardClient project="IBOX" />;
}
