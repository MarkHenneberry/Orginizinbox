export type CleanupGuide = {
  heading: string;
  steps: string[];
  sections: Array<{ heading: string; text: string }>;
  faqs: Array<{ question: string; answer: string }>;
  sources: Array<{ title: string; href: string }>;
};

const gmailSearch = { title: "Google's Gmail search operators", href: "https://support.google.com/mail/answer/7190?hl=en" };
const gmailTrash = { title: "Google's Gmail deletion and recovery guide", href: "https://support.google.com/mail/answer/7401?hl=en" };

export const cleanupGuides: Record<string, CleanupGuide> = {
  "gmail-cleaner": {
    heading: "Start with the clutter, not Select all",
    steps: [
      "Choose one area to review: recurring senders, old newsletters, or unread promotions. Do not start by selecting your entire mailbox.",
      "When Gmail scanning is available, connect through the Connect page and request an Inbox Report. A scan does not move messages.",
      "Compare the Suggested, Review, and Protected counts. Open sender groups to understand what was included; a familiar sender can send both promotions and important account mail.",
      "Where cleanup is enabled, open Review Cleanup, check the selection, and confirm Move to Trash. Messages that no longer pass the final safety check are left alone.",
      "Check the result and the displayed Undo deadline before disconnecting. Rescan to review what remains."
    ],
    sections: [
      { heading: "What a Gmail cleaner can and cannot decide", text: "Organizinbox groups clutter using sender, age, labels, and mailing-list evidence. Starred, important, recent, participated-in, and other protected messages are excluded according to the protection rules. These signals cannot establish the personal value of every message. Keep anything you may need and review uncertain groups yourself." },
      { heading: "Moving mail is not immediate storage recovery", text: "Organizinbox moves approved Gmail messages to Trash; it does not empty Trash. Messages in Trash still count toward Google storage until permanently removed. Do not empty Trash simply to match a recovery estimate: that can remove your chance to recover messages." },
      { heading: "Availability and practical limits", text: "Production cleanup is not available yet. Connection and read-only scanning depend on current Gmail availability. Development validation uses bounded selections, not an unlimited cleanup promise. You can use the sender and date guides below in Gmail without connecting Organizinbox." }
    ],
    faqs: [
      { question: "Will a scan delete Gmail messages?", answer: "No. Scanning is read-only. Where cleanup is enabled, moving selected messages to Trash requires a separate review and confirmation." },
      { question: "Does Organizinbox store my Gmail inbox?", answer: "Not a permanent copy. Inbox Reports and required scan and restoration state are stored temporarily in encrypted form. Bodies and attachments are not fetched. Subject lines are used temporarily for protection and then discarded." },
      { question: "Is Organizinbox Undo the same as Gmail Trash recovery?", answer: "No. Organizinbox Undo needs its temporary restoration state and is available only until the displayed deadline, while you remain connected. Gmail has its own recovery rules. Disconnecting does not undo a cleanup." }
    ],
    sources: [gmailTrash, { title: "Google's storage and Trash guidance", href: "https://support.google.com/mail/answer/6374270?hl=en" }]
  },
  "outlook-cleaner": {
    heading: "Review Outlook.com or Hotmail before clearing it",
    steps: [
      "Start with a recurring sender in Outlook. Search or sort to review their messages, and check which folder you are viewing.",
      "Inspect conversations and keep anything you need. A sender's newsletters and security notices can share the same address.",
      "Select only unwanted mail and choose Delete in Outlook to move it to Deleted Items. Avoid permanent-delete or empty-folder commands while reviewing.",
      "Check Deleted Items after the move. Use Outlook's Move action to return a message to the folder you want if you changed your mind.",
      "For an Organizinbox report, check the availability shown above. A work or school account may need your organization's approval."
    ],
    sections: [
      { heading: "Outlook support, without an unlimited-cleanup promise", text: "Production Outlook cleanup is not available yet. Read-only scanning is offered only when Microsoft connection and scanning are enabled. Hotmail uses the Outlook.com service; Microsoft 365 accounts can have additional organization policies. Development cleanup tests are not a public cleanup service." },
      { heading: "Protection and recovery limits", text: "Organizinbox protects flagged and important messages and excludes Sent, Drafts, Deleted Items, and their descendants from suggestions. Participation and subject-based protection also apply. Where cleanup is enabled, approved messages move to Deleted Items; Undo restores confirmed moved messages to their original folders. Recovery Undo excludes uncertain messages." },
      { heading: "Do not assume Deleted Items lasts forever", text: "Recovery depends on the account and its retention policies. Organizinbox never permanently deletes email, but it cannot promise indefinite provider recovery. Outlook report storage estimates are shown as Unavailable because the scan does not provide a reliable message-size estimate." }
    ],
    faqs: [
      { question: "Does this include Hotmail addresses?", answer: "Hotmail mailboxes use Outlook.com. Organizinbox availability is shown above; organization-controlled Microsoft 365 accounts may have additional restrictions." },
      { question: "Can I use Organizinbox to clean Outlook today?", answer: "Production Outlook cleanup is not available yet. Enabled accounts may use read-only reports. The development cleanup validation is not general availability." },
      { question: "What happens to Outlook Undo when I disconnect?", answer: "Disconnect removes Organizinbox's temporary restoration state. Reconnecting will not bring that Undo back. It does not restore mail already moved to Deleted Items; check Outlook's own recovery options separately." }
    ],
    sources: [{ title: "Microsoft's deleted-item recovery guide", href: "https://support.microsoft.com/en-us/Outlook/mail/recover-and-restore-deleted-items-in-outlook" }]
  },
  "delete-emails-by-sender": {
    heading: "Delete one sender's unwanted Gmail messages",
    steps: [
      "Open Gmail in a desktop browser and search from:newsletter@example.com, replacing the example with the sender's address.",
      "Narrow the results before selecting them. For example, from:newsletter@example.com older_than:1y finds older mail from that sender.",
      "Review the messages and conversations, especially receipts, account notices, replies, and attachments you may need. A sender filter is not a safety check.",
      "Select the unwanted results and choose Delete to move them to Trash. If Gmail offers to select all matching conversations, inspect the scope before accepting it.",
      "Check Trash before continuing. Removing existing messages does not unsubscribe you or stop future mail."
    ],
    sections: [
      { heading: "One sender does not mean one kind of email", text: "A shop can send a newsletter, an order confirmation, and a password reset from similar addresses. A name can also cover several email addresses. Search by the address you intend to review, keep important records, and split a large selection into manageable groups." },
      { heading: "Search results and protected mail are different", text: "Gmail search finds matching messages; it does not apply Organizinbox's protection rules. Review conversation contents rather than treating every displayed result as one interchangeable unwanted message. Do not assume that a sender with many newsletters sends only disposable mail." },
      { heading: "When the Inbox Report helps", text: "If you do not know which sender to start with, an available Organizinbox scan ranks sender groups and separates Suggested, Review, and Protected mail. Production cleanup is not available yet. Manual Gmail deletion does not create an Organizinbox Undo record." }
    ],
    faqs: [
      { question: "Can I delete every email from a sender at once?", answer: "Gmail can select matching search results, but review the full selection first. Large sender groups may include important conversations as well as unwanted mail." },
      { question: "Does deleting sender mail unsubscribe me?", answer: "No. Deleting existing messages and stopping future messages are separate actions. Review subscriptions or filters separately." },
      { question: "Can Organizinbox Undo a deletion I made in Gmail?", answer: "No. Its restoration state covers only supported cleanups performed through Organizinbox. For a manual Gmail deletion, use Gmail's own recovery options." }
    ],
    sources: [gmailSearch, gmailTrash]
  },
  "delete-old-emails": {
    heading: "Find old Gmail messages without guessing",
    steps: [
      "Choose a date boundary. In Gmail search, before:2024/01/01 finds mail before that date. Use your own cutoff rather than copying it blindly.",
      "For a relative age, use older_than:1y. Narrow the search further with a sender, such as from:newsletter@example.com older_than:1y.",
      "Review results for records you still need: receipts, account information, ongoing conversations, or personal correspondence. Old and unread do not mean unimportant.",
      "Select the unwanted messages and choose Delete in Gmail. Check the entire selection before applying an action to all matching conversations.",
      "Review Trash and keep recovery time before disconnecting from any cleanup tool. Do not empty Trash while you are still deciding."
    ],
    sections: [
      { heading: "Age is a starting point, not permission", text: "Organizinbox does not recommend a message for cleanup just because it is old. Strong bulk-mail evidence and current protection checks also matter. Recent-mail protection is a minimum safeguard, not a promise that everything older is safe to remove." },
      { heading: "Archive or Trash?", text: "If you want less inbox clutter but still need a message, consider archiving it in Gmail instead of deleting it. Archiving is a manual Gmail option, not an Organizinbox cleanup action. Organizinbox's supported Gmail cleanup action is Move to Trash." },
      { heading: "Recovery and storage expectations", text: "Gmail normally permanently removes Trash after 30 days, and manually emptying it can remove mail sooner. Organizinbox's Undo deadline is separate and shorter: use the exact deadline shown on your cleanup result. Production cleanup is not available yet; these Gmail search steps work independently of Organizinbox." }
    ],
    faqs: [
      { question: "How do I find Gmail emails older than a year?", answer: "Search older_than:1y in Gmail. Review the results and narrow by sender before selecting mail to delete." },
      { question: "Are all old messages Suggested by Organizinbox?", answer: "No. Age alone is insufficient. Protected messages are excluded and strong per-message bulk evidence is required for suggestions." },
      { question: "Will deleting old messages immediately free storage?", answer: "Moving mail to Trash is not the same as permanent removal. Organizinbox does not empty Trash and does not guarantee immediate storage recovery." }
    ],
    sources: [gmailSearch, gmailTrash]
  }
};
