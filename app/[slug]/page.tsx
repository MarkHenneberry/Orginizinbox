import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Footer } from "@/components/marketing/Footer";
import { Header } from "@/components/marketing/Header";
import { GuidesHubContent } from "@/components/product/GuidesHubContent";
import { MarketingInfoContent } from "@/components/product/MarketingInfoContent";
import { PrivacyContent } from "@/components/product/PrivacyContent";
import { StructuredData } from "@/components/marketing/StructuredData";
import { getMarketingPage, marketingPages } from "@/lib/marketing-pages";
import { getPublicPrimaryCta } from "@/lib/server/app-state";

type Props = {
  params: Promise<{ slug: string }>;
};

export function generateStaticParams() {
  return marketingPages.filter((page) => page.slug !== "data-access").map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = getMarketingPage(slug);
  if (!page) return {};

  return {
    title: page.title,
    description: page.description,
    alternates: {
      canonical: `/${page.slug}`
    },
    openGraph: {
      title: `${page.title} | Organizinbox`,
      description: page.description,
      url: `/${page.slug}`
    }
  };
}

export default async function MarketingPage({ params }: Props) {
  const { slug } = await params;
  const page = getMarketingPage(slug);
  if (!page) notFound();
  const primaryCta = await getPublicPrimaryCta(page.providerIntent);

  return (
    <>
      <StructuredData />
      <Header />
      {page.slug === "guides" ? <GuidesHubContent primaryCta={primaryCta} /> : null}
      {page.slug === "privacy" ? <PrivacyContent primaryCta={primaryCta} /> : null}
      {page.slug !== "guides" && page.slug !== "privacy" ? <MarketingInfoContent page={page} primaryCta={primaryCta} /> : null}
      <Footer />
    </>
  );
}
