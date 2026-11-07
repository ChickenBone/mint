# Vendored Expo Animation

- Source: [official Expo skill](https://github.com/expo/skills/tree/a9e5bd3fa00b4e61f632e43f85da73aee1942582/plugins/expo/skills/expo-animation).
- Pin: `a9e5bd3fa00b4e61f632e43f85da73aee1942582`; reviewed **2026-11-07 UTC**.
- `SKILL.md` and `RECIPES.md` retain the upstream body. The clearly marked
  entry-point compatibility override is Mint's only change.
- Full [MIT license](LICENSE) retained from
  [upstream LICENSE](https://github.com/expo/skills/blob/a9e5bd3fa00b4e61f632e43f85da73aee1942582/plugins/expo/skills/expo-animation/LICENSE):
  copyright 2026 Emil Kowalski. Upstream collaboration attribution is preserved.

Only these documents/license are included. Optional `agents/openai.yaml`,
plugin manifests, hooks and reporting tools are omitted. Recipe installation
commands are examples, not authorization to install dependencies.
No telemetry, runtime packages or native configuration were installed.

The upstream web-only `animate` recommendation is **not installed** and is not
part of the pinned Expo plugin. Its canonical collection is
[emilkowalski/skills](https://github.com/emilkowalski/skills); do not assume a
local skill or fetch/install it for native work.
Routing guidance is optional
[expo-router](https://github.com/expo/skills/blob/a9e5bd3fa00b4e61f632e43f85da73aee1942582/plugins/expo/skills/expo-router/SKILL.md),
not an installed prerequisite. Consult pinned guidance only as needed.
[expo-native-ui](../expo-native-ui/SKILL.md) is included locally.

## Refresh

Choose an explicit upstream commit; fetch only `SKILL.md`, `RECIPES.md` and
`LICENSE` from its `plugins/expo/skills/expo-animation/` directory.
Diff against the old pin, review licenses, API/version assumptions, external
commands, required packages and device claims. Retain/review the marked Mint
override, update the pin/date and check local links and upstream-body integrity.
Never blindly track `main`, enable experimental flags, execute reporting
commands or upload repository/user data.
