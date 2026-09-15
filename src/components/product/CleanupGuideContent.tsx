import Link from "next/link";
import { cleanupGuides } from "@/lib/cleanup-guides";
import { RetentionDisclosure } from "@/components/product/RetentionDisclosure";

export function CleanupGuideContent({ slug }: { slug: string }) {
  const guide = cleanupGuides[slug];
  if (!guide) return null;
  const schema = {
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: guide.faqs.map(({ question, answer }) => ({
      "@type": "Question", name: question, acceptedAnswer: { "@type": "Answer", text: answer }
    }))
  };
  return (
    <>
      <section className="section bg-white">
        <div className="container max-w-3xl">
          <h2 className="text-2xl font-bold">{guide.heading}</h2>
          <ol className="mt-5 list-decimal space-y-4 pl-6 leading-7">
            {guide.steps.map((step) => <li key={step}>{step}</li>)}
          </ol>
          {guide.sections.map((section) => (
            <div className="mt-8" key={section.heading}>
              <h2 className="text-xl font-bold">{section.heading}</h2>
              <p className="muted mt-3 leading-7">{section.text}</p>
            </div>
          ))}
          <h2 className="mt-8 text-xl font-bold">Privacy and your Undo window</h2>
          <p className="muted leading-7">Organizinbox does not fetch email bodies or attachments. Subject lines are used temporarily to protect messages, then discarded. Reports and required restoration details are stored temporarily in encrypted form. Undo needs that restoration state: expiry or disconnect removes access to it. Your email provider&apos;s retention rules still apply.</p>
          <RetentionDisclosure />
          <p className="leading-7"><Link className="focus-ring underline" href="/data-access">What Organizinbox accesses</Link>{" and "}<Link className="focus-ring underline" href="/privacy">our privacy commitments</Link>.</p>
          <h2 className="mt-8 text-xl font-bold">Provider instructions</h2>
          <ul className="list-disc space-y-2 pl-6">
            {guide.sources.map((source) => <li key={source.href}><a className="focus-ring underline" href={source.href}>{source.title}</a></li>)}
          </ul>
        </div>
      </section>
      <section className="section">
        <div className="container max-w-3xl">
          <h2 className="text-2xl font-bold">Frequently asked questions</h2>
          {guide.faqs.map(({ question, answer }) => (
            <div className="border-b border-[var(--line)] py-5" key={question}>
              <h3 className="m-0 text-lg font-bold">{question}</h3>
              <p className="muted mb-0 mt-2 leading-7">{answer}</p>
            </div>
          ))}
        </div>
      </section>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, "\\u003c") }} />
    </>
  );
}
