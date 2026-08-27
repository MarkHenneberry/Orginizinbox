import { redirect } from "next/navigation";

export default function OldMailPage() {
  redirect("/app/report?view=old-mail");
}
