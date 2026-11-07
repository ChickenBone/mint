# Bounded device and performance acceptance

Do not claim “smooth,” “high FPS” or “native parity” from code inspection alone.
This checklist defines evidence, not an automatic certification or tool install.

## Establish the build

- Inspect `apps/mobile/package.json` and the owning domain validation commands.
- Functional playback requires a compatible Mint native development/release
  build. Android Expo Go cannot exercise Mint's patched authenticated audio.
- Preserve `expo.autolinking.android.buildFromSource: ["expo-audio"]`, audited
  plugin/checksums, auth headers, native provenance and compatibility gates.
  Source/autolinking tests do not prove compiled APK contents.
- Match native build/runtime and tested JavaScript revision. An OTA cannot
  repair native code; do not bypass runtime gating to test cosmetic changes.
- Measure performance in a **release** native build on representative low-end
  Android; check iOS separately when in scope. Simulator, dev build and browser
  observations are useful diagnostics, not release-device performance evidence.

## Repeatable scenarios

Use the same permitted fixture/catalog size, cache state, network and playback
state for baseline and candidate. Choose a fixed duration/repetition count
(for example three 30-second runs) and record it before comparing.

1. With a song playing, expand/collapse the mini-player repeatedly; slow drag,
   flick, reverse mid-flight and cancel. Audio/current item remain continuous.
2. Seek forward/back, cancel a drag and use accessible adjustment. Verify one
   seek commit and no sheet dismissal or unintended Play/Pause.
3. Browse/scroll a realistic bounded song/category list with playback active;
   load another page and navigate detail/back. Test warm and cold artwork.
4. Open song options, perform one supported async action, inject failure/retry,
   dismiss with Back and return focus. Press response remains visible.
5. Repeat affected flows with reduced motion, large text, screen reader,
   narrow/landscape safe areas and keyboard open. Include touch-near-boundary
   and scroll/slider/OS-edge gesture conflicts.

Verify paused playback also stays paused through routes, sheet and queue edits.
No snapshot, optimistic icon or timer alone proves actual audio continuity.

## Measure both threads

At 60Hz the frame budget is ~**16.7ms**; at supported 120Hz ~**8.3ms**.
These are targets for the actual display cadence, not a guarantee of 120 FPS.
Record actual refresh mode, power/thermal constraints and tool overhead.
Use existing/available tooling appropriate to the build: platform frame traces
(Android Perfetto/system tracing or iOS Instruments) plus a compatible JS/Hermes
profile. Development perf monitor is diagnostic only, not release acceptance.
Report exactly which metrics each tool measures; a JS sample duration is not
automatically a UI frame time. If unavailable, mark the metric unmeasured.

Keep a short evidence table in session/task storage, not the public repository:

| Device/OS, display Hz | Build/runtime/revision | Tool | Scenario/runs | UI frame p95 + jank | JS timing p95/stalls | Limits |
| --- | --- | --- | --- | --- | --- | --- |
| Actual device | Exact tested artifact | Version/config | Fixed workload | Units + missed-deadline definition | Units + method | Unmeasured areas |

State baseline/candidate, frame count, missed-frame/jank definition and relevant
max stalls. Never fill missing metrics with zeros or declare a threshold passed
because the screen looked smooth. Budget regressions require root-cause evidence.

## Fix causes, not benchmarks

- Virtualize large lists; do not nest them in same-axis ScrollViews. Keep
  queries/queues bounded and preserve full-collection Play/Shuffle selection.
- Stabilize row/occurrence identity and expensive props; avoid unnecessary
  global player-driven rerenders and repeated artwork decoding/palette work.
- No per-frame React state, JS bridging, logging or heavy parsing in input paths.
- Prefer non-layout animation, limit simultaneous/offscreen motion and measure
  expensive compositing. Do not add a new list/canvas library for a vague target.
- Native/Reanimated experimental feature flags require a measured compatible
  root cause, separate native-build approval and rollback plan. They may change
  transformed hit-testing: check taps, drags, scrolling and accessibility.
  Generic performance advice alone does not authorize flags or source patches.

## Close the task honestly

Run the smallest checks from `npm run agents -- affected`; tests/build/export
prove only their scope. Make one batched device inspection, fix observed defects
and do a bounded confirmation. Report commands, actual device evidence and
remaining limits; do not publish/commit/deploy unless currently authorized.
See [primary sources and provenance](../README.md).
