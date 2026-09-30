import DashboardClient from "../dashboard-client";

/** The Sales Doctor workspace. The project is fixed by the route, so IBOX can never load here. */
export default function SalesDoctorWorkspace() {
  return <DashboardClient project="SALES_DOCTOR" />;
}
