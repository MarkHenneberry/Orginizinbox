export type CleanupGuide = {
  heading: string;
  steps: string[];
  sections: Array<{ heading: string; text: string }>;
  faqs: Array<{ question: string; answer: string }>;
  sources: Array<{ title: string; href: string }>;
};

const gmailTrash = { title: "Google's Gmail deletion and recovery guide", href: "https://support.google.com/mail/answer/7401?hl=en" };

export const cleanupGuides: Record<string, CleanupGuide> = {
  "gmail-cleaner": {
    heading: "Scan your Gmail inbox, then choose what to clean",
    steps: [
      "Scan your inbox. Connect Gmail and scan the whole inbox. Scanning does not move or delete anything.",
      "Review your Inbox Report. See Suggested, Review and Protected messages, and which senders create the clutter.",
      "Choose what to clean. Review suggested sender groups and messages, then choose what you want moved.",
      "Confirm cleanup. Where cleanup is available, open Review Cleanup and confirm Move to Trash. Organizinbox runs final safety checks and moves only approved messages.",
      "Review the result. Use Undo within the displayed deadline if needed, before disconnecting. Or scan again to see what remains."
    ],
    sections: [
      { heading: "What a Gmail cleaner can and cannot decide", text: "Organizinbox groups clutter using sender, age, labels, and mailing-list evidence. Starred, important, recent, participated-in, and other protected messages are excluded according to the protection rules. These signals cannot establish the personal value of every message. Keep anything you may need and review uncertain groups yourself." },
      { heading: "Moving mail is not immediate storage recovery", text: "Organizinbox moves approved Gmail messages to Trash; it does not empty Trash. Messages in Trash still count toward Google storage until permanently removed. Do not empty Trash simply to match a recovery estimate: that can remove your chance to recover messages." },
      { heading: "Availability and practical limits", text: "Production cleanup is not available yet. Connection and read-only scanning depend on current Gmail availability. You do not need to choose a sender or date range before scanning. Your Inbox Report helps you decide what to review." }
    ],
    faqs: [
      { question: "Will a scan delete Gmail messages?", answer: "No. Scanning is read-only. Where cleanup is enabled, moving selected messages to Trash requires a separate review and confirmation." },
      { question: "Does Organizinbox store my Gmail inbox?", answer: "Not a permanent copy. Inbox Reports and required scan and restoration state are stored temporarily in encrypted form. Bodies and attachments are not fetched. Subject lines are used temporarily for protection and then discarded." },
      { question: "Is Organizinbox Undo the same as Gmail Trash recovery?", answer: "No. Organizinbox Undo needs its temporary restoration state and is available only until the displayed deadline, while you remain connected. Gmail has its own recovery rules. Disconnecting does not undo a cleanup." }
    ],
    sources: [gmailTrash, { title: "Google's storage and Trash guidance", href: "https://support.google.com/mail/answer/6374270?hl=en" }]
  },
  "outlook-cleaner": {
    heading: "Scan your Outlook or Hotmail inbox first",
    steps: [
      "Scan your inbox. Connect Outlook or Hotmail and scan the whole inbox. Scanning does not move or delete anything.",
      "Review your Inbox Report. See Suggested, Review and Protected messages, and which senders create the clutter.",
      "Choose what to clean. Review suggested sender groups and messages, then choose what you want moved.",
      "Confirm cleanup. Where cleanup is available, open Review Cleanup and confirm Move to Deleted Items. Organizinbox runs final safety checks and moves only approved messages.",
      "Review the result. Use Undo within the displayed deadline if needed, before disconnecting. Or scan again to see what remains."
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
      "Scan your inbox. Connect Gmail and scan the whole inbox. You do not need to pick a sender first. Scanning does not move or delete anything.",
      "Review your Inbox Report. See Suggested, Review and Protected messages, and which senders create the clutter.",
      "Choose what to clean. Open the suggested sender groups you want to review, then choose the messages you want moved.",
      "Confirm cleanup. Where cleanup is available, open Review Cleanup and confirm Move to Trash. Organizinbox runs final safety checks and moves only approved messages.",
      "Review the result. Use Undo within the displayed deadline if needed, before disconnecting. Or scan again to see what remains."
    ],
    sections: [
      { heading: "One sender does not mean one kind of email", text: "A shop can send newsletters, order confirmations and password resets. Organizinbox checks each message, not just the sender. Review the suggested messages and keep anything you may need." },
      { heading: "Protected messages stay out of cleanup", text: "Choosing a sender group does not approve every message from that sender. Protected messages are excluded. Messages that fail the final safety checks are left alone." },
      { heading: "Let the Inbox Report show you where to start", text: "The scan comes first. Your Inbox Report shows sender groups and separates Suggested, Review and Protected mail. You can then choose which groups to clean. Production cleanup is not available yet." }
    ],
    faqs: [
      { question: "Can I delete every email from a sender at once?", answer: "Organizinbox lets you review suggested messages by sender after scanning. It does not move every message from a sender: protected messages and messages that fail final safety checks stay put." },
      { question: "Does deleting sender mail unsubscribe me?", answer: "No. Deleting existing messages and stopping future messages are separate actions. Review subscriptions or filters separately." },
      { question: "Can Organizinbox Undo a deletion I made in Gmail?", answer: "No. Its restoration state covers only supported cleanups performed through Organizinbox. For a manual Gmail deletion, use Gmail's own recovery options." }
    ],
    sources: [gmailTrash]
  },
  "delete-old-emails": {
    heading: "Find old Gmail messages without guessing",
    steps: [
      "Scan your inbox. Connect Gmail and scan the whole inbox. You do not need to choose a date range first. Scanning does not move or delete anything.",
      "Review your Inbox Report. See old-mail counts alongside Suggested, Review and Protected messages, and where the clutter comes from.",
      "Choose what to clean. Review suggested sender groups and messages, then choose what you want moved. Old mail can still be important.",
      "Confirm cleanup. Where cleanup is available, open Review Cleanup and confirm Move to Trash. Organizinbox runs final safety checks and moves only approved messages.",
      "Review the result. Use Undo within the displayed deadline if needed, before disconnecting. Or scan again to see what remains."
    ],
    sections: [
      { heading: "Old does not mean unwanted", text: "Organizinbox does not suggest a message for cleanup just because it is old. It also checks for signs of bulk mail and applies protection rules. Receipts, account notices and personal messages may still matter years later." },
      { heading: "Archive or Trash?", text: "If you want less inbox clutter but still need a message, consider archiving it in Gmail instead of deleting it. Archiving is a manual Gmail option, not an Organizinbox cleanup action. Organizinbox's supported Gmail cleanup action is Move to Trash." },
      { heading: "Recovery and storage expectations", text: "Gmail normally permanently removes Trash after 30 days, and manually emptying it can remove mail sooner. Organizinbox's Undo deadline is separate and shorter: use the exact deadline shown on your cleanup result. Production cleanup is not available yet." }
    ],
    faqs: [
      { question: "How does Organizinbox help me find old Gmail emails?", answer: "Scan your inbox first. Your Inbox Report shows old and unread mail counts by sender, alongside Suggested, Review and Protected messages. Review the suggestions before choosing what to move." },
      { question: "Are all old messages Suggested by Organizinbox?", answer: "No. Age alone is insufficient. Protected messages are excluded and strong per-message bulk evidence is required for suggestions." },
      { question: "Will deleting old messages immediately free storage?", answer: "Moving mail to Trash is not the same as permanent removal. Organizinbox does not empty Trash and does not guarantee immediate storage recovery." }
    ],
    sources: [gmailTrash]
  }
};
