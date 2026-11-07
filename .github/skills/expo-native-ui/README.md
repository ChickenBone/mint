# Vendored Expo Native UI

- Source: [official Expo skill](https://github.com/expo/skills/tree/a9e5bd3fa00b4e61f632e43f85da73aee1942582/plugins/expo/skills/expo-native-ui).
- Pin: `a9e5bd3fa00b4e61f632e43f85da73aee1942582`; reviewed **2026-11-07 UTC**.
- `SKILL.md` and all seven `references/*.md` retain the upstream body.
  The clearly marked entry-point compatibility override is Mint's only change.
- Full [MIT license](LICENSE) retained from
  [plugins/expo/LICENSE](https://github.com/expo/skills/blob/a9e5bd3fa00b4e61f632e43f85da73aee1942582/plugins/expo/LICENSE):
  copyright 2025-present 650 Industries, Inc. (aka Expo).

Only skill documents are included. Optional `agents/openai.yaml`, plugin
manifests, hooks, reporting tools and other sibling skills are omitted.
No telemetry, runtime packages or native configuration were installed.

The upstream body references optional siblings:
[expo-ui](https://github.com/expo/skills/blob/a9e5bd3fa00b4e61f632e43f85da73aee1942582/plugins/expo/skills/expo-ui/SKILL.md),
[expo-router](https://github.com/expo/skills/blob/a9e5bd3fa00b4e61f632e43f85da73aee1942582/plugins/expo/skills/expo-router/SKILL.md),
[expo-data-fetching](https://github.com/expo/skills/blob/a9e5bd3fa00b4e61f632e43f85da73aee1942582/plugins/expo/skills/expo-data-fetching/SKILL.md).
They are **not installed prerequisites**. Read pinned public guidance only when
needed, subject to Mint rules; do not install siblings automatically.
[expo-animation](../expo-animation/SKILL.md) is included locally.

## Refresh

Choose an explicit upstream commit; fetch only these documents and the license
from `raw.githubusercontent.com/expo/skills/<commit>/plugins/expo/`.
Diff against the old pin, review licenses, links, commands, dependencies and
Mint audio/theme conflicts, then retain/review the marked override.
Update the pin/date and recheck local references and upstream-body integrity.
Never blindly track `main`, execute feedback commands or upload private context.
