import { notFound } from "next/navigation";
import { KpiDetailClient } from "@/app/kpi-detail/kpi-detail-client";
import { isKpiDetailMetric } from "@/lib/kpi-detail-contract";

export default async function SalesDoctorKpiDetailPage({ params }: { params: Promise<{ metric: string }> }) {
  const { metric } = await params;
  if (!isKpiDetailMetric(metric)) notFound();
  return <KpiDetailClient project="SALES_DOCTOR" metric={metric} />;
}
