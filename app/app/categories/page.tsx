import { redirect } from "next/navigation";

export default function CategoriesPage() {
  redirect("/app/report?view=categories");
}
