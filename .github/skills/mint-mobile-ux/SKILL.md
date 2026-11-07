---
name: mint-mobile-ux
description: Design, improve or review any Mint native mobile screen, listener flow, button, navigation, gesture, swipe, motion, tap feedback, accessibility or UI performance. Use before implementation to make actions coherent, reuse existing primitives and preserve persistent playback.
---

# Mint mobile UX

Make the listener's next action obvious and the phone feel responsive.
This is task guidance, not permission to redesign unrelated UI, invent features,
install packages, publish builds or certify FPS. Repository rules win.

## 1. Load a small, current task map

Read `agents/product-decisions.md` and `agents/engineering.md`, then run:

```sh
npm run agents -- context "<actual task>" [owned paths]
```

Read only the returned domain cards/guides, `agents/design.md` and
`docs/mobile-design.md`. If context tooling is unavailable, use
`agents/domains/README.md` to choose the owning feature manually.
Inspect the current implementation/tests; old paths and this skill are not
authority over current contracts. Use `npm run agents -- owner <path>` if unsure.

Load [flow checklist](references/flow-checklist.md) for screen/action work,
[gestures and motion](references/gestures-motion.md) for touch/motion work, and
[device acceptance](references/device-acceptance.md) for performance/verification.
Do not load every feature or vendor reference into a small-context session.

## 2. Name the task before drawing buttons

Write one sentence: “The listener enters from __, wants __, and finishes at __.”
Map entry → choice → action → pending → result → return; include cancel/retry.
Walk the current route and identify dead ends, repeated decisions and controls
whose labels do not match their effects. Do not count button reduction as success
if the task becomes harder to discover or a capability disappears.

Inventory every touched control: label, intent, state, destination/mutation,
permission/capability, feedback and recovery. See the compact reference template.
Classify as primary, secondary, navigation or destructive.
Keep **one primary action per area**; transport remains a coherent control group.
Move infrequent secondary actions to the existing options/overflow surface,
not nested mystery menus. Preserve discoverability and accessible alternatives.
Hide unsupported actions only with truthful context; never fake success.

## 3. Reuse Mint before adding a toolkit

Check these current seams, then only the feature being changed:

| Need | Existing implementation |
| --- | --- |
| Colors, spacing, type, wide geometry | `apps/mobile/src/theme/tokens.ts` |
| Button/Field/Notice/Artwork/Section | `apps/mobile/src/components/ui/primitives.tsx` |
| Song action options | `apps/mobile/src/components/ui/SongOptions.tsx` |
| Shared music/detail rendering | `apps/mobile/src/components/music/` |
| Phone tabs, wide sidebar, pinned player | `apps/mobile/src/shell/ConsumerShell.tsx` |
| Mini-player and expanded presentation | `apps/mobile/src/features/player/PlayerSurface.tsx` |
| Drag thresholds/velocity helpers | `apps/mobile/src/features/player/gesture.ts` |
| Native/web seek adapters | `apps/mobile/src/features/player/SeekSlider*` |
| Persistent engine and root placement | `apps/mobile/src/playback/PlayerProvider.tsx`, `apps/mobile/app/_layout.tsx` |

`Button` already provides pressed opacity and busy/disabled semantics.
Player `Action` also provides pressed opacity; these are not missing wholesale.
Other triggers must be inspected: not every current `Pressable` has feedback.
Current helpers are a baseline, not proof of universal accessibility or speed.
Fix shared behavior once in its owning domain, rather than copying a new button
into each feature. Coordinate shared contracts with their owner.
Keep charcoal/mint semantic tokens and native platform typography; do not port
web CSS, replace the palette or rename folders to match generic advice.

## 4. Preserve the meaning of web interactions on a phone

Parity means the same action, outcome and spatial continuity—not identical CSS
or every browser animation. Use direct manipulation where it fits the task.
Mini-player upward drag/tap expands; downward drag/close dismisses the same
presentation. Detail navigation may use platform back gestures; retain Back.
Scroll remains scroll; do not add global horizontal swipes that fight shelves,
seeking or operating-system edge gestures.
Home, Search and Your Library are peers. Tab changes must not pretend to push
deeper into a stack. Do not add tabs or fictitious destinations to “simplify.”
Swipe-to-reveal/reorder must expose an existing action, with a visible button
alternative; it does not authorize new acquisition, delete or queue semantics.
Define activation direction, cancellation, velocity settle, interruption and
scroll/control exclusions before implementation; use the gesture reference.

## 5. Respond immediately, animate deliberately

Show pressed feedback on press-in, visibly reacting within roughly **100ms**;
commit once on the actual accepted press, not on canceled drag/release.
Existing highlight/opacity is fine; subtle transform feedback may fit buttons.
No hover-only affordance. Pending feedback is not a completed operation.
Optional haptics must be supported by existing dependencies and platform/user
settings: subtle, never per frame, never the only feedback, no false success.

Existing native-driver `Animated` is suitable for simple transform/opacity.
For justified continuous gestures, use dependency-compatible Reanimated/Gesture
Handler worklets; do not mandate migration solely from upstream prescriptions.
Avoid layout animation, React `setState`/JS callbacks per frame and gratuitous
blur, shadows or animated rows. Inspect installed versions before using APIs.
Ship reduced motion with the change, including changes while the UI is open.

## 6. Make success, failure and access real

Provide labels, roles/states and screen-reader actions; swipe is never required.
Target at least **44pt iOS / 48dp Android** in both dimensions, with nonoverlapping
hit areas. Existing 44-unit controls need Android review, not a claim of 48dp.
Check long names, font scaling, contrast, safe areas, keyboard and focus return.
Separate loading/empty/error/unavailable; preserve drafts and retry context.
Keep playlist permissions, duplicate occurrence identity and revision checks.
Play/browse never acquires audio; source-managed playlists stay read-only.

## 7. Protect playback and prove only what was tested

Keep one persistent `PlayerProvider`; sheet/routes/queue edits do not remount
the engine, reset the song or alter paused/playing intent.
Android Expo Go cannot validate Mint's patched authenticated native audio.
Use a compatible Mint native development build for functional checks; preserve
auth headers, `expo-audio` source-build selection, patch provenance and runtime
gates. Native changes need a compatible new binary, not an OTA workaround.
Never migrate to `expo-av`, bypass checks or install dependencies for cosmetics.

Run `npm run agents -- affected` and the smallest owning-domain checks.
Then do one bounded device pass from [device acceptance](references/device-acceptance.md).
Measure release UI **and** JS frames on representative low-end Android; budgets
are ~16.7ms at 60Hz / ~8.3ms at supported 120Hz, not a 120-FPS promise.
Report device/build/runtime/tool/scenario, evidence and untested limitations.
Browser screenshots, export/build success and unit tests do not certify native
gestures, audio continuity or frame rate.

## Optional deeper guidance

Load [Expo Native UI](../expo-native-ui/SKILL.md) for platform controls/layout or
[Expo Animation](../expo-animation/SKILL.md) for a specific motion problem.
Mint overrides apply to all vendor references/recipes. Never run their feedback
commands or upload repository/user data. `impeccable` can help critique if already
available; it is not required or assumed installed. See [sources](README.md).
