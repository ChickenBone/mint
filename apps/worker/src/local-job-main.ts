import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readLocalWorkerConfiguration } from "./local-job-config";
import { startLocalWorker, type LocalWorkerRuntime } from "./local-job-runtime";

async function main(): Promise<void> {
  const controller = new AbortController();
  let runtime: LocalWorkerRuntime | undefined;
  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    stopping ??= runtime!.stop().then(() => {
      console.log(JSON.stringify({ event: "local-worker-stopped" }));
    }).catch(() => {
      console.error(JSON.stringify({ event: "local-worker-shutdown-failed" }));
      process.exitCode = 1;
    }).finally(removeSignals);
    return stopping;
  }
  function onSignal() {
    controller.abort();
    if (runtime) void stop();
  }
  function removeSignals() {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    runtime = await startLocalWorker(readLocalWorkerConfiguration(process.env), {
      signal: controller.signal,
      onError: (error) => console.error(JSON.stringify({ event: "local-worker-error", ...error })),
    });
    if (controller.signal.aborted) await stop();
    else console.log(JSON.stringify({ event: `local-worker-${runtime.status}` }));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError" && controller.signal.aborted) {
      console.log(JSON.stringify({ event: "local-worker-stopped" }));
    } else {
      console.error(JSON.stringify({ event: "local-worker-startup-failed" }));
      process.exitCode = 1;
    }
  } finally {
    if (!runtime || runtime.status === "disabled" || controller.signal.aborted) removeSignals();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
