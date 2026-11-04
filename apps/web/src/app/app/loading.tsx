export default function AppLoading() {
  return <section aria-label="Loading music" aria-busy="true" className="mx-auto w-full max-w-[100rem]">
    <div role="status" className="mb-6 text-sm text-muted">Loading your music…</div>
    <div className="h-10 w-56 rounded bg-elevated motion-safe:animate-pulse motion-reduce:animate-none" />
    <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: 8 }, (_, index) => <div key={index} className="space-y-3">
        <div className="aspect-square rounded-lg bg-elevated motion-safe:animate-pulse motion-reduce:animate-none" />
        <div className="h-4 w-3/4 rounded bg-elevated motion-safe:animate-pulse motion-reduce:animate-none" />
        <div className="h-3 w-1/2 rounded bg-elevated motion-safe:animate-pulse motion-reduce:animate-none" />
      </div>)}
    </div>
  </section>;
}
