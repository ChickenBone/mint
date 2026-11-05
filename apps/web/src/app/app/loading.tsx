import { Skeleton } from "@/components/ui/primitives";

export default function AppLoading() {
  return (
    <div role="status" aria-label="Loading page" className="space-y-8 py-4">
      <div className="space-y-3">
        <Skeleton className="h-10 w-56 rounded-xl" />
        <Skeleton className="h-4 w-80 max-w-full rounded-lg" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-36 rounded-2xl" />
        <Skeleton className="h-36 rounded-2xl" />
        <Skeleton className="h-36 rounded-2xl" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-14 w-full rounded-xl" />
        <Skeleton className="h-14 w-full rounded-xl" />
        <Skeleton className="h-14 w-full rounded-xl" />
      </div>
    </div>
  );
}
