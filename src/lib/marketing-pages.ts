export type MarketingPage = {
  slug: string;
  title: string;
  description: string;
  h1: string;
  eyebrow: string;
  body: string;
  bullets: string[];
  cta: string;
  providerIntent: "gmail" | "outlook" | "generic";
  contentCluster: "provider" | "cleanup" | "storage" | "trust" | "company" | "guides" | "commercial";
  relatedSlugs: string[];
  priority: number;
};

export const marketingPages: MarketingPage[] = [
  {
    slug: "gmail-cleaner",
    title: "Gmail Cleaner",
    description: "Find the Gmail senders, Promotions, Social updates, and old unread mail creating inbox clutter.",
    h1: "Gmail cleaner for large, messy inboxes.",
    eyebrow: "Gmail",
    body: "Organizinbox finds the senders, Promotions, Social updates, and old email taking over your Gmail inbox. You review the recommendations before anything moves to Trash.",
    bullets: ["See your biggest recurring senders", "Find old and unread clutter", "Move only approved email to Gmail Trash"],
    cta: "Clean my inbox",
    providerIntent: "gmail",
    contentCluster: "provider",
    relatedSlugs: ["delete-old-emails", "delete-emails-by-sender", "delete-newsletters", "free-up-gmail-storage", "inbox-reset"],
    priority: 0.9
  },
  {
    slug: "outlook-cleaner",
    title: "Outlook Cleaner",
    description: "Diagnose clutter in Outlook.com, Hotmail, and supported Microsoft 365 inboxes before cleanup.",
    h1: "Outlook cleaner that shows the clutter first.",
    eyebrow: "Outlook",
    body: "Outlook Sweep and rules help when you already know what to remove. Organizinbox will show the recurring senders and old mail causing the clutter first.",
    bullets: ["Outlook support is coming soon", "Designed for Outlook.com, Hotmail, and Microsoft 365", "Approved email will move to Deleted Items"],
    cta: "Explore cleanup guides",
    providerIntent: "outlook",
    contentCluster: "provider",
    relatedSlugs: ["free-up-outlook-storage", "guides", "bulk-delete-emails"],
    priority: 0.9
  },
  {
    slug: "pricing",
    title: "Pricing",
    description: "Free Inbox Scan, then a one-time Full Inbox Reset cleanup option.",
    h1: "Start with a free Inbox Scan.",
    eyebrow: "Pricing",
    body: "Start with a free Inbox Scan. See the senders and old email filling your inbox before you decide what to clean.",
    bullets: ["Free Inbox Report", "Sender and old-mail analysis", "Clear pricing before any paid cleanup"],
    cta: "Clean my inbox",
    providerIntent: "generic",
    contentCluster: "commercial",
    relatedSlugs: ["gmail-cleaner", "security", "data-access"],
    priority: 0.8
  },
  {
    slug: "security",
    title: "Security",
    description: "How Organizinbox protects inbox access, cleanup actions, and temporary scan data.",
    h1: "Your connection and cleanup stay protected.",
    eyebrow: "Security",
    body: "Connection credentials are encrypted. Cleanup requires your review and confirmation. Disconnect destroys Organizinbox's saved credentials and clears the current report; removing the Google Account authorization is a separate action.",
    bullets: ["Encrypted connection credentials", "Explicit confirmation before cleanup", "Separate Google authorization removal"],
    cta: "Review data access",
    providerIntent: "generic",
    contentCluster: "trust",
    relatedSlugs: ["data-access", "privacy", "gmail-cleaner"],
    priority: 0.8
  },
  {
    slug: "data-access",
    title: "Data Access",
    description: "Exact disclosure of what Organizinbox retrieves, stores, and avoids during normal Gmail and Outlook scans.",
    h1: "What Organizinbox accesses.",
    eyebrow: "Data access",
    body: "Organizinbox uses basic details such as sender, date, read status, labels, flags, and size when available. Subject lines are processed temporarily only to protect messages that may be important. They are not stored.",
    bullets: ["Email bodies are not retrieved during normal scans", "Attachments are not downloaded", "Subject lines are not sold, used for ads, analytics, or AI training"],
    cta: "Clean my inbox",
    providerIntent: "generic",
    contentCluster: "trust",
    relatedSlugs: ["security", "privacy", "gmail-cleaner"],
    priority: 0.8
  },
  {
    slug: "privacy",
    title: "Privacy",
    description: "Organizinbox privacy commitments for inbox metadata, analytics, AI, and disconnect behavior.",
    h1: "Privacy is part of the product.",
    eyebrow: "Privacy",
    body: "Organizinbox does not sell inbox data, build advertising profiles, or use mailbox data to train AI. Normal scans do not retrieve email bodies or attachments. Subject lines are processed temporarily for protection and are not stored.",
    bullets: ["We do not store your inbox", "No third-party analytics events with mailbox metadata", "You pay us. Your inbox doesn't."],
    cta: "Clean my inbox",
    providerIntent: "generic",
    contentCluster: "trust",
    relatedSlugs: ["data-access", "security", "about"],
    priority: 0.8
  },
  {
    slug: "about",
    title: "About",
    description: "Organizinbox helps people diagnose and clean years of accumulated Gmail and Outlook clutter.",
    h1: "Built for the inbox you avoided for years.",
    eyebrow: "About",
    body: "Organizinbox is an inbox cleanup tool for people with thousands of messages and no clear place to begin. It shows the clutter first and leaves uncertain email alone.",
    bullets: ["See the clutter first", "Review every cleanup group", "Leave uncertain email alone"],
    cta: "Clean my inbox",
    providerIntent: "generic",
    contentCluster: "company",
    relatedSlugs: ["gmail-cleaner", "guides", "security"],
    priority: 0.7
  },
  {
    slug: "bulk-delete-emails",
    title: "Bulk Delete Emails Safely",
    description: "Review groups before moving thousands of unwanted emails to Trash or Deleted Items.",
    h1: "Bulk delete emails without guessing.",
    eyebrow: "Bulk cleanup",
    body: "Native search can remove large sets, but it asks you to know what to search for. Organizinbox finds likely clutter and keeps recent or important messages out of cleanup recommendations.",
    bullets: ["Review cleanup groups first", "Protected mail stays out of selections", "Cleanup means Trash or Deleted Items"],
    cta: "Clean my inbox",
    providerIntent: "generic",
    contentCluster: "cleanup",
    relatedSlugs: ["delete-old-emails", "delete-emails-by-sender", "delete-newsletters", "inbox-reset"],
    priority: 0.8
  },
  {
    slug: "delete-emails-by-sender",
    title: "Delete Emails by Sender",
    description: "Find who sends the most email and review safe sender-based cleanup groups.",
    h1: "Find who's filling your inbox.",
    eyebrow: "Sender cleanup",
    body: "The fastest path through a messy inbox is often sender-first. Organizinbox ranks recurring senders by volume, unread rate, age, and safety signals.",
    bullets: ["Biggest sender ranking", "Unread and old-mail analysis", "Sender detail explanations"],
    cta: "Clean my inbox",
    providerIntent: "generic",
    contentCluster: "cleanup",
    relatedSlugs: ["delete-old-emails", "bulk-delete-emails", "delete-newsletters", "gmail-cleaner"],
    priority: 0.9
  },
  {
    slug: "delete-old-emails",
    title: "Delete Old Emails",
    description: "Find old unread and recurring email without automatically selecting recent messages.",
    h1: "Clean old email with recent mail protected.",
    eyebrow: "Old mail",
    body: "Default cleanup recommendations protect the last 30 days so recent mail is not automatically swept into large historical cleanup groups.",
    bullets: ["Old unread analysis", "30-day recent protection by default", "Age and sender explanations"],
    cta: "Clean my inbox",
    providerIntent: "generic",
    contentCluster: "cleanup",
    relatedSlugs: ["bulk-delete-emails", "delete-emails-by-sender", "delete-newsletters", "inbox-reset"],
    priority: 0.8
  },
  {
    slug: "delete-newsletters",
    title: "Delete Newsletters",
    description: "Find newsletter backlogs and review safe cleanup groups.",
    h1: "Find newsletter backlogs that grew quietly.",
    eyebrow: "Newsletters",
    body: "Organizinbox uses mailing-list signs, age, read status, and volume to find newsletter groups you may want to clean.",
    bullets: ["Mailing-list signals", "Unread backlog counts", "Protected messages excluded"],
    cta: "Clean my inbox",
    providerIntent: "generic",
    contentCluster: "cleanup",
    relatedSlugs: ["bulk-delete-emails", "delete-old-emails", "gmail-cleaner"],
    priority: 0.75
  },
  {
    slug: "free-up-gmail-storage",
    title: "Free Up Gmail Storage",
    description: "Find Gmail clutter and estimated storage recovery without reading bodies or attachments.",
    h1: "Find what's pressuring Gmail storage.",
    eyebrow: "Gmail storage",
    body: "Organizinbox uses available message-size details to estimate where storage is going. Exact recovery depends on the data Gmail provides.",
    bullets: ["Sender and category storage estimates", "Old promotions and notification groups", "Gmail Trash-first cleanup"],
    cta: "Clean my inbox",
    providerIntent: "gmail",
    contentCluster: "storage",
    relatedSlugs: ["gmail-cleaner", "delete-old-emails", "bulk-delete-emails"],
    priority: 0.85
  },
  {
    slug: "free-up-outlook-storage",
    title: "Free Up Outlook Storage",
    description: "Identify Outlook mailbox clutter and review storage-heavy cleanup groups.",
    h1: "Understand why your Outlook mailbox is full.",
    eyebrow: "Outlook storage",
    body: "Organizinbox will help Outlook.com, Hotmail, and Microsoft 365 users find storage-heavy clutter before moving approved email to Deleted Items.",
    bullets: ["Outlook support is coming soon", "Storage-heavy sender groups", "Approved email moves to Deleted Items"],
    cta: "Explore cleanup guides",
    providerIntent: "outlook",
    contentCluster: "storage",
    relatedSlugs: ["outlook-cleaner", "guides", "bulk-delete-emails"],
    priority: 0.85
  },
  {
    slug: "inbox-reset",
    title: "Inbox Reset",
    description: "A diagnosis-first inbox cleanup workflow: connect, scan, review, clean, disconnect.",
    h1: "Reset a neglected inbox deliberately.",
    eyebrow: "Inbox Reset",
    body: "Connect Gmail, scan your inbox, review the recommendations, and move unwanted email to Trash. Disconnect whenever you're finished.",
    bullets: ["Discovery first", "Review before cleanup", "Disconnect when finished"],
    cta: "Clean my inbox",
    providerIntent: "generic",
    contentCluster: "cleanup",
    relatedSlugs: ["gmail-cleaner", "delete-old-emails", "bulk-delete-emails", "security"],
    priority: 0.8
  },
  {
    slug: "guides",
    title: "Guides",
    description: "Practical guides for cleaning Gmail and Outlook without losing important email.",
    h1: "Inbox cleanup guides.",
    eyebrow: "Guides",
    body: "Find practical ways to clean old email, recurring senders, newsletters, and storage-heavy clutter.",
    bullets: ["Gmail bulk cleanup", "Outlook mailbox cleanup", "Storage and sender-focused guides"],
    cta: "Clean my inbox",
    providerIntent: "generic",
    contentCluster: "guides",
    relatedSlugs: ["delete-old-emails", "delete-emails-by-sender", "delete-newsletters", "bulk-delete-emails", "free-up-gmail-storage", "inbox-reset"],
    priority: 0.7
  }
];

export function getMarketingPage(slug: string) {
  return marketingPages.find((page) => page.slug === slug);
}

export function getMarketingPagesBySlugs(slugs: string[]) {
  return slugs.flatMap((slug) => {
    const page = getMarketingPage(slug);
    return page ? [page] : [];
  });
}
