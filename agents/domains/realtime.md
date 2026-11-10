# Realtime events (`realtime`)

> WebSocket service, Redis event channels, realtime tickets and live client components.

## Boundaries

- Owns `apps/realtime`, `core/src/events.ts` (event shapes), the realtime ticket API and live client components.
- WebSockets enhance server-rendered state. They are never the only recovery path.

## Invariants

- Keep polling and invalidation fallbacks wherever they exist.
- Public channels must not reveal member-private data. For example, they must not show who liked a track or expose player items or acquisition authorization.
- Authenticated channels require a valid ticket.

Details: [architecture](../architecture.md#data-and-synchronization).

## Entry points and gotchas

- Producers live in other domains (for example `acquisition`'s `track-state.ts`). Event shape changes in `events.ts` are cross-domain, so check *Imported by* below.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** WebSocket service, Redis event channels, realtime tickets and live client components.
- **Read before editing:** [agents/architecture.md](../architecture.md).
- **Imports from:** [`acquisition`](acquisition.md), [`library`](library.md), [`platform`](platform.md), [`playback`](playback.md), [`web-shell`](web-shell.md), [`workers`](workers.md)
- **Imported by:** [`acquisition`](acquisition.md), [`collections`](collections.md), [`devices`](devices.md), [`library`](library.md), [`platform`](platform.md), [`playback`](playback.md), [`providers`](providers.md), [`web-shell`](web-shell.md), [`workers`](workers.md)
- **Live detail:** `npm run agents -- map realtime` (exports, line counts, cross-domain import edges).

### Owned files (9)

- `apps/realtime/` `package.json`, `tsconfig.json`
- `apps/realtime/src/` `index.ts`
- `apps/web/src/app/api/` `realtime/ticket/route.ts`
- `apps/web/src/components/` `live-dot.tsx`, `live-stats.tsx`, `realtime.tsx`
- `apps/web/src/components/app/` `live-track-list.tsx`
- `packages/core/src/` `events.ts`

### Validate

No owned automated tests; add focused tests with behavior changes.

```bash
npm run typecheck -w @mint/realtime
npm run typecheck -w @mint/web
npm run lint -w @mint/web
npm run typecheck -w @mint/core
```

> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).

<!-- agents:generated:end -->
