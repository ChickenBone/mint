import type { Metadata } from "next";
import Link from "next/link";
import { AnalysisPanel } from "@/components/app/analysis-panel";
import { PageHeader } from "@/components/app/page-header";
import { requireAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Audio analysis" };
export default async function AnalysisPage() {
  await requireAdmin();
  return <>
    <Link href="/app/admin" className="mb-5 inline-flex min-h-11 items-center text-sm text-muted hover:text-fg">← Back to admin</Link>
    <PageHeader title="Audio analysis" sub="Measured loudness, safe transitions and honest sonic similarity. Your original files stay untouched." />
    <AnalysisPanel />
  </>;
}
