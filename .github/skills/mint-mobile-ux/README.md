# Mint mobile UX guidance and sources

Original Mint-specific guidance, reviewed **2026-11-07 UTC** against current
repository code/contracts. This is a future-agent tooling upgrade, not an app
redesign or a claim that native FPS/gesture acceptance has already passed.
Start with [SKILL.md](SKILL.md); load only its relevant compact reference.

## Repository anchors

Always-read product/engineering guides, `agents/design.md`,
`docs/mobile-design.md`, `apps/mobile/package.json`, shared UI primitives,
`SongOptions`, `ConsumerShell`, current player presentation/gesture/seek adapters
and `docs/mobile-playback.md` informed these rules. Paths are navigation aids:
recheck the current domain map, dependencies, native patch and tests before work.

## Verified public primary sources

- [Expo's official skills repository](https://github.com/expo/skills):
  selected native UI and animation at commit
  `a9e5bd3fa00b4e61f632e43f85da73aee1942582`.
  See [native UI provenance/license](../expo-native-ui/README.md) and
  [animation provenance/license](../expo-animation/README.md).
- [React Native performance](https://reactnative.dev/docs/performance):
  distinguish UI and JS frames, release measurement, list/animation costs and
  touch responsiveness. Generic tooling/package suggestions are not permission
  to change Mint dependencies.
- [Reanimated 4.x performance](https://docs.swmansion.com/react-native-reanimated/docs/guides/performance/):
  avoid JS shared-value synchronization, prefer non-layout properties and
  profile release builds. Experimental/native optimization flags can affect
  touch detection and require compatible measured root-cause validation.

Public web search corroborated the official Expo sources; GitHub Agent Finder's
selection score (86) measured relevance, **not trust or security**. No private
repository content was uploaded. Only the explicitly selected two official
skills were vendored; no sibling plugins, hooks, agent configurations, telemetry
or runtime dependencies were installed.

## Maintenance and trust boundary

Keep this skill small and the references task-specific. Revalidate repository
anchors when ownership, dependencies or gesture contracts change; coordinate
domain-map/generated documentation with the sole integration writer.
For upstream refresh, follow each vendored README's pinned diff/license review.
Do not blindly update from `main`, execute upstream reporting commands or send
repository/user data externally. Repository rules and marked Mint overrides
apply throughout vendor references/recipes, including installation examples.
Unavailable optional siblings are linked, not assumed installed; `impeccable`
is an optional critique aid only if already available.
