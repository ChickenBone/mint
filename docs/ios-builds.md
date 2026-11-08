# iPhone builds and Expo updates

[Mobile setup](mobile.md) | [Android distribution](android-builds.md)

Mint uses EAS Build for standalone, ad hoc iPhone/iPad builds and EAS Update
for compatible JavaScript/assets. A paid Apple Developer membership and an
Expo account with access to the linked project are required. This setup does
not submit to the App Store or TestFlight. EAS quotas apply.

## One-time setup

Install dependencies at the repository root, then use the pinned CLI from
the mobile workspace:

```bash
npm ci
cd apps/mobile
npx eas-cli@27.5.0 login
npx eas-cli@27.5.0 project:info
npx eas-cli@27.5.0 device:create
npx eas-cli@27.5.0 build --platform ios --profile ios-production
```

Open the device-registration link in Safari on your iPhone and complete the
registration before building. Sign in to Apple in the interactive CLI, choose
your Developer team, allow EAS to manage distribution credentials, and include
your device in the provisioning profile. Do not share passwords or verification
codes in issues, logs or chat.

`ios-production` builds a **Release** app for physical devices with remote EAS
signing, the **production** environment/channel and an automatically incremented
remote build number. It is independent of the Android `production` profile's
local keystore. The configured iOS bundle identifier must belong to your team.
Do not change an existing identifier just to resolve an account-access error.

A `preview` build remains useful for standalone testing, but it is not a
production-channel OTA baseline. Install an `ios-production` build to receive
the updates described here. Development builds require a development server
and are not production baselines either.

## GitHub Actions authentication

In **Repository Settings > Secrets and variables > Actions**, configure:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `EXPO_TOKEN` | Expo access token authorized for the linked project; shared with Android CI |
| Secret | `IOS_ASC_API_KEY_P8` | Entire App Store Connect team API key `.p8` contents, including PEM headers |
| Secret | `IOS_ASC_KEY_ID` | That API key's Key ID |
| Secret | `IOS_ASC_ISSUER_ID` | That API key's Issuer ID |
| Variable | `IOS_APPLE_TEAM_ID` | Ten-character Apple Developer Team ID used to sign the app |
| Variable | `IOS_APPLE_TEAM_TYPE` | `INDIVIDUAL`, `COMPANY_OR_ORGANIZATION`, or `IN_HOUSE`, matching your membership |

Create a **team API key** in **App Store Connect > Users and Access >
Integrations > App Store Connect API**. Use the **Admin** role recommended
by Expo for CI credential management, and restrict access to this key;
see [Expo's CI signing requirements](https://docs.expo.dev/build/building-on-ci/).
Download the `.p8` file once, keep a secure backup outside the checkout, and
paste it only into the GitHub secret UI. Never commit the key or upload it as
an artifact. The Apple key is required only for new native builds; OTA-only
runs use `EXPO_TOKEN` and the configured team.

The initial interactive build establishes the EAS-managed iOS signing
credentials. The workflow uses the Apple API key to refresh ad hoc provisioning
and include devices registered with Expo for the same Apple team. It creates
an ignored, restricted-permission key file and removes it even after failure.

If Apple returns `403` with `PLA Update available`, the account holder must
accept the latest Program License Agreement in the Apple Developer account
before rerunning the initial build. CI cannot accept legal agreements for you.

## Automatic build versus update

**iOS EAS Build and Update** runs on mobile/client/distribution changes pushed
to `main`, and can be run manually on the default branch. Before delivery it
runs mobile/client typechecks and tests, mobile lint and distribution guard
tests. Pull-request CI also runs the distribution tests without signing keys.

Each platform decides independently:

| Condition | Delivery |
| --- | --- |
| No finished compatible iOS build, changed native fingerprint, or unavailable baseline artifact | New signed IPA on EAS |
| Finished compatible iOS build with a verified IPA and the same fingerprint | Production **iOS-only** EAS Update |
| Invalid signing, expired provisioning/certificate, wrong channel/runtime or verification failure | Fail explicitly; no OTA publication |
| Manual `force_rebuild` | New IPA even when the native fingerprint is unchanged |

The gate resolves the actual iOS runtime using Expo Updates in the production
environment. It requires a finished internal `ios-production` build with the
expected bundle identifier, production channel and matching runtime **and**
EAS fingerprint. It downloads the IPA and checks code-signature integrity,
Apple team, release/device entitlements, certificate validity and membership
in the unexpired ad hoc profile. It also checks the packaged Expo channel,
exact fingerprint file, embedded JavaScript/manifest and recovery settings.
A queued, failed, Android or preview build cannot authorize an iOS update.

New builds are awaited and verified against the commit and runtime before a
`mint-ios-ipa` artifact is retained for 30 days. A native-build run embeds the
current JavaScript and does **not** also publish OTA. Compatible-update runs
resolve the runtime again immediately before publication and reject drift.
Android's existing independently verified APK/update workflow is unchanged
apart from the same mobile validation before distribution.

After registering another device, manually run the workflow with
`force_rebuild: true` to include it. Device registration does not change the
native fingerprint, and OTA cannot change an installed provisioning profile.
If verification reports expired credentials, use the same force-rebuild option
to refresh signing rather than bypassing the gate.

## Install and update

Open the **finished EAS build page** in Safari on a registered iPhone and choose
Install. Merely downloading an IPA from a GitHub artifact does not install it.
An ad hoc app installs only on devices included in its provisioning profile.
Keep an existing app installed when upgrading to retain account/download state.
Ad hoc provisioning expires and eventually requires a newly signed build.

Connect Mint to your server's public HTTPS root URL and sign in with an
approved account. Expo hosts application code/assets, not your Mint server,
account database or music.

Compatible updates download at launch without delaying startup and normally
apply on a later cold launch. Settings offers a manual check/download and a
user-confirmed restart only while playback is paused and queue preparation
is inactive. Embedded/cached recovery remains enabled. Native dependency,
permission, plugin or runtime changes require installing the new IPA.

Successful EAS/CI verification is packaging evidence, not physical-device
launch, playback, background audio, offline or OTA-application evidence.
