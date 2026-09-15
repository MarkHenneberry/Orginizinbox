import { BillingError, requireBillingConfig } from "@/lib/billing/config";
import { createStripeClient } from "@/lib/billing/stripe";
import { StripeBillingService } from "@/lib/billing/service";
import { prisma } from "@/lib/server/db";
import { billingOperation } from "@/lib/billing/operations";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const config = requireBillingConfig();
    const signature = request.headers.get("stripe-signature");
    if (!signature) {
      billingOperation("webhook_signature_failed");
      return Response.json({ error: "Invalid webhook signature." }, { status: 400, headers });
    }
    if (Number(request.headers.get("content-length") ?? 0) > 1_000_000) {
      billingOperation("webhook_processing_failed");
      return new Response(null, { status: 413 });
    }
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1_000_000) {
          billingOperation("webhook_processing_failed");
          await reader.cancel();
          return new Response(null, { status: 413 });
        }
        chunks.push(chunk.value);
      }
    }
    const body = Buffer.concat(chunks);
    const stripe = createStripeClient();
    let event;
    try { event = stripe.webhooks.constructEvent(body, signature, config.webhookSecret); }
    catch {
      billingOperation("webhook_signature_failed");
      return Response.json({ error: "Invalid webhook signature." }, { status: 400, headers });
    }
    const result = await new StripeBillingService(prisma, stripe, config).webhook(event);
    return Response.json(result, { headers });
  } catch (error) {
    billingOperation("webhook_processing_failed");
    return Response.json({ error: "Webhook processing could not complete." }, {
      status: error instanceof BillingError && error.status === 400 ? 400 : 503, headers
    });
  }
}
