import { billingAction } from "@/lib/billing/http";

export const runtime = "nodejs";
export function POST(request: Request) { return billingAction(request, "portal"); }
