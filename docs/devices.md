# Connected devices and parties

Open **Devices & parties** in the member app. An approved, signed-in Mint player registers its current browser tab. Rename it to identify its room or device. A device must remain awake, online and signed in; Mint cannot wake a closed browser. Background tabs may be suspended by the operating system.

Remote play/pause, previous/next, seek, volume and queue changes wait for the receiving device's acknowledgment. Browser autoplay restrictions still apply. Open Mint and press Play on the receiving device if playback is blocked.

**Move this tab's playback here** transfers the entire logical queue (including duplicates), current track, position, shuffle and repeat. Progressive library/source queues transfer their owner-bound server context and at most 100 metadata entries, without a 50,000-song library ceiling. Legacy explicit queues support up to 50,000 entries. The source pauses only after the destination confirms the requested playback, not when the command is admitted. Failed, blocked or expired moves leave the source playing. Changing source tracks during a move requires manually choosing which device to keep playing. Queues are never silently truncated.

## Parties

Starting a party explicitly opts the host into a shared queue with **one fixed, host-owned playback device**. This is not synchronized multi-device audio. Joining requires an approved Mint account and a private invitation code.

- Invitations expire after at most one hour. Creating another invitation revokes the old one; revoking an invitation does not remove existing participants.
- Hosts can grant or revoke guest queue editing, remove guests, control playback and end the party. Removing a guest also revokes the current invitation.
- Guests edit only when allowed. Queue revisions prevent concurrent edits from overwriting one another; a conflict refreshes the queue and asks the member to retry.
- Shared queue edits do not automatically interrupt playback. The host chooses **Apply shared queue** and waits for acknowledgment from the one party device.
- Parties expire after 12 hours. Ending a party revokes its invitation and access, but does not stop existing playback. Disconnecting its output device ends the party.
- End the party before handing playback to or from its output device.
- Party queues have an explicit 50,000-entry limit. Starting one from a progressive device queue materializes every occurrence, not just its visible window; larger selections fail with a clear limit message.

Device and party actions do not acquire external media. Only existing, playable Mint track IDs with an available file can be queued, including tracks still undergoing analysis.

## Protocol and safety

`startDeviceBridge` in `apps/web/src/lib/device-client.ts` accepts `{memberId,getState,execute,applyHandoff,error}` and returns `{dispose,handoffTo,deviceId}`. `startBridge` is an alias. All device protocol times, duration, seek and handoff position are **seconds**; the native player adapter converts its millisecond values.

`DeviceState` contains `{playing,time,duration,volume,trackId,queue,currentIndex,shuffle,repeat}` and optional `queueContext`/`queueEntryIds`. Without a context, `queue` is the full UUID list. With `{id,total,revision,offset,position,shuffle}`, it is only a bounded window; `currentIndex` is window-local and `position` is global. Entry IDs identify duplicate occurrences. Volume is 0–100. `DeviceHandoff` adds these queue fields to `{queue,currentIndex,position,playing,shuffle,repeat}`. Acknowledgment compares context identity/revision/global position, not identical hydrated windows. `applyHandoff` must reject blocked playback and resolve only after real destination playback confirmation. The callback's optional `AbortSignal` must be checked before playing so expired moves cannot start late.

Commands are bound to an exact user, authenticated session, device, monotonic sequence and 20-second deadline. Device receiver tokens are held only in memory and hashed on the server. Polling atomically marks delivery; delivered commands are never reissued, even after a lost acknowledgment. This deliberately provides at-most-once execution rather than unsafe automatic retries. A device processes only one unacknowledged command at a time; missing acknowledgment is surfaced as failure. Each command must be explicitly retried by the user after a failure.

Heartbeat polling runs approximately every two seconds and omits the queue when it has not changed. Devices become offline after 25 seconds without a heartbeat. Commands older than one day and disconnected registrations older than one day are cleaned up during device activity. Request bodies are bounded to 3 MiB. All mutations require the exact configured `PUBLIC_URL` origin and approved session authentication; supplied user IDs cannot select an acting account.

REST endpoints:

- `GET/POST /api/devices`: list/register.
- `GET /api/devices/:id`: full owned-device state.
- `POST /api/devices/:id/{poll,ack,commands,rename,revoke,handoff}`.
- `GET /api/devices/commands/:commandId`: command acknowledgment status, restricted to its original acting session.
- `GET/POST /api/parties`: joined/hosted parties or create a party.
- `POST /api/parties/join`: scoped invitation code.
- `GET /api/parties/:id`: member-visible party state.
- `POST /api/parties/:id/{queue,invite,control,leave}`.

The database migration is `0007_devices.sql`. Its journal registration is part of the V3.5 release migration sequence.

## Tests

Run unit and bridge tests:

```sh
cd apps/web
npx tsx --test tests/devices.test.ts
```

For PostgreSQL integration tests, set `DEVICE_TEST_DATABASE_URL` to a disposable PostgreSQL administrator connection with database creation permission, then run:

```sh
npx tsx --test tests/devices.test.ts tests/devices-db.test.ts
```

The suite creates and drops its own isolated database. It covers session and ownership isolation, concurrent delivery claims, acknowledgment replay, expiry, blocked handoff, invitation revocation, guest permission, concurrent queue revisions and a single party output. Without that environment variable, only the integration suite is skipped.
