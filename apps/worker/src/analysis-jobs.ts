import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { getDb, schema } from "@mint/core/db";
import { analysisSchema, analysisControlsSchema, ANALYSIS_ALGORITHM, ANALYSIS_VERSION, DEFAULT_ANALYSIS_CONTROLS, withinAnalysisWindow, type AnalysisControls } from "@mint/core/analysis";
import { advanceAnalysisBackfill, analysisSettings, analysisWorkers, enqueueAnalysis, trackAnalysis } from "@mint/core/analysis-db";
import { and, eq, sql } from "drizzle-orm";
import { analyzeAudio } from "./analysis-engine";
import { config } from "./config";
import { confinedMedia } from "./playback";
import { log } from "./log";

export interface AnalysisLease { trackId: string; leaseId: string; filePath: string; controls: AnalysisControls }

export interface WorkerTelemetryUpdate {
  activeTrackId?: string | null;
  engineVersion?: string;
  capabilities?: string[];
  lastError?: string | null;
}

const DEFAULT_CAPABILITIES = ["dsp-v2", "ebur128", "bark12", "mfcc13", "hpcp-key", "genre-mood"];

export async function getAnalysisControls(): Promise<AnalysisControls> {
  const [row] = await getDb().select().from(analysisSettings).where(eq(analysisSettings.id, "global"));
  const envRemoteOnly = process.env.ANALYSIS_REMOTE_ONLY === "true";
  const parsed = analysisControlsSchema.safeParse(row?.controls);
  if (parsed.success) {
    return envRemoteOnly ? { ...parsed.data, executionMode: "remote-only" } : parsed.data;
  }
  return { ...DEFAULT_ANALYSIS_CONTROLS, executionMode: envRemoteOnly ? "remote-only" : DEFAULT_ANALYSIS_CONTROLS.executionMode };
}

export async function analysisHeartbeat(
  id: string,
  mode: "local" | "remote" | "coordinator",
  error: string | null = null,
  telemetry: WorkerTelemetryUpdate = {},
) {
  const engineVersion = telemetry.engineVersion ?? ANALYSIS_ALGORITHM;
  const capabilities = telemetry.capabilities ?? DEFAULT_CAPABILITIES;
  await getDb().insert(analysisWorkers).values({
    id,
    mode,
    error,
    activeTrackId: telemetry.activeTrackId ?? null,
    engineVersion,
    capabilities,
    lastError: telemetry.lastError ?? error,
  }).onConflictDoUpdate({
    target: analysisWorkers.id,
    set: {
      mode,
      error,
      seenAt: new Date(),
      engineVersion,
      capabilities,
      ...(telemetry.activeTrackId !== undefined ? { activeTrackId: telemetry.activeTrackId } : {}),
      ...(telemetry.lastError !== undefined ? { lastError: telemetry.lastError } : error ? { lastError: error } : {}),
    },
  });
}

export async function claimAnalysis(caller: "local" | "remote" = "local", workerId?: string): Promise<AnalysisLease | null> {
  const db = getDb(), controls = await getAnalysisControls();
  if (!controls.enabled || controls.paused || !withinAnalysisWindow(new Date().getUTCHours(), controls.startHourUtc, controls.endHourUtc)) return null;
  if (caller === "local" && controls.executionMode === "remote-only") return null;
  return db.transaction(async (tx) => {
    // Global admission limit applies across NAS and remote workers, not just this process.
    await tx.execute(sql`select pg_advisory_xact_lock(35051001)`);
    await tx.execute(sql`update track_analysis set status = case when attempts >= 3 then 'failed' else 'pending' end,
      error = 'Worker lease expired; check worker connectivity and retry failed analysis', lease_id = null, lease_expires_at = null, updated_at = now()
      where status = 'running' and lease_expires_at < now()`);
    if (caller === "local" && controls.executionMode === "prefer-remote") {
      const remoteOnline = await tx.execute<{ count: string }>(
        sql`select count(*)::text as count from analysis_workers where mode = 'remote' and seen_at > now() - interval '60 seconds'`,
      );
      if (Number(remoteOnline.rows[0]?.count ?? 0) > 0) return null;
    }
    const active = await tx.execute<{ count: string }>(sql`select count(*)::text as count from track_analysis where status = 'running'`);
    if (Number(active.rows[0]?.count ?? 0) >= controls.concurrency) return null;
    const next = await tx.execute<{ track_id: string; file_path: string }>(sql`
      select a.track_id, coalesce(t.file_path,t.existing_file_path) as file_path
      from track_analysis a join tracks t on t.id=a.track_id
      where a.status='pending' and a.version=${ANALYSIS_VERSION}
        and t.stage in ('ready','analyzing') and coalesce(t.file_path,t.existing_file_path) is not null
      order by a.updated_at,a.track_id for update of a skip locked limit 1`);
    const row = next.rows[0];
    if (!row) return null;
    const leaseId = randomUUID();
    await tx.update(trackAnalysis).set({
      status: "running", leaseId, attempts: sql`${trackAnalysis.attempts} + 1`,
      leaseExpiresAt: new Date(Date.now() + (controls.timeoutSec + 120) * 1000), updatedAt: new Date(), error: null,
    }).where(eq(trackAnalysis.trackId, row.track_id));
    if (workerId) {
      await tx.update(analysisWorkers).set({ activeTrackId: row.track_id, seenAt: new Date() }).where(eq(analysisWorkers.id, workerId));
    }
    return { trackId: row.track_id, leaseId, filePath: row.file_path, controls };
  });
}

export async function activeAnalysisLease(leaseId: string) {
  const [row] = await getDb().select({ trackId: trackAnalysis.trackId, filePath: schema.tracks.filePath, existingFilePath: schema.tracks.existingFilePath })
    .from(trackAnalysis).innerJoin(schema.tracks, eq(schema.tracks.id, trackAnalysis.trackId))
    .where(and(eq(trackAnalysis.leaseId, leaseId), eq(trackAnalysis.status, "running"), sql`${trackAnalysis.leaseExpiresAt} > now()`)).limit(1);
  return row ? { trackId: row.trackId, filePath: row.filePath ?? row.existingFilePath } : null;
}

export async function releaseAnalysisLease(leaseId: string, workerId?: string) {
  if (workerId) {
    await getDb().update(analysisWorkers).set({ activeTrackId: null, seenAt: new Date() }).where(eq(analysisWorkers.id, workerId));
  }
  return getDb().update(trackAnalysis).set({ status: "pending", leaseId: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(trackAnalysis.leaseId, leaseId), eq(trackAnalysis.status, "running")))
    .returning({ trackId: trackAnalysis.trackId });
}

export async function finishAnalysis(
  leaseId: string,
  result: unknown,
  error: string | null = null,
  meta?: { workerId?: string; durationMs?: number; engineVersion?: string },
) {
  const parsed = result === null ? null : analysisSchema.parse(result);
  if (!parsed && !error) throw new Error("A completed analysis must contain measured data");
  const saved = await getDb().update(trackAnalysis).set({
    status: error ? "failed" : "complete",
    ...(parsed ? { version: parsed.version, result: parsed } : {}),
    error,
    leaseId: null,
    leaseExpiresAt: null,
    updatedAt: new Date(),
  }).where(and(eq(trackAnalysis.leaseId, leaseId), eq(trackAnalysis.status, "running"), sql`${trackAnalysis.leaseExpiresAt} > now()`))
    .returning({ trackId: trackAnalysis.trackId });
  if (saved.length && meta?.workerId) {
    const durationMs = meta.durationMs !== undefined && Number.isFinite(meta.durationMs) && meta.durationMs >= 0 ? Math.round(meta.durationMs) : null;
    if (error) {
      await getDb().update(analysisWorkers).set({
        failedCount: sql`${analysisWorkers.failedCount} + 1`,
        activeTrackId: null,
        lastError: error,
        seenAt: new Date(),
      }).where(eq(analysisWorkers.id, meta.workerId));
    } else {
      await getDb().update(analysisWorkers).set({
        completedCount: sql`${analysisWorkers.completedCount} + 1`,
        avgDurationMs: durationMs !== null
          ? sql`case when ${analysisWorkers.avgDurationMs} is null then ${durationMs} else round(((${analysisWorkers.avgDurationMs} * ${analysisWorkers.completedCount}) + ${durationMs})::numeric / (${analysisWorkers.completedCount} + 1))::integer end`
          : analysisWorkers.avgDurationMs,
        activeTrackId: null,
        error: null,
        ...(meta.engineVersion ? { engineVersion: meta.engineVersion } : {}),
        seenAt: new Date(),
      }).where(eq(analysisWorkers.id, meta.workerId));
    }
  }
  return saved;
}

export function analysisError(error: unknown) {
  const message = error instanceof Error ? error.message : "Audio analysis failed";
  // Decoder stderr and local file paths must not leak into member-visible diagnostics.
  if (/ENOENT|not found/.test(message)) return "Analysis executable or media file is missing; check ffmpeg/ffprobe and read-only folder mappings";
  if (/EACCES|EPERM/.test(message)) return "Analysis cannot read this file; check worker read-only folder permissions";
  if (/outside configured/.test(message)) return "Indexed media is outside configured library folders; correct the read-only folder mapping";
  if (/exceeds|exceeded|limit|duration is unavailable|changed during|nonempty|cancelled|decoder exited/.test(message)) return message.slice(0, 300);
  return "Audio analysis failed; inspect worker logs, check the file/container and retry";
}

async function runLease(lease: AnalysisLease, signal: AbortSignal, workerId?: string) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const startedAt = Date.now();
  const check = setInterval(() => {
    void Promise.all([activeAnalysisLease(lease.leaseId), getAnalysisControls()]).then(([active, controls]) => {
      if (!active || !controls.enabled || controls.paused || controls.executionMode === "remote-only") controller.abort();
    }).catch(() => controller.abort());
  }, 2000);
  try {
    const roots = [config.musicDir, config.existingMusicDir], file = await confinedMedia(lease.filePath, roots);
    const result = await analyzeAudio(file, {
      ...lease.controls, signal: controller.signal,
      verifyOpened: async (fd) => {
        if (process.platform === "linux") await confinedMedia(await realpath(`/proc/self/fd/${fd}`), roots);
      },
    });
    await finishAnalysis(lease.leaseId, result, null, { workerId, durationMs: Date.now() - startedAt, engineVersion: result.algorithm });
  } catch (error) {
    log.warn({ err: error, trackId: lease.trackId }, "Mint analysis failed");
    // Cancellation must not race a retry or overwrite a newer worker's lease.
    if (controller.signal.aborted) {
      await releaseAnalysisLease(lease.leaseId, workerId);
    } else await finishAnalysis(lease.leaseId, null, analysisError(error), { workerId, durationMs: Date.now() - startedAt });
  } finally { clearInterval(check); signal.removeEventListener("abort", abort); }
}

/** Persistent rows are the queue: restarts resume pending/expired leases without a memory-only cursor. */
export function startAnalysisScheduler() {
  const id = `nas-${randomUUID()}`, controller = new AbortController(), running = new Set<Promise<void>>();
  let busy = false, lastBackfill = 0, lastHeartbeat = 0, lastClaim = 0, lastMode: "local" | "coordinator" = process.env.ANALYSIS_REMOTE_ONLY === "true" ? "coordinator" : "local";
  const tick = async () => {
    if (busy || controller.signal.aborted) return;
    busy = true;
    try {
      const controls = await getAnalysisControls();
      const mode: "local" | "coordinator" = controls.executionMode === "remote-only" ? "coordinator" : "local";
      if (mode !== lastMode || Date.now() - lastHeartbeat > 15_000) {
        await analysisHeartbeat(id, mode, null, { activeTrackId: mode === "coordinator" ? null : undefined });
        lastHeartbeat = Date.now();
        lastMode = mode;
      }
      await advanceAnalysisBackfill(getDb());
      if (!controls.enabled || controls.paused) return;
      if (Date.now() - lastBackfill > 60_000) {
        await enqueueAnalysis(getDb());
        await getDb().delete(analysisWorkers).where(sql`${analysisWorkers.seenAt} < now() - interval '7 days'`);
        // Re-fingerprint periodically; explicit refresh in diagnostics is immediate.
        await getDb().update(trackAnalysis).set({ status: "pending", updatedAt: new Date() })
          .where(and(eq(trackAnalysis.status, "complete"), sql`${trackAnalysis.updatedAt} < now() - interval '7 days'`));
        lastBackfill = Date.now();
      }
      if (controls.executionMode === "remote-only" || Date.now() - lastClaim < controls.intervalSec * 1000) return;
      while (running.size < controls.concurrency) {
        const lease = await claimAnalysis("local", id);
        if (!lease) break;
        lastClaim = Date.now();
        const task = runLease(lease, controller.signal, id).catch((err) => log.error({ err }, "analysis persistence failed")).finally(() => running.delete(task));
        running.add(task);
      }
    } catch (err) {
      log.error({ err }, "analysis scheduler failed");
      await analysisHeartbeat(id, lastMode, analysisError(err)).catch(() => undefined);
    } finally { busy = false; }
  };
  let currentTick: Promise<void> | null = null;
  const dispatch = () => { currentTick ??= tick().finally(() => { currentTick = null; }); };
  const timer = setInterval(dispatch, 2000);
  dispatch();
  return { close: async () => { clearInterval(timer); controller.abort(); await currentTick; await Promise.allSettled([...running]); } };
}
