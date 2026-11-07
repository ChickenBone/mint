# Mobile UX skills (`mobile-design`)

## Boundaries and loading

- Owns mobile `.github/skills/**` guidance: compact original Mint mobile UX and pinned,
  MIT-licensed official Expo native UI/animation references. No app runtime,
  dependencies or styling-library adoption is authorized by this skill bundle.
- Portable `mint-task-tracking` is carved out to `agent-tooling`; do not load it
  or unrelated skills merely because they share the skill directory.
- For native UI work, **read
  [Mint mobile UX](../../.github/skills/mint-mobile-ux/SKILL.md) first**. Then load
  only the task-relevant local or official references it identifies, never all
  vendored docs. Plain file reads work without an installed skill plugin.
- Feature routes/components/tests stay with their focused owner. A normal
  feature context carries a small skill pointer, not this entire skill bundle.

## Durable contract

- Start from the listener's task and one primary action per area. Preserve
  secondary actions through accessible, discoverable overflow rather than
  removing capabilities or flattening entity semantics.
- Native swipe/animation semantics match existing web actions, not necessarily
  browser implementation. Provide explicit accessible button/menu equivalents;
  gestures must not steal scroll, seek or navigation.
- Immediate press feedback and truthful pending/success/error/retry states take
  priority over decorative motion. Respect reduced motion and cancellation.
- Reuse existing tokens, native typography, shared components and audited
  dependencies. Preserve one mounted player, account isolation and full-selection
  playback. Tailwind/NativeWind is not adopted.
- Mint's wrapper takes precedence over generic Expo Go/audio advice, dependency
  or theme mandates and reporting/telemetry suggestions. No credentials, private
  evidence or audio may be uploaded to apply a reference.
- Smoothness/FPS claims require repeatable release-build physical-device
  measurement with device/refresh rate/scenario/tool/evidence recorded locally.
  Source tests, Hermes exports and animation-library choice are not performance
  certification; report missing native tooling honestly.

## Validation and provenance

Read the [Mint wrapper README](../../.github/skills/mint-mobile-ux/README.md),
[official native UI provenance](../../.github/skills/expo-native-ui/README.md) and
[animation provenance](../../.github/skills/expo-animation/README.md), plus their
retained MIT licenses, before updating upstream content. The READMEs pin source
revisions/paths; preserve attribution and make deliberate audited updates only.
Check relative links, domain ownership, bounded context routing,
`npm run test:agents` and `npm run agents:check -- --strict`. Documentation-only
changes do not require an app rebuild or imply every current screen was redesigned.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Compact Mint mobile UX skill and pinned official Expo native UI/animation references, loaded on demand.
- **Read before editing:** this card.
- **Imports from:** none
- **Imported by:** none
- **Live detail:** `npm run agents -- map mobile-design` (exports, line counts, cross-domain import edges).

### Owned files (19)

- `.github/skills/expo-animation/` `LICENSE`, `README.md`, `RECIPES.md`, `SKILL.md`
- `.github/skills/expo-native-ui/` `LICENSE`, `README.md`, `SKILL.md`
- `.github/skills/expo-native-ui/references/` `controls.md`, `gradients.md`, `icons.md`, `media.md`, `storage.md`, `visual-effects.md`, `webgpu-three.md`
- `.github/skills/mint-mobile-ux/` `README.md`, `SKILL.md`
- `.github/skills/mint-mobile-ux/references/` `device-acceptance.md`, `flow-checklist.md`, `gestures-motion.md`

### Validate

No owned automated tests; add focused tests with behavior changes.

```bash
npm run agents:check
```

<!-- agents:generated:end -->
