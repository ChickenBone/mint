import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

/** Tallies worker JSON-log source-selection failures by their deciding (closest) rejection. */
export const MATCH_FAILURE_MESSAGE = "YouTube audio source selection rejected all candidates";

export interface MatchFailureReport {
  failures: number;
  closest: Record<string, number>;
  candidates: Record<string, number>;
  examples: Array<{ artist: string; title: string; closest: string }>;
}

export function emptyMatchReport(): MatchFailureReport {
  return { failures: 0, closest: {}, candidates: {}, examples: [] };
}

export function addMatchLogLine(report: MatchFailureReport, line: string, exampleLimit = 25) {
  if (!line.includes(MATCH_FAILURE_MESSAGE)) return;
  let entry: { msg?: unknown; closestRejection?: unknown; rejectionCounts?: unknown; expected?: { artist?: unknown; title?: unknown } };
  try {
    entry = JSON.parse(line) as typeof entry;
  } catch {
    return;
  }
  if (entry.msg !== MATCH_FAILURE_MESSAGE) return;
  const closest = typeof entry.closestRejection === "string" ? entry.closestRejection : "no-candidates";
  report.failures++;
  report.closest[closest] = (report.closest[closest] ?? 0) + 1;
  if (entry.rejectionCounts && typeof entry.rejectionCounts === "object") {
    for (const [reason, count] of Object.entries(entry.rejectionCounts)) {
      if (typeof count === "number" && Number.isFinite(count)) report.candidates[reason] = (report.candidates[reason] ?? 0) + count;
    }
  }
  if (report.examples.length < exampleLimit) {
    report.examples.push({ artist: String(entry.expected?.artist ?? ""), title: String(entry.expected?.title ?? ""), closest });
  }
}

export async function readMatchReport(inputs: Readable[]) {
  const report = emptyMatchReport();
  for (const input of inputs) {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) addMatchLogLine(report, line);
  }
  return report;
}

export function formatMatchReport(report: MatchFailureReport) {
  const rows = (counts: Record<string, number>) => Object.entries(counts).sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `  ${reason.padEnd(18)} ${count}`);
  return [
    `Source-selection failures: ${report.failures}`,
    "Deciding reason (closest candidate):", ...rows(report.closest),
    "All candidate rejections:", ...rows(report.candidates),
    ...(report.examples.length ? ["Examples:", ...report.examples.map((item) => `  [${item.closest}] ${item.artist} - ${item.title}`)] : []),
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("match-report.ts")) {
  const files = process.argv.slice(2);
  const report = await readMatchReport(files.length ? files.map((file) => createReadStream(file)) : [process.stdin]);
  console.log(formatMatchReport(report));
}
