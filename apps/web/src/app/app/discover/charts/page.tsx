import Link from "next/link";
import { CHARTS } from "@/lib/charts";
import { PageHeader } from "@/components/app/page-header";

export default function ChartsPage() {
  return <>
    <PageHeader title="Charts" sub="Rankings and trending collections, with their provider and scope kept in view." />
    <ul className="divide-y divide-line">
      {CHARTS.map((chart) => <li key={chart.id}>
        <Link href={`/app/discover/charts/${encodeURIComponent(chart.id)}`} className="flex min-h-16 items-center justify-between gap-4 py-3 hover:text-fg">
          <span className="min-w-0"><span className="block truncate font-semibold">{chart.title}</span><span className="mt-1 block text-sm text-muted">{chart.providerName} · {chart.description}</span></span>
          <span aria-hidden className="text-muted">→</span>
        </Link>
      </li>)}
    </ul>
  </>;
}
