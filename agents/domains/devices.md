# Devices and parties (`devices`)

> Device registry, handoff, remote control and single-output listening parties.

## Boundaries

- Owns device registration and presence, handoff and remote control (`/api/devices/**`), parties (`/api/parties/**`), the devices panel and the device core and DB modules.
- Uses `playback`'s player protocol. Never reimplement the audio engine here.

## Invariants

- Handoff requires an awake, connected destination and a successful playback acknowledgement before the source pauses.
- Parties have one output device. Do not promise synchronized multi-device audio.
- Device state is account-scoped and does not leak across members.

Details: [devices](../../docs/devices.md) and [playback and library](../playback-and-library.md#collections-devices-and-offline).

## Entry points and gotchas

- `lib/devices-store.ts` handles server state, while `device-client.ts` and `device-http.ts` handle client transport. `core/src/devices.ts` defines the shared schema.
- DB tests (`devices-db.test.ts`) skip without `DEVICE_TEST_DATABASE_URL`.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Device registry, handoff, remote control and single-output listening parties.
- **Read before editing:** [agents/playback-and-library.md](../playback-and-library.md), [docs/devices.md](../../docs/devices.md) (UI: also check desktop/mobile per DESIGN.md).
- **Imports from:** [`library`](library.md), [`platform`](platform.md), [`playback`](playback.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md)
- **Imported by:** [`playback`](playback.md), [`web-shell`](web-shell.md)
- **Live detail:** `npm run agents -- map devices` (exports, line counts, cross-domain import edges).

### Owned files (16)

- `apps/web/src/app/api/` `devices/[...path]/route.ts`, `devices/route.ts`, `parties/[...path]/route.ts`, `parties/route.ts`
- `apps/web/src/app/app/` `devices/page.tsx`
- `apps/web/src/components/app/` `devices-panel.tsx`
- `apps/web/src/lib/` `device-client.ts`, `device-http.ts`, `devices-store.ts`, `devices.ts`
- `apps/web/tests/` `devices-db.test.ts`, `devices.test.ts`
- `docs/` `devices.md`
- `packages/core/migrations/` `0007_devices.sql`
- `packages/core/src/` `devices.ts`
- `packages/core/src/db/` `devices.ts`

### Validate

Owned tests: 2.

```bash
npm run typecheck -w @mint/web
npm run lint -w @mint/web
npm exec -w @mint/web -- tsx --test --test-force-exit tests/devices-db.test.ts tests/devices.test.ts
npm run typecheck -w @mint/core
```

> Integration/DB tests skip without PostgreSQL/Redis/audio env vars; see `.github/workflows/ci.yml`. A skip is not a pass.
> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).
> If you change the schema, add a new migration via `npm run db:generate`; never rewrite applied migrations.

<!-- agents:generated:end -->
