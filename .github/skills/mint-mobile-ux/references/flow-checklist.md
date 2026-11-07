# Flow and control review

Use for the touched screen only. Recheck current domain/card/code ownership.

## Task map

Record entry, listener goal, existing route/action, completion and return.
Walk once with real supported data and once with a relevant failure/empty state.
Ask: what would a first-time listener tap, and does that tap do what it promises?
Minimize repeated choices and unnecessary modal-to-modal hops, not capabilities.
Keep context on return: query, scroll, selected collection and playback intent.

## Action inventory

Use a small table in task evidence, not a new tracked planning document:

| Control | User intent | Effect/route | Availability | Feedback | Recovery |
| --- | --- | --- | --- | --- | --- |
| Existing label | One clear verb | Exact current contract | Permission/state | Press → pending → result | Cancel/retry/back |

- Resolve vague labels (“Go”, “Done”, duplicate unlabeled icons) into an action.
- Distinguish **Play**, **Add to queue**, **Add to library** and **Download**.
  Queue insertion is not server acquisition; device download is not acquisition.
- Show one obvious primary action per area; Play/Shuffle is a related choice,
  not a reason to remove full-collection shuffle. Transport is a standard group.
- Prefer one state-aware toggle over mutually exclusive repeated actions when
  current data supports it; preserve failure/reconciliation behavior.
- Put less-used song actions in `SongOptions`; keep its trigger discoverable.
  Overflow labels stay explicit and actions remain keyboard/screen-reader usable.
- Do not hide all essentials behind gestures or long press.
- Do not require provider linking or extra confirmations for ordinary listening.
- Confirm destructive listener actions; preserve existing permission boundaries.
- Preserve smart/source-managed read-only status, owners, collaboration and
  playlist revision/occurrence contracts. Never silently convert data ownership.

## Information hierarchy

Home, Search and Your Library remain phone peers; detail pages are drill-ins.
Charts are read-only Search destinations; no mobile operator/pipeline dashboard.
Keep account/settings discoverable without multiplying top-level tabs.
Use existing data-backed categories; no fake popularity, empty invented shelves,
unsupported podcasts, Events, Profiles or Jams to fill a mock design.
Move technical detail out of the listening foreground without deleting access.

## State completeness

- First load: intentional loading, not premature empty.
- Content: title/artwork/navigation separate from playback where supported.
- Pending: disable repeated mutation, retain draft and truthful progress.
- Failure: explain the action that failed; retry preserves intent.
- Partial failure: working local results survive external provider failure.
- Empty/unavailable: explain why, with a relevant next action rather than spam.
- Success: only after confirmed operation; no success-shaped catch fallback.
- Cancellation/back: no mutation on a canceled gesture; return to origin.
- Server/account change: preserve existing invalidation/cleanup boundaries.

## Reachability

Check narrow phone and wide layout, long track/playlist names, largest practical
system font, keyboard-open forms and landscape/safe areas.
44pt iOS / 48dp Android targets need space or carefully bounded `hitSlop`;
invisible overlapping targets are not accessible.
Screen-reader labels describe action/state; status is text, not color alone.
Modal close/Back dismisses, reading order is coherent and focus returns to trigger.
Capture only fictional/demo content with original or appropriately licensed art.
