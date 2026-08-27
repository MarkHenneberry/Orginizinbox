import { createFullResetCheckoutSession } from "@/lib/billing/stripe";

export async function POST() {
  const result = await createFullResetCheckoutSession();
  if (!result.ok) {
    return Response.json({ error: result.reason }, { status: 503 });
  }
}
