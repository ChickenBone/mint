import { QUEUE, type AcquireJob, type ArtistMetadataJob, type FinalizeJob, type MaintenanceJob, type SonicJob, type SyncJob, type TorboxJob } from "@mint/core";
import { createRedis } from "@mint/core/redis";
import { Queue, type DefaultJobOptions } from "bullmq";

export const connection = createRedis();

const defaults: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: { age: 24 * 3600, count: 2000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export const queues = {
  sync: new Queue<SyncJob>(QUEUE.sync, {
    connection,
    // Completed/failed sync jobs are dropped so the per-user jobId only dedupes queued/running syncs.
    defaultJobOptions: { ...defaults, attempts: 2, removeOnComplete: true, removeOnFail: true },
  }),
  acquire: new Queue<AcquireJob>(QUEUE.acquire, { connection, defaultJobOptions: defaults }),
  finalize: new Queue<FinalizeJob>(QUEUE.finalize, { connection, defaultJobOptions: defaults }),
  sonic: new Queue<SonicJob>(QUEUE.sonic, { connection, defaultJobOptions: { ...defaults, attempts: 5 } }),
  artistMetadata: new Queue<ArtistMetadataJob>(QUEUE.artistMetadata, { connection, defaultJobOptions: defaults }),
  torbox: new Queue<TorboxJob>(QUEUE.torbox, { connection, defaultJobOptions: defaults }),
  maintenance: new Queue<MaintenanceJob>(QUEUE.maintenance, {
    connection,
    defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: { count: 100 } },
  }),
};
