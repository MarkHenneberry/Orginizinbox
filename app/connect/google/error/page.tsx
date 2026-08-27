import type { Metadata } from "next";
import { Footer } from "@/components/marketing/Footer";
import { Header } from "@/components/marketing/Header";
import { ContextBackAction } from "@/components/product/ContextBackAction";
import { getSafeOAuthDevelopmentErrorCode } from "@/lib/server/oauth-callback-diagnostics";

const connectionErrors: Record<string, { heading: string; body: string }> = {
  oauth_denied: { heading: "Gmail didn't finish connecting", body: "You can try again when you're ready." },
  gmail_scope: { heading: "Gmail didn't finish connecting", body: "Try again and approve Gmail access when Google asks." },
  gmail_capability_denied: { heading: "Gmail didn't finish connecting", body: "Try again and approve Gmail access when Google asks." },
  missing_state_cookie: { heading: "We couldn't connect Gmail", body: "Please try again." },
  missing_state: { heading: "We couldn't connect Gmail", body: "Please try again." },
  state_mismatch: { heading: "We couldn't connect Gmail", body: "Please try again." },
  state_expired: { heading: "We couldn't connect Gmail", body: "Please try again." },
  state_invalid: { heading: "We couldn't connect Gmail", body: "Please try again." },
  missing_code: { heading: "We couldn't connect Gmail", body: "Please try again." },
  scope_verification_failed: { heading: "We couldn't connect Gmail", body: "Please try again." },
  token_exchange_failed: { heading: "We couldn't connect Gmail", body: "Please try again." },
  userinfo_failed: { heading: "We couldn't connect Gmail", body: "Please try again." },
  provider_connection_save_failed: { heading: "We couldn't connect Gmail", body: "Please try again." },
  session_creation_failed: { heading: "We couldn't connect Gmail", body: "Please try again." },
  callback_failed: { heading: "We couldn't connect Gmail", body: "Please try again." }
};

export const metadata: Metadata = {
  title: "Google Connection Error",
  robots: {
    index: false,
    follow: false
  }
};

export default async function GoogleOAuthErrorPage({ searchParams }: { searchParams?: Promise<{ reason?: string }> }) {
  const params = await searchParams;
  const reason = params?.reason ?? "state_invalid";
  const error = connectionErrors[reason] ?? connectionErrors.state_invalid;
  const developmentErrorCode = getSafeOAuthDevelopmentErrorCode(reason);

  return (
    <>
      <Header />
      <main className="section">
        <div className="container max-w-3xl">
          <ContextBackAction className="mb-6" href="/" label="Back to homepage" />
          <p className="eyebrow">Gmail connection</p>
          <h1 className="section-title mt-3">{error.heading}</h1>
          <p className="muted mt-5 text-lg leading-8">{error.body}</p>
          {developmentErrorCode ? (
            <p className="muted mt-4 text-sm">
              Development error: <code>{developmentErrorCode}</code>
            </p>
          ) : null}
          <div className="mt-8 flex flex-wrap gap-3">
            <form action="/api/oauth/google/start" method="get">
              <button className="btn btn-primary focus-ring" type="submit">
                Try connecting Gmail again
              </button>
            </form>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
