import { requireUser } from "@/lib/auth";
import { chartPage } from "@/lib/chart-service";
import { CHARTS } from "@/lib/charts";
import { ChartBrowser } from "@/components/app/chart-browser";
import { notFound } from "next/navigation";
import Link from "next/link";

export default async function ChartDetailPage({ params }: { params: Promise<{ chart: string }> }) {
  const user = await requireUser(), { chart } = await params;
  if (!CHARTS.some((definition) => definition.id === chart)) notFound();
  return <>
    <Link href="/app/search#charts" className="mb-5 inline-flex min-h-11 items-center gap-2 text-sm text-muted hover:text-fg">← All charts</Link>
    <ChartBrowser key={chart} initial={await chartPage(chart, user.id)} member />
  </>;
}
