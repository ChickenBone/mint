import { CLEAN_RECORDING_INSTRUCTIONS, isPreviewUpload, recordingUploadKind } from "@mint/core/matching";
import { getMatchingDecision } from "@mint/core/matching-db";
import { z } from "zod";
import { log } from "../log";
import type { YtVideo } from "./youtube";

const DECISIONS_URL = "https://api.openai.com/v1/decisions";
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_CONFIDENCE = 0.65;
const MIN_MARGIN = 0.15;
const NONE = "none";

const choiceSchema = z.object({
  answers: z.array(z.object({
    type: z.string(),
    name: z.string(),
    choice: z.string().optional(),
    confidence: z.number().finite().min(0).max(1).optional(),
    probabilities: z.array(z.object({
      value: z.string(),
      probability: z.number().finite().min(0).max(1),
    })).max(12).optional(),
  })).max(5),
}).passthrough();

export type ClassifierDecision =
  | { status: "selected"; id: string; confidence: number }
  | { status: "none"; confidence: number }
  | { status: "fallback"; reason: "disabled" | "unconfigured" | "unavailable" | "uncertain" | "invalid" };

interface ClassifierOptions {
  enabled?: boolean;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function durationSeconds(value: string | null) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value ?? "");
  return match ? Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) : null;
}

async function boundedText(response: Response) {
  if (!response.body) throw new Error("Decision response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Decision response is too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function classifyRequestedVideo(
  track: { title: string; artist: string; durationSec: number | null },
  candidates: YtVideo[],
  options: ClassifierOptions = {},
): Promise<ClassifierDecision> {
  let enabled = options.enabled;
  let apiKey = options.apiKey;
  if (enabled === undefined) {
    try {
      const stored = await getMatchingDecision();
      enabled = stored.enabled;
      apiKey ??= stored.apiKey ?? undefined;
    } catch {
      return { status: "fallback", reason: "unavailable" };
    }
  }
  if (!enabled) return { status: "fallback", reason: "disabled" };
  if (!apiKey) return { status: "fallback", reason: "unconfigured" };
  if (!candidates.length) return { status: "fallback", reason: "invalid" };

  const clean = candidates.filter((candidate) => !isPreviewUpload(candidate.title) && recordingUploadKind(candidate.title, candidate.channelTitle) === "clean studio audio");
  const offered = (clean.length ? clean : candidates).slice(0, 10);
  const request = {
    model: "gpt-6-luna",
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "Choose the clean studio audio for this song. Stay away from music videos." },
        { type: "input_json", data: {
          requested: { title: track.title, artist: track.artist, duration_seconds: track.durationSec },
          candidates: offered.map((candidate) => ({
            id: candidate.id,
            title: candidate.title,
            channel: candidate.channelTitle,
            duration_seconds: durationSeconds(candidate.durationIso),
          })),
        } },
      ],
    }],
    questions: [{
      type: "choice",
      name: "recording",
      instructions: CLEAN_RECORDING_INSTRUCTIONS,
      choices: [
        ...offered.map((candidate) => ({
          value: candidate.id,
          description: `${candidate.title}; channel: ${candidate.channelTitle}; duration: ${durationSeconds(candidate.durationIso) ?? "unknown"} seconds; ${recordingUploadKind(candidate.title, candidate.channelTitle)}`,
        })),
        { value: NONE, description: "None of these is the same original studio recording." },
      ],
    }],
  };

  try {
    const response = await (options.fetchImpl ?? fetch)(DECISIONS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`OpenAI Decisions returned ${response.status}`);
    const parsed = choiceSchema.safeParse(JSON.parse(await boundedText(response)));
    const answer = parsed.success ? parsed.data.answers.find((item) => item.name === "recording" && item.type === "choice") : undefined;
    if (!answer?.choice || answer.confidence === undefined || !answer.probabilities) return { status: "fallback", reason: "invalid" };
    const ranked = [...answer.probabilities].sort((a, b) => b.probability - a.probability);
    const selectedProbability = answer.probabilities.find((item) => item.value === answer.choice)?.probability;
    const runnerUp = ranked.find((item) => item.value !== answer.choice)?.probability ?? 0;
    if (selectedProbability === undefined || answer.confidence < MIN_CONFIDENCE || selectedProbability - runnerUp < MIN_MARGIN) {
      return { status: "fallback", reason: "uncertain" };
    }
    if (answer.choice === NONE) return { status: "none", confidence: answer.confidence };
    if (!offered.some((candidate) => candidate.id === answer.choice)) return { status: "fallback", reason: "invalid" };
    return { status: "selected", id: answer.choice, confidence: answer.confidence };
  } catch (error) {
    log.warn({ error: error instanceof Error ? error.message : "Unknown decision failure" },
      "OpenAI song decision unavailable; using deterministic matching");
    return { status: "fallback", reason: "unavailable" };
  }
}
