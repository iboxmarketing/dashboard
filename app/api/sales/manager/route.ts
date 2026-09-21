import { salesSectionResponse } from "@/lib/sales-http";

/** Guarded by the `manager` section's own permission — see lib/sales-sections.ts. */
export async function GET(request: Request) {
  return salesSectionResponse(request, "manager");
}
