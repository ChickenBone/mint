# Web shell, auth and management (`web-shell`)

> App layout and navigation, design system/UI kit, auth and accounts, public pages, settings, admin and management views. This domain is also the fallback owner of `apps/web/**` files that no feature domain claims.

## Boundaries

- Browser consumer UX is frozen, maintenance-only. Preserve existing routes/listening and security/backend compatibility fixes; Next.js backend/API and admin tools continue. Native mobile governs future consumer design, not a parallel browser redesign.
- Owns root and app layouts, sidebar and mobile navigation, `components/ui/**`, `globals.css` tokens, auth/session and account actions, public landing/login/request-access/activity pages, Settings, Manage and Admin views, and shared view helpers (`core/src/views.ts`, `stats.ts`).
- Feature panels hosted in Settings or Manage (devices, workers, analysis, sync) belong to their feature domains. This domain owns the frame, not the panel internals.
- Owns member issue reports: `lib/issue-report-model.ts` (client-safe input contract), `lib/issue-reports.ts`, `POST /api/issue-reports`, the reusable `components/app/report-issue.tsx` entry point (`ReportIssueButton`, `ReportIssueDialog`) and the admin portal **Reports** tab. Feature domains may embed the entry point; the `issue_reports` table and migration belong to `platform`.

## Invariants

- Follow the **Music first** contract in [DESIGN.md](../../DESIGN.md): dark charcoal, Figtree and mint accent, with familiar consumer music-app flows. Reuse existing tokens and UI primitives instead of creating parallel design systems.
- Home, Search and Your Library lead navigation. Discovery and the shared catalog remain reachable; machinery moves into Settings and the admin area without disappearing. Existing route links must keep working (`lib/app-routes.ts` legacy redirects).
- Use 44px touch targets, visible focus, keyboard support, reduced motion and intentional loading, empty and error states.
- Issue reports contain only what the member sees and explicitly sends (category, message and optional human-readable context). Never attach audio, lyrics, internal IDs, device or environment data automatically. Only admins can list or resolve reports.
- An account request is not playback approval. Authorization checks stay server-side. Private HTML and APIs must never become shared cache entries.
- Public copy describes native Mint playback, never embedded Plexamp. Never invent metrics.

Details: [design](../design.md) and [UI library](../../docs/ui-library.md).

## Entry points and gotchas

- `lib/auth.ts` (`getUser`) is imported by most API routes. Auth changes are cross-domain.
- `tests/fixtures/redesign-preview.mjs` is the gated screenshot/demo fixture. See [browser testing](../browser-testing-and-mocks.md).
- For visual changes, inspect desktop and mobile together, then make a bounded confirmation pass.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** App layout and navigation, design system/UI kit, auth and accounts, public pages, settings, admin and management views.
- **Read before editing:** [agents/design.md](../design.md), [DESIGN.md](../../DESIGN.md), [docs/ui-library.md](../../docs/ui-library.md) (UI: also check desktop/mobile per DESIGN.md).
- **Imports from:** [`acquisition`](acquisition.md), [`analysis`](analysis.md), [`collections`](collections.md), [`devices`](devices.md), [`library`](library.md), [`mobile-contracts`](mobile-contracts.md), [`platform`](platform.md), [`playback`](playback.md), [`providers`](providers.md), [`realtime`](realtime.md), [`workers`](workers.md)
- **Imported by:** [`acquisition`](acquisition.md), [`analysis`](analysis.md), [`collections`](collections.md), [`devices`](devices.md), [`library`](library.md), [`mobile-contracts`](mobile-contracts.md), [`platform`](platform.md), [`playback`](playback.md), [`providers`](providers.md), [`realtime`](realtime.md), [`workers`](workers.md)
- **Live detail:** `npm run agents -- map web-shell` (exports, line counts, cross-domain import edges).

### Owned files (75)

- `apps/web/` `AGENTS.md`
- `apps/web/src/app/` `error.tsx`, `globals.css`, `layout.tsx`, `manifest.ts`, `not-found.tsx`
- `apps/web/src/app/(public)/` `activity/page.tsx`, `layout.tsx`, `login/login-form.tsx`, `login/page.tsx`, `page.tsx`, `request-access/page.tsx`, `request-access/request-form.tsx`
- `apps/web/src/app/actions/` `admin.ts`, `auth.ts`, `member.ts`
- `apps/web/src/app/api/` `admin/matching/route.ts`, `app-icon/[size]/route.ts`, `healthz/route.ts`, `issue-reports/route.ts`
- `apps/web/src/app/app/` `admin/matching/page.tsx`, `admin/page.tsx`, `error.tsx`, `layout.tsx`, `loading.tsx`, `manage/page.tsx`, `page.tsx`, `settings/page.tsx`
- `apps/web/src/components/` `form.tsx`, `install-app.tsx`, `logo.tsx`, `site-header.tsx`
- `apps/web/src/components/app/` `account-playback.tsx`, `acquisition-alerts.tsx`, `admin-controls.tsx`, `copy-button.tsx`, `manage-view.tsx`, `matching-panel.tsx`, `page-header.tsx`, `report-issue.tsx`, `settings-view.tsx`, `setup-nudge.tsx`, `sidebar-nav.tsx`, `sign-out.tsx`
- `apps/web/src/components/ui/` `confirm-dialog.tsx`, `index.ts`, `interactive.tsx`, `layout.tsx`, `primitives.tsx`, `shelf.tsx`, `toast.tsx`
- `apps/web/src/lib/` `account-login.ts`, `account-playback.ts`, `app-routes.ts`, `auth.ts`, `format.ts`, `id.ts`, `issue-report-model.ts`, `issue-reports.ts`, `page-endpoint.ts`, `request-match.ts`, `resolve-request.ts`, `unified-search.ts`, `youtube-search.ts`
- `apps/web/tests/` `issue-reports.test.ts`, `mutation-origin.test.ts`, `page-endpoint.test.ts`, `request-match.test.ts`, `routes.test.ts`, `ui.test.ts`, `unified-search.test.ts`
- `apps/web/tests/fixtures/` `redesign-network.mjs`, `redesign-preview.mjs`
- `packages/core/src/` `stats.ts`, `views.ts`

### Validate

Owned tests: 7.

```bash
npm run typecheck -w @mint/web
npm run lint -w @mint/web
npm exec -w @mint/web -- tsx --test tests/issue-reports.test.ts tests/mutation-origin.test.ts tests/page-endpoint.test.ts tests/request-match.test.ts tests/routes.test.ts tests/ui.test.ts tests/unified-search.test.ts
npm run typecheck -w @mint/core
```

> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).

<!-- agents:generated:end -->
