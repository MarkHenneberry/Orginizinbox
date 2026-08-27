import { NextResponse } from "next/server";
import { disconnectCurrentGmailSession } from "@/lib/server/disconnect";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: {
      Allow: "POST",
      "Cache-Control": "no-store, max-age=0"
    }
  });
}

export async function POST(request: Request) {
  if (!isSameOriginPost(request)) {
    return new Response("Forbidden", {
      status: 403,
      headers: {
        "Cache-Control": "no-store, max-age=0"
      }
    });
  }

  await disconnectCurrentGmailSession();
  const response = NextResponse.redirect(new URL("/", request.url), { status: 303 });
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

function isSameOriginPost(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
