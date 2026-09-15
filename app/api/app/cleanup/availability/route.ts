import { getProductionCleanupUiState } from "@/lib/server/production-cleanup-ui";

export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  if (process.env.NODE_ENV !== "production") return new Response(null, { status: 404, headers });
  const { access, provider, hasJob } = await getProductionCleanupUiState();
  return Response.json({ access, provider, hasJob }, { headers });
}
