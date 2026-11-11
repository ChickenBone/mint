# Connected devices and parties

The player shows the song and the device that is playing it for the whole account. Pause, skip and scrub on any signed-in browser control that player, and the playhead moves together, including while someone is dragging it.

Open **Devices** in the native Now Playing controls or the browser player. A device chooser opens over the player instead of navigating to Settings. Select an awake player to move the account's current music there, including back to this player. Close, Back or Escape returns to the same player without stopping local audio. Loading, offline, pending and failure states remain visible; Refresh retries discovery. **Settings → Devices** remains available in the browser for naming, disconnection and parties.

Browser tabs register as ephemeral **Web player** devices. Normal disconnect, sign-out or page closure removes that tab's registration. A crash or suspended tab disappears after 25 seconds without a heartbeat when the account next lists or registers devices; cleanup does not depend on unload succeeding. Reopening registers a new Web player. Each tab is separate.

Installed Expo apps register against their authenticated installation and account, retaining offline presence for 30 days since the last authenticated Mint connection. Session expiry, sign-out and token rotation do not delete that installation. Reconnecting within the retention window updates the same registration; older registrations are removed during account-scoped device activity. Offline installations are not selectable until the app reconnects and its player polls. Browser-based Expo sessions explicitly register as ephemeral Web players, not installed apps.

The native device bridge belongs to the persistent player provider. It supports handoff and basic play/pause, previous/next and seek; remote volume, queue editing and parties are not native parity claims. Backgrounding marks the bridge disconnected without stopping the local audio engine. Native handoff preserves frozen queue context and duplicate occurrences, but the existing native queue horizon and 50,000-song limit still apply. Preparing a large destination can exceed the command deadline and fail while leaving the source playing. Physical-device suspension, lockscreen and audible continuity require compatible native-build evidence; see [native playback limits](mobile-playback.md).

Remote play/pause, previous/next, seek, volume and queue changes wait for the receiving device's acknowledgment. Browser autoplay restrictions still apply. Open Mint and press Play on the receiving device if playback is blocked.

Selecting a device or **Move this tab's playback here** transfers the entire logical queue (including duplicates), current track, position, shuffle and repeat. Progressive library/source queues transfer their owner-bound server context and at most 100 metadata entries, without a browser 50,000-song library ceiling. Legacy explicit queues support up to 50,000 entries. The source pauses only after the destination confirms the requested playback, not when the command is admitted. Failed, blocked or expired moves leave the source playing. A remote-source move binds its completion to the original acting session and checks source identity both before enqueueing and at delivery of the pause; a changed source asks the listener to choose which player to pause. Queues are never silently truncated.

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

Commands are bound to an exact user, authenticated session, device, monotonic sequence and 20-second deadline. Receiver tokens are held only in memory and hashed on the server. Installed registrations survive authentication-session removal, but cannot receive commands without a fresh, valid session and heartbeat. Polling atomically marks delivery; delivered commands are never reissued, even after a lost acknowledgment. This deliberately provides at-most-once execution rather than unsafe automatic retries. A device processes only one unacknowledged command at a time; missing acknowledgment is surfaced as failure. Each command must be explicitly retried by the user after a failure.

Heartbeat polling runs approximately every two seconds; browser polling omits the queue when it has not changed. Devices become offline after 25 seconds without a heartbeat. Old commands are cleaned up during polling. Registration cleanup is account-scoped: stale Web players are removed at heartbeat expiry and installed registrations expire after 30 days without a Mint connection. Request bodies are bounded to 3 MiB. Cookie web mutations retain the exact configured allowed Origin and approved-session requirements. Only the narrow native device facade accepts validated bearer sessions; it does not expose rename, revoke, arbitrary commands or parties. Supplied user or installation IDs cannot select an acting account.

REST endpoints:

- `GET/POST /api/devices`: list/register.
- `GET /api/devices/:id`: full owned-device state.
- `POST /api/devices/:id/{resume,poll,ack,commands,position,rename,revoke,handoff}`. `position` shares a scrub with the account and does not move playback until a seek command is acknowledged.
- `POST /api/devices/:id/disconnect`: token-bound normal disconnection; deletes a Web player or marks an installed registration offline.
- `POST /api/devices/transfer`: move account playback to an owned, awake destination. `POST /api/devices/complete-transfer` with the admitted command ID pauses its bound source only after confirmed destination playback; completion cannot be replayed.
- `GET /api/devices/commands/:commandId`: command acknowledgment status, restricted to its original acting session.
- `GET/POST /api/parties`: joined/hosted parties or create a party.
- `POST /api/parties/join`: scoped invitation code.
- `GET /api/parties/:id`: member-visible party state.
- `POST /api/parties/:id/{queue,invite,control,leave}`.

The database migrations are `0007_devices.sql` and `0018_device_lifecycle.sql`, registered in the migration journal.

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
