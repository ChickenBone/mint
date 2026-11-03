import { STAGE_LABEL, type Stage } from "@mint/core/stages";
import clsx from "clsx";

const tone: Record<Stage, string> = {
  queued: "text-muted",
  matching: "text-muted",
  searching: "text-muted",
  downloading: "text-mint",
  importing: "text-mint",
  tagging: "text-mint",
  scanning: "text-mint",
  previewing: "text-mint",
  analyzing: "text-warn",
  ready: "text-fg",
  failed: "text-danger",
};

export function StageBadge({ stage, progress }: { stage: Stage; progress?: number }) {
  const active = stage !== "ready" && stage !== "failed" && stage !== "queued";
  return (
    <span className={clsx("inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap", tone[stage])}>
      {active && <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" aria-hidden />}
      {STAGE_LABEL[stage]}
      {stage === "downloading" && progress != null && progress > 0 && (
        <span className="tabular text-muted">{Math.round(progress * 100)}%</span>
      )}
    </span>
  );
}

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div
      className={clsx("h-1 overflow-hidden rounded-full bg-hover", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
    >
      <div className="h-full rounded-full bg-mint transition-[width] duration-700 ease-out-expo" style={{ width: `${Math.max(2, value * 100)}%` }} />
    </div>
  );
}
