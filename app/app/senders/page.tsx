import { redirect } from "next/navigation";

export default function SendersPage() {
  redirect("/app/report?view=senders");
}
