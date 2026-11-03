import { optionalEnv, requireEnv } from "@mint/core/env";
import { httpJson } from "../http";

type CobaltResponse =
  | { status: "tunnel" | "redirect"; url: string; filename: string }
  | { status: "error"; error: { code: string; context?: unknown } }
  | { status: "picker"; picker: Array<{ type: string; url: string }> }
  | { status: "local-processing"; tunnel: string[]; output: { filename: string } };

export class CobaltError extends Error {}

/** Asks the self-hosted Cobalt instance for an audio-only stream of a YouTube Music video. */
export async function requestAudio(videoId: string): Promise<{ url: string; filename: string }> {
  const base = requireEnv("COBALT_URL").replace(/\/$/, "");
  const apiKey = process.env.COBALT_API_KEY;
  const res = await httpJson<CobaltResponse>(`${base}/`, {
    method: "POST",
    headers: apiKey ? { authorization: `Api-Key ${apiKey}` } : {},
    body: {
      url: `https://music.youtube.com/watch?v=${videoId}`,
      downloadMode: "audio",
      audioFormat: optionalEnv("COBALT_AUDIO_FORMAT", "best"),
      audioBitrate: optionalEnv("COBALT_AUDIO_BITRATE", "320"),
      filenameStyle: "basic",
      disableMetadata: false,
    },
    timeoutMs: 60_000,
  });
  if (res.status === "tunnel" || res.status === "redirect") return { url: res.url, filename: res.filename };
  if (res.status === "error") throw new CobaltError(`Cobalt error: ${res.error.code}`);
  throw new CobaltError(`Unsupported Cobalt response: ${res.status}`);
}

export async function ping() {
  try {
    await httpJson(`${requireEnv("COBALT_URL").replace(/\/$/, "")}/`, { timeoutMs: 5000, retries: 0 });
    return true;
  } catch {
    return false;
  }
}
