import type { Metadata } from "next";
import { Footer } from "@/components/marketing/Footer";
import { Header } from "@/components/marketing/Header";
import { DataAccessContent } from "@/components/product/DataAccessContent";
import { getPublicPrimaryCta } from "@/lib/server/app-state";

export const metadata: Metadata = {
  title: "Data Access",
  description: "What Organizinbox temporarily processes, does not store, and deliberately does not implement for Gmail and Outlook cleanup.",
  alternates: {
    canonical: "/data-access"
  }
};

export default async function DataAccessPage() {
  const primaryCta = await getPublicPrimaryCta();

  return (
    <>
      <Header />
      <DataAccessContent primaryCta={primaryCta} />
      <Footer />
    </>
  );
}
