# Mobile Settings (`mobile-settings`)

## Boundaries and contracts

- Owns `src/features/settings`, `/settings`, OTA model and settings tests.
- Consumes auth/API and playback/offline contracts. Expo configuration belongs to foundation; APK/update publication belongs to `deploy` and needs current authorization.

## Invariants

- Preserve account connection, privacy/history deletion, local download storage, MP3 compatibility, supported-playback information, written-only issue reporting and sign-out.
- No pipeline/operator dashboard, invented profiles or native DSP/Smart Fades claims.
- Developer options enable local-only, bounded Stats for nerds. Keep account-scoped preferences separate from ephemeral traces; never auto-upload diagnostics or append them to written issue reports.
- Destructive operations require confirmation; account cleanup failures are explicit, not success-shaped defaults.
- Manual updates keep installed build/runtime/channel/recovery truthful. Restart is unavailable while playback or queue preparation is active.
- A compatible update check is not permission to publish, nor proof of installed device behavior.

Use generated focused checks; changing audio/storage/session behavior requires the owning contract domain.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Listener settings, privacy/history, local storage, developer options, app information and compatible update checks.
- **Read before editing:** [agents/mobile-features.md](../mobile-features.md).
- **Imports from:** [`mobile`](mobile.md), [`mobile-playback`](mobile-playback.md)
- **Imported by:** none
- **Live detail:** `npm run agents -- map mobile-settings` (exports, line counts, cross-domain import edges).

### Owned files (6)

- `apps/mobile/app/` `settings.tsx`
- `apps/mobile/src/features/settings/` `SettingsScreen.tsx`, `ota-model.ts`
- `apps/mobile/tests/` `settings-diagnostics.test.ts`, `settings-ota-model.test.ts`, `settings-screen.test.ts`

### Validate

Owned tests: 3.

```bash
npm --prefix apps/mobile run typecheck
npm --prefix apps/mobile exec -- eslint app/settings.tsx src/features/settings/SettingsScreen.tsx src/features/settings/ota-model.ts tests/settings-diagnostics.test.ts tests/settings-ota-model.test.ts tests/settings-screen.test.ts
npm --prefix apps/mobile exec -- tsx --test tests/settings-diagnostics.test.ts tests/settings-ota-model.test.ts tests/settings-screen.test.ts
```

<!-- agents:generated:end -->
