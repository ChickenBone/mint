# Android APKs and self-hosted OTA updates

[Mobile setup](mobile.md) | [OTA server and protocol](mobile-updates-server.md)

The **Android APK and OTA** Actions workflow compiles a standalone, signed
`arm64-v8a` release APK for devices such as Pixel 10 Pro. It uses GitHub runners,
not EAS builds, an Expo account, or Play Store submission. GitHub's normal
Actions/storage allowance still applies; this is not a promise of unlimited
free usage. Existing web CI/release workflows are unchanged.

Android setup installs `platform-tools` explicitly rather than the retired
`tools` package. The build then installs the SDK, build tools and NDK selected
by the generated native project.

Ordinary mobile JavaScript, TypeScript, styles and bundled content export as
signed self-hosted OTA updates without recompiling Android. Native changes
produce a new APK first, then publish the matching runtime update. Downloading
and installing that APK remains necessary for a new native runtime.

## One-time setup

Do these steps on an operator-controlled machine. Keep both private keys and
the publisher token outside the checkout, backed up securely. Android APK
signing and OTA manifest signing are **different keys**.

1. Generate a stable Android signing keystore using JDK `keytool`, outside the
   repository. It prompts for passwords and certificate details:

   ```bash
   keytool -genkeypair -storetype JKS -keystore mint-release.keystore \
     -alias mint -keyalg RSA -keysize 4096 -validity 10000
   base64 -w 0 mint-release.keystore > mint-release.keystore.base64
   keytool -exportcert -keystore mint-release.keystore -alias mint -file mint-apk-cert.der
   openssl x509 -inform DER -in mint-apk-cert.der -noout -fingerprint -sha256
   ```

   On macOS use `base64 -i mint-release.keystore | tr -d '\n'` instead.
   Never upload the keystore to the repository or an Actions artifact.

2. Generate a separate long-lived OTA RSA private key and public code-signing
   certificate. SDK 58 requires both Digital Signature and Code Signing usages:

   ```bash
   openssl req -x509 -newkey rsa:2048 -nodes \
     -keyout ota-private-key.pem -out ota-certificate.pem -days 3650 \
     -subj "/CN=Mint OTA signing" \
     -addext keyUsage=digitalSignature -addext extendedKeyUsage=codeSigning
   openssl rand -hex 32 > ota-publish-token.txt
   tr -d '\n' < ota-publish-token.txt | openssl dgst -sha256
   node -e 'const fs=require("fs"); console.log(JSON.stringify({main:fs.readFileSync("ota-certificate.pem","utf8")}))' \
     > ota-certificates.json
   ```

   The token hash must be over the exact secret, **without a trailing newline**.
   The certificate is public; the private key and raw token are not.

3. Deploy the OTA server code on the existing public HTTPS Mint host, with
   isolated persistent storage. For the CLI Compose stack, add the following
   to the operator's private `.env` (never commit filled values):

   ```dotenv
   OTA_PUBLISH_TOKEN_SHA256=<lowercase token hash>
   OTA_SIGNING_CERTIFICATES='{"main":"<public PEM certificate with escaped newlines>"}'
   OTA_MAX_STORAGE_BYTES=1073741824
   ```

   Use the actual one-line JSON from `ota-certificates.json`. Start the optional
   overlay with `docker compose -f docker-compose.yml -f docker-compose.updates.yml up -d`.
   Use both files for subsequent upgrades. This requires the updated web image;
   an old deployed server will return 404. The overlay initializes a dedicated
   `ota_updates` volume for UID 1000 and mounts it only into web, never music,
   worker or hub. Back it up. It is suitable for a single web instance/shared
   POSIX volume, not ephemeral Vercel storage. For NAS project editors, configure
   the same server variables and dedicated writable mount in the web service;
   do not paste private signing keys into Compose. See the server guide for
   TLS/proxy limits, disk budgets and recovery.

4. In **Repository Settings > Secrets and variables > Actions**, configure:

   | Kind | Name | Value |
   | --- | --- | --- |
   | Secret | `ANDROID_KEYSTORE_BASE64` | Base64 contents of the stable keystore |
   | Secret | `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
   | Secret | `ANDROID_KEY_ALIAS` | `mint` or your chosen alias |
   | Secret | `ANDROID_KEY_PASSWORD` | Alias private-key password |
   | Variable | `ANDROID_SIGNING_CERT_SHA256` | APK certificate SHA256, with or without colons |
   | Variable | `MINT_OTA_URL` | `https://mint.example.com/api/updates` using your public host |
   | Variable | `OTA_SIGNING_CERTIFICATE` | Entire public `ota-certificate.pem` |
   | Secret | `OTA_SIGNING_PRIVATE_KEY_PEM` | Entire `ota-private-key.pem` |
   | Secret | `OTA_PUBLISH_TOKEN` | Exact token from `ota-publish-token.txt`, without newline |
   | Variable | `OTA_PUBLISH_ENABLED` | `true` after the server is deployed/configured |

   Public URL/certificate configuration is mandatory before building the first
   OTA-enabled APK. Missing signing credentials fail explicitly; the workflow
   never distributes Expo's default debug-signed release APK. The certificate
   is validated and pinned against the last distributed build. Preserve package
   identifier, keystore, alias and certificate to allow upgrades.

   With `OTA_PUBLISH_ENABLED` unset/false, the workflow still builds required
   APKs and retains exported JS assets, but **does not deliver OTA changes**.
   This lets an operator bootstrap without silently deploying to a host.
   Only protected default-branch pushes/manual runs distribute code; there is
   no pull-request or fork-secret workflow. Protect that branch and Actions
   secrets accordingly.

## First APK, downloads and updates

After the workflow is published to GitHub, open **Actions > Android APK and OTA >
Run workflow** on the default branch. No baseline means the first APK builds
automatically. Select **force_rebuild** for an intentional new APK even without
native changes, for example to embed current JS while OTA hosting is disabled.
No repository automation is dispatched merely by configuring it locally.

Open the completed run's **APK** job summary and download `mint-android-apk`.
GitHub downloads a ZIP; extract `app-release.apk` and its SHA256 file. On your
Pixel, open the APK and allow installs from that browser/file manager if Android
prompts. Alternatively use `adb install -r app-release.apk`. Use the same key
and install over the existing app; uninstalling clears local account/download
data. An old debug/development installation has another signer and cannot be
upgraded in place by this release keystore.

APKs and native-baseline metadata are retained for **30 days**; intermediate
exports for **3 days**, and published signed manifests for **30 days**. Keep a
private backup of known-good export directories for rollback. There is no
GitHub Release, public app store, or unlimited artifact retention configured.

Compatible apps check for production OTA updates on launch, download in the
background and use them on a later cold launch. There is no forced reload during
music playback. Cached/embedded launch and Expo anti-bricking recovery stay
enabled; missing network or an unknown runtime does not justify loading another
runtime. Physical-device launch, recovery, playback and offline behavior still
need device testing.

## How the native gate saves Actions time

Only mobile/client/build-related paths start this workflow. A short job installs
the locked graph, prebuilds Android (including the guarded audio patch), computes
the runtime and exports JS. The expensive Gradle job runs only when the runtime
differs from the last successfully uploaded APK, the retained baseline is
missing/expired, or a manual force rebuild is requested.

The runtime combines the installed SDK 58 `@expo/fingerprint` strict Android
sources with native/plugin npm **resolved versions and integrity**, native
generation tools, root install hooks/overrides/patches, OTA certificate bytes
and native build workflow/helpers. It covers Expo/RN upgrades, transitive
native lockfile changes, local modules, plugin source/options, permissions,
native icons/splash/fonts and guarded native patches. JS-only/web-only lockfile
churn is not itself a native change. Unknown/unhashed native inputs or API errors
fail explicitly instead of reporting OTA compatibility.

App version/versionCode and the explicit runtime string are excluded to avoid
fingerprint recursion and a build on every version increment. Android native
module/plugin **file contents** are hashed, not just package names. JS app sources,
styles, ordinary content, OTA export/manifests and the OTA publisher implementation
are not native sources. Conservative false-positive rebuilds are preferable to
serving incompatible code.

The baseline is a small retained state artifact tied to the exact commit/run and
live APK artifact, with the **APK job's success** checked via the Actions API.
Successful JS-only runs, failed/cancelled APK builds and the previous commit
never become baselines. An OTA publication failure after a successful APK does
not cause repeated native builds. Multiple pushes/retries/cancellations therefore
compare against what was actually distributed, not `HEAD~1`. At most 1,000
completed runs are searched; missing history conservatively bootstraps.

Version codes are seconds since January 1, 2025, or the last retained APK code
plus one, whichever is higher. This survives workflow recreation and reruns.
Distribution is serialized per default branch; stale runs are cancelled. Keep
the runner clock and stable workflow ordering intact. The helper refuses codes
outside Android's supported positive range rather than producing a downgrade.

The native project selects SDK/build-tools/NDK from the resolved RN catalog and
prebuild overrides. The inspected SDK 58 project uses Gradle 9.4.1, AGP 9.2.1,
JDK 17, compile SDK 37, build-tools 37.0.0 and NDK 27.1.12297006. npm and Gradle
caches, arm64-only compilation, two Gradle workers, bounded timeouts/retention and
concurrency cancellation limit work. The APK verifier checks signer/version,
non-debuggable release, arm64-only libraries and 16-KiB ZIP/ELF page alignment.
Changing SDK/native dependencies may require adapting tooling; do not bypass
guarded patch/signing/alignment failures.

## Rollback and troubleshooting

For an OTA rollback, restore a **known-good export** into `.android-ci/export`,
retain its Expo asset keys and native runtime, and use the same certificate,
channel and publisher. Run the publisher with the configured environment:
`PUBLISH_OTA=true node deploy/mobile/ota-publish.mjs`. It creates a new UUID and
new timestamp/signature, uploads/verifies immutable assets first, activates the
manifest last, then reads back and verifies the signed result. Do not edit an old
manifest UUID or republish it with an old creation time. Keep
`.android-ci/expo-config.json` and the public certificate alongside the export.
This is a deliberate operator publication, not an automatic remote action.

An upload/signature/runtime/quota failure leaves the active update untouched.
Rerun a failed publishing job after fixing its cause; never disable signing or
embedded recovery to work around it. Certificate/URL/channel/native configuration
changes require a new APK; changing the Android keystore prevents normal
upgrades. See [server errors and rotation](mobile-updates-server.md#rollback-rotation-and-storage-recovery).

Local validation:
`node --import tsx --test deploy/mobile/*.test.mjs`,
`npm exec -w @mint/mobile -- tsx --test tests/app-config.test.ts`,
mobile typecheck/lint, Expo Doctor and an Android prebuild/export. These checks
do not prove a GitHub Gradle build ran, an APK exists, deployment completed, or
Pixel installation/OTA/background playback worked. Actual signing secrets,
published workflow, server setup and device testing are operator prerequisites.
