export type AnalyticsEventName =
  | "landing_page_view"
  | "provider_connect_started"
  | "provider_connect_completed"
  | "scan_started"
  | "scan_completed"
  | "inbox_report_viewed"
  | "sender_group_opened"
  | "cleanup_group_selected"
  | "checkout_started"
  | "purchase_completed"
  | "cleanup_started"
  | "cleanup_completed"
  | "disconnect_completed";

type SafeAnalyticsProperties = {
  provider?: "gmail" | "microsoft";
  inboxSizeBucket?: "small" | "medium" | "large" | "very_large";
  fixtureMode?: boolean;
  route?: string;
};

export function trackEvent(_name: AnalyticsEventName, _properties: SafeAnalyticsProperties = {}) {
  void _name;
  void _properties;
  // No provider is configured yet. Keep this boundary explicit and never pass inbox-derived identifiers here.
}
