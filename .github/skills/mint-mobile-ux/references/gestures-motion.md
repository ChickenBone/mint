# Gesture and motion contracts

Web parity is interaction meaning and spatial continuity, not a CSS translation.
Motion explains where content came from, what accepted a tap or what changed.
Do not animate purely to make the screen “premium.”

## Current player baseline

`PlayerSurface.tsx` uses `PanResponder`, native-driver `Animated` transforms/
opacity, reduced-motion observation and `gesture.ts` velocity/settle helpers.
Its mini track, header, artwork and metadata are drag surfaces; seeking,
transport, lyrics and queue scrolling are separate interactions.
Read actual helpers/tests for authoritative thresholds; do not copy constants
from this document or change them globally to match an upstream recipe.
Tap mini-player or `/player` opens the same presentation; closing preserves the
single `PlayerProvider`. The seek adapters commit `player.seek` on completion.

## Before implementing a swipe

Write the interaction contract:

| Item | Decision required |
| --- | --- |
| Intent | Existing action this gesture accelerates |
| Surface/direction | Exact handle/row, axis and exclusions |
| Activation | Directional slop, scroll negotiation, no accidental press |
| Tracking | Finger-following, bounded distance, no jumps |
| Release | Distance and recent velocity with consistent units/direction |
| Cancel | Restore previous settled state, no mutation |
| Interruption | Stop current animation; continue from visible position |
| Alternate input | Labeled button + screen-reader action, Back/dismiss |

- Swipe up from the mini-player expands; down dismisses on allowed sheet areas.
  Keep a labeled close/open alternative and OS Back/Escape where applicable.
- Do not attach sheet pans over the seek slider, transport, queue/lyrics scroll,
  editable text or menus. Test diagonal and short drags, not just ideal swipes.
- If dragging a scrolling area is necessary, specify scroll-at-top handoff;
  don't steal scrolling everywhere or disable native scrolling to avoid conflicts.
- Preserve native edge-back gestures and horizontal shelves. Tab switches are
  peers, not push-depth animations; a pager is not permission to add global swipe.
- Swipe-to-reveal and reorder only accelerate current supported operations.
  Keep accessible options/move/remove buttons, revision checks and occurrence IDs.
  Destructive swipes retain confirmation/undo only where an existing contract
  supports it; do not invent rollback or remove permissions.
- End/cancel fires at most one committed action. Movement cancels long-press
  activation; suppress a release tap after a consumed hold/drag.
- Reverse mid-animation, flick both directions, cancel via OS interruption and
  resize/rotate while open. A stale close callback must not hide a reopened sheet.

## Choose the least disruptive motion

Reuse pressed opacity/highlight; react on press-in within roughly 100ms.
Small button scale may fit; full-width rows should highlight, not squash.
Reset on press-out/cancel/disabled/unmount; pending is distinct from success.
Optional existing haptics: one subtle cue per meaningful commit/detent, never
per frame or as sole feedback. Do not add `expo-haptics` just because a recipe
imports it; current package availability is authoritative.

Simple existing transform/opacity effects may keep native-driver `Animated`.
A measured continuous gesture need may justify installed compatible Reanimated/
Gesture Handler worklets. Verify API versions, root/provider placement and
native runtime; no blanket migration of working PanResponder code.
Keep continuous values off React render: no per-frame `setState`, scheduled JS
callbacks, network requests, haptics or shared-value reads on the JS thread.
Use transform/opacity over animated dimensions, layout, blur or shadow; nothing
is “free,” and simultaneous animations still need profiling.

Reduced motion removes large travel, parallax, bounce and decorative scale;
retain immediate state feedback and functional direct manipulation. Observe
preference changes while open. Accessible reading/focus order must match the
settled state; invisible translated controls must not remain focusable.
Use platform navigation transitions where appropriate, not a duplicate overlay
engine or manually animated route stack. Tune only after bounded device testing.
