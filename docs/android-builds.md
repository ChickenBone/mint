# Android APKs and Expo updates

[Mobile setup](mobile.md) | [Expo dashboard](https://expo.dev)

Mint uses **EAS Build** to build installable arm64 Android APKs and **EAS Update** to
host compatible JavaScript/assets. GitHub Actions coordinates distribution.
The Mint server continues to serve account APIs and music; no application
update endpoint, signing service or OTA storage is needed on your NAS.
No Play Store submission is configured.

EAS's free plan has build, update-user, bandwidth and storage quotas. Check
[current pricing](https://expo.dev/pricing) before relying on a quota; free
hosting is not unlimited delivery or a guarantee of immediately available
build runners. Builds and updates upload application source/bundled assets
to Expo, not your music library, account database or Mint deployment secrets.

## Expo project and GitHub access

The application configuration is linked to its Expo project. If maintaining
your own fork, create your own project and update the public project ID and
matching `https://u.expo.dev/<project-id>` URL together:

```bash
npm install --global eas-cli
cd apps/mobile
eas login
eas init --id <your-expo-project-id>
```

On a machine without permission to install global packages, use a
user-owned npm prefix or invoke the workflow's pinned EAS CLI with `npx`.
Being signed into Expo on one machine does not authenticate another host
or GitHub Actions.

Create an Expo access token with access to the linked project at
[Expo access tokens](https://expo.dev/settings/access-tokens), then configure
**Repository Settings > Secrets and variables > Actions**:

| Kind | Name | Purpose |
| --- | --- | --- |
| Secret | `EXPO_TOKEN` | Authenticate EAS project initialization, builds and update publication |
| Secret | `ANDROID_KEYSTORE_BASE64` | Base64 contents of the existing stable Android keystore |
| Secret | `ANDROID_KEYSTORE_PASSWORD` | Existing keystore password |
| Secret | `ANDROID_KEY_ALIAS` | Existing private-key alias |
| Secret | `ANDROID_KEY_PASSWORD` | Existing alias password |
| Variable | `ANDROID_SIGNING_CERT_SHA256` | SHA256 of the existing APK signing certificate |

Keep the Android keystore and passwords backed up outside the checkout.
The CI workflow supplies the existing keystore to EAS rather than generating
a different signer. APK verification also retains 16-KiB ZIP/ELF alignment
checks for Pixel devices. Never commit a filled `credentials.json`, keystore,
access token or private key, or upload them as a GitHub artifact.
Protect the default branch and its Actions secrets.

CI reads the APK's binary manifest/resource table with the pinned Android
Build Tools `aapt2`, not `apkanalyzer`'s XML rendering. The latter can generate
invalid XML from otherwise valid JSON-valued Expo channel metadata. Package,
release debug state, production channel, exact fingerprint asset and its
runtime resource reference, launch/recovery settings, signer and arm64
16-KiB ZIP/ELF alignment are all checked before distribution or publication.

For a new fork without an existing signing key, generate one using JDK
`keytool` on an operator-controlled machine:

```bash
keytool -genkeypair -storetype JKS -keystore mint-release.keystore \
  -alias mint -keyalg RSA -keysize 4096 -validity 10000
base64 -w 0 mint-release.keystore > mint-release.keystore.base64
keytool -exportcert -keystore mint-release.keystore -alias mint -file mint-apk-cert.der
openssl x509 -inform DER -in mint-apk-cert.der -noout -fingerprint -sha256
```

On macOS use `base64 -i mint-release.keystore | tr -d '\n'` instead.
Do not replace an existing key: Android upgrades must retain the package
identifier and signer and use an increasing versionCode.
EAS manages production version codes remotely. When migrating an existing
release, use `eas build:version:set --platform android --profile production`
to initialize that remote counter at or above the highest previously
distributed versionCode before building; do not reset it to the local default.

## APK builds and compatible updates

The default-branch workflow checks the Android native runtime against
successful EAS APK builds. A missing/unknown baseline, changed native runtime
or explicit force rebuild creates a new APK. Compatible JavaScript-only
changes publish through EAS Update without consuming another Android build.
A failed new native build must not authorize publishing a matching update.

Native dependencies, config plugins, permissions, native artwork and update
configuration are compatibility inputs. A Git commit hash or only the previous
commit is not a safe native baseline. Keep the guarded Android audio config
plugin: EAS must apply it during native generation, just as local prebuild does.
Changing SDK/toolchain requirements still requires support from the selected
EAS build image; moving a build to Expo does not make unavailable Android SDK
packages available.

Production APKs and updates use the **production** channel. Runtime isolation
prevents a JavaScript update built for changed native modules from loading into
an old APK. Preview/development builds remain separate. Embedded/cached launch
and Expo recovery remain enabled; updates are checked at launch and may be
used on a later cold launch, not by forcibly restarting music playback. With
`fallbackToCacheTimeout: 0`, launch does not wait for the network check: the app
can start its embedded or cached update while a new compatible update downloads
in the background. Close and reopen the app again to let a downloaded update
launch. **Settings > App info** also provides a manual check and download;
applying it always requires a user-confirmed restart while playback is paused
and no queue preparation is active. The section reports the installed native
build number separately from the app-config version, alongside runtime,
channel, current and pending update IDs, and recovery status. Expo SDK 58 does
not expose the Android build number through its Constants module, so Settings
reports that field as unavailable rather than treating an OTA config version
as the binary version. These diagnostics stay on-device and are not attached
to issue reports. Updates never interrupt music automatically.

Open **Actions > Android EAS Build and Update** and run the workflow on the default
branch for the first build. Use **force_rebuild** when intentionally embedding
current JavaScript in a fresh APK even if native compatibility is unchanged.
The run links to EAS build/update results. Newly built, verified APKs are also
retained in the `mint-android-apk` GitHub artifact for 30 days. An APK build embeds
the current JavaScript; that run does not also publish an OTA update. Subsequent
compatible changes publish an update instead. Expo owns APK compilation and
hosting; a submitted or queued build is not a completed APK.

If verification fails after an APK download, the workflow retains that APK
and any binary manifest/resource dumps in `mint-android-verification-diagnostics`
for seven days. Treat this as an unverified diagnostic artifact, not a release.
It excludes keystores, credentials and Expo environment/fingerprint source dumps.

Download the APK from the completed EAS build page, then open it on your phone
and allow installation from that browser/file manager when Android asks.
Alternatively:

```bash
adb install -r app-release.apk
```

Install over the existing release app; uninstalling clears account/download
state. A debug/development installation has a different signer and cannot
be upgraded in place with the release keystore. Physical-device launch,
playback, background audio, offline recovery and OTA application still need
device testing even when CI and EAS Build pass.

## Retiring self-hosted OTA

The previous `/api/updates/**` server, custom manifest publisher and
`docker-compose.updates.yml` overlay have been removed. Install an EAS-enabled
APK before expecting EAS updates; an existing APK's embedded update URL and
certificate cannot be changed by an update served only from Expo.

Remove these obsolete GitHub settings:

- Secrets: `OTA_SIGNING_PRIVATE_KEY_PEM`, `OTA_PUBLISH_TOKEN`.
- Variables: `MINT_OTA_URL`, `OTA_SIGNING_CERTIFICATE`, `OTA_PUBLISH_ENABLED`.

The Android signing settings are **not** obsolete. Keep them and `EXPO_TOKEN`.
There is no self-hosted OTA private signing key or public signing certificate
required for the EAS free-plan setup.

For private NAS Compose copies, remove OTA settings, the `ota-storage-init`
service, its web dependency and the dedicated OTA web mount. Keep native API
CORS configuration, database/secrets/media mounts and existing service values.
See [server migration](self-hosting.md#expo-consumer-app-and-browser-sign-in).
Back up the old OTA folder/volume rather than deleting it as part of migration.

Manage subsequent update rollback in EAS for the same compatible runtime.
Do not roll an incompatible native update onto an old APK or disable recovery
to conceal a failed update. Keep a known-good APK and its stable signing key
for native rollback/recovery.
