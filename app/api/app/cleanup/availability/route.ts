import { getProductionCleanupUiState } from "@/lib/server/production-cleanup-ui";
import { observeDatabaseRoute } from "@/lib/server/database-usage";

export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  if (process.env.NODE_ENV !== "production") return new Response(null, { status: 404, headers });
  return observeDatabaseRoute("cleanup_availability", async () => {
    const { access, provider, hasJob } = await getProductionCleanupUiState();
    return Response.json({ access, provider, hasJob }, { headers });
  });
}
