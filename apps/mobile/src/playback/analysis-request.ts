import type { TrackAnalysisResponse } from "@mint/client";
export type AnalysisState = { status: "loading" } | { status: "ready"; data: TrackAnalysisResponse } | { status: "error" };
export class TrackAnalysisRequest {
  private request: AbortController | null = null;
  constructor(private changed: (state: AnalysisState) => void) {}
  load(fetch: (signal: AbortSignal) => Promise<TrackAnalysisResponse>) {
    this.cancel();
    const request = new AbortController();
    this.request = request;
    this.changed({ status: "loading" });
    void fetch(request.signal).then((data) => {
      if (!request.signal.aborted && this.request === request) this.changed({ status: "ready", data });
    }, () => {
      if (!request.signal.aborted && this.request === request) this.changed({ status: "error" });
    });
  }
  cancel() { this.request?.abort(); this.request = null; }
}
