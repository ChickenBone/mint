import { STAGE_LABEL, type Stage } from "@mint/core/stages";
import * as React from "react";
import { Badge, ProgressBar as UiProgressBar } from "./ui/primitives";

const tone: Record<Stage, "neutral" | "positive" | "warning" | "danger"> = {
  queued: "neutral",
  matching: "neutral",
  searching: "neutral",
  downloading: "neutral",
  importing: "neutral",
  tagging: "neutral",
  scanning: "neutral",
  analyzing: "warning",
  ready: "positive",
  failed: "danger",
};

export function StageBadge({ stage, progress }: { stage: Stage; progress?: number }) {
  const active = stage !== "ready" && stage !== "failed" && stage !== "queued";
  return (
    <Badge tone={tone[stage]} className="gap-1.5 whitespace-nowrap">
      {active && <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" aria-hidden />}
      {STAGE_LABEL[stage]}
      {stage === "downloading" && progress != null && progress > 0 && (
        <span className="tabular text-muted">{Math.round(progress * 100)}%</span>
      )}
    </Badge>
  );
}

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <UiProgressBar label="Processing progress" value={value * 100} className={className} />
  );
}
