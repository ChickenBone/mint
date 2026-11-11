export { uniqueRecordingResults as uniqueRecordings } from "@mint/client";

export function isCurrentSearch(request: string, active: string, aborted = false) {
  return !aborted && request === active;
}
