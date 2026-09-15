import { billingAction } from "@/lib/billing/http";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  return billingAction(request, "reconcile");
}
