import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readRuntimeConfiguration } from "./runtime-config";
import { startApiRuntime, type ApiRuntime } from "./runtime";

async function main(): Promise<void> {
  let runtime: ApiRuntime | undefined;
  let stopping: Promise<void> | undefined;
  let signalled = false;
  function stop(): Promise<void> {
    stopping ??= runtime!.stop().catch(() => {
      console.error(JSON.stringify({ event: "api-shutdown-failed" }));
      process.exitCode = 1;
    });
    return stopping;
  }
  function onSignal() {
    signalled = true;
    if (runtime) void stop();
  }
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    const config = readRuntimeConfiguration(process.env);
    runtime = await startApiRuntime({
      ...config,
      notifyAccessRequests: ({ pending }) => new Promise<void>((resolve, reject) => {
        process.stdout.write(`${JSON.stringify({ event: "access-requests-pending", pending })}\n`,
          (error) => error ? reject(error) : resolve());
      }),
      errors: { error: () => console.error(JSON.stringify({ event: "api-runtime-error" })) },
    });
    if (signalled) await stop();
    else console.log(JSON.stringify({ event: "api-listening" }));
  } catch {
    console.error(JSON.stringify({ event: "api-startup-failed" }));
    process.exitCode = 1;
  } finally {
    if (!runtime || signalled) {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
