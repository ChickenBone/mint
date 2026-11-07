# Mobile playback

The Expo consumer app has one persistent player outside route lifecycles. Opening
Now Playing, switching tabs, or viewing lyrics never creates a second engine.
Android/iOS use the Expo SDK 58 `AudioPlaylist`, not browser audio or JS-driven
end-of-song timers. Background playback is configured through the `expo-audio`
plugin, the audio session, and active lock-screen controls. Recording and
microphone permissions are disabled.

## Queues and access

Collection playback opens the server's frozen queue, including deliberate
duplicate song occurrences. Pages hydrate progressively; the client retains
bounded metadata while native sources are appended to the full playlist. A
50,000-occurrence ceiling rejects larger queues explicitly rather than silently
truncating them. This ceiling is not a device memory/performance certification.
Shuffle visits upcoming occurrences once; repeat-all wraps and repeat-one stays
on the selected song. Removing, moving, clearing or shuffling upcoming tracks
does not replace the current native item. In particular, the implementation avoids
Expo's iOS `insert`, which rebuilds the current `AVPlayerItem`.

Loaded native items can advance with JS suspended. **Until preparation completes,
only the loaded horizon is available in the background.** The queue view says so;
keep the app open to prepare the complete collection. Metadata for lock-screen
controls is refreshed while JS runs; it can lag native track changes while JS is
suspended. Neither full background collection preparation nor exact gapless
playback is promised.

Lock-screen artwork is resolved through the selected server's public artwork URL
helper before crossing the native bridge, including restored/offline queues and
track changes. External artwork retains the helper's HTTPS/no-credentials rules;
no bearer headers are sent with artwork. Missing artwork is omitted. An invalid
artwork address produces a visible, nonfatal artwork error while title, artist,
album and playback remain available. This JavaScript-only handling does not
require a native rebuild.

Audio is requested from Mint's authenticated public proxy with per-source bearer
headers; private Plex/worker endpoints and credentials are never returned.
Native range seeks retain proxy authorization. The member session currently
lasts 30 days; each new media request is subject to server expiry and revocation.
Foreground validation, transport-error session checks and explicit retry
revalidate access. Confirmed API 401 uses the same account cleanup as sign-out;
ordinary media/network errors do not log the account out. Queue restore is
account/server scoped and paused. Sign-out immediately stops playback and awaits
removal of that account's queue and downloads, including active transfers.
The source adapter always reads the latest account API rather than retaining an
old credential after account refresh.

Original audio is the default. The optional MP3 compatibility setting selects the
existing private conversion proxy and reloads sources while preserving the queue,
position and paused/playing intent. It does not alter original files. Offline
downloads retain their original format; compatibility streaming requires a
connection. Equalizer/DSP, Smart Fades and guaranteed gapless are explicitly
unavailable.

## SDK 58 Android header workaround

Published `expo-audio@58.0.11` ignores `AudioSource.headers` in Android
`AudioPlaylist`, despite the documented source type. See
[expo/expo#51434](https://github.com/expo/expo/issues/51434) and the upstream repair
[expo/expo#51745](https://github.com/expo/expo/pull/51745), merged November 4, 2026.
The repaired release was not published when this implementation was verified.

`apps/mobile/src/playback/with-audio-playlist.cjs` is a temporary, reproducible
Android prebuild plugin. It requires the exact audited package version **and**
SHA-256 checksums of both native files, validates idempotence, and fails loudly
on source/version drift. It installs a Media3 `ResolvingDataSource` with a
playlist-local concurrent URI/header map. Every source replaces its own headers,
including empty headers; unknown URIs get none. Clear and destroy erase the map.
`DataSpec.withRequestHeaders` preserves byte position and length, so Media3 still
constructs ordinary range requests. The HTTP client disables redirects rather
than forwarding bearer credentials to another host.

Expo Go ships stock native modules and never runs this plugin, so its Android
playlist would drop per-item Authorization headers. `playlist.native.ts` detects
Android Expo Go (`executionEnvironment === "storeClient"`) and rejects player
startup with "Install the Mint APK to listen" before any `setAudioModeAsync`,
playlist or lockscreen native call. Play actions report that message rather
than "still starting". Built APKs and development builds are unaffected; iOS
Expo Go keeps stock `expo-audio`, which honors source headers, but remains
unverified on a device.

After an upstream fixed release is available, audit the actual installed native
source, update the SDK-compatible dependency through `expo install`, remove this
plugin from app configuration and delete its source/guard tests. Rebuild a native
development binary and verify headers, ranges, queue editing and suspended
advancement against an isolated authenticated fixture before shipping. A package
upgrade without this audit intentionally fails prebuild.

React Native Track Player was investigated as an alternative, but its current
package/source compatibility with this SDK/RN combination could not be verified;
no unverified replacement or unprotected-URL fallback is installed.

## Offline files

Downloads require an explicit user action and the existing seven-day offline
entitlement. App-private directories and manifest keys use SHA-256 of canonical
server URL plus account ID. Only audio from the authenticated proxy is downloaded.
The server's audio type and byte count are checked before transfer; a partial file
becomes ready only after exact-length verification and a move to its final path.
Restarted incomplete entries become visible retryable failures, never ready.

Transfers are limited to two at a time, 128 MiB per song, 1 GiB per account and
5,000 manifest entries. Reserved bytes count toward admission. Remove/retry/logout
cancel and await in-flight writes before deleting files. Downloads are not
exported through the Files app. There is no background-download completion
guarantee after process termination.

Offline lease expiry is checked when selecting a file and on foreground
revalidation. Cold launch renews the entitlement before restoring a downloaded
queue; an offline expired lease remains rejected. A disconnected device cannot
receive immediate remote revocation.
An already loaded native file cannot be forcibly revoked while JS is suspended;
reconnect/reopen the app to renew or enforce current access. This limitation is
not represented as guaranteed remote revocation.

## Player, artwork and lyrics

The mini-player sits above navigation. Header/artwork/metadata drags directly
follow the finger or mouse, use recent release velocity, and can interrupt or
reverse settling. Controls and seek sliders are outside drag activation;
lyrics/queue keep their own scroll gestures, with the header as the reliable
collapse region. Escape/Back and a labeled close control dismiss the sheet.
Reduced motion skips settling animation but keeps direct tracking.

The background is extracted from actual artwork, never a random seed or uniform
brand green. Native uses a resized 32-pixel image and a platform color extractor;
web uses a 32-pixel canvas histogram. Reads have an eight-second/5 MiB budget,
coalescing and a 64-entry cache. Failure uses a neutral background. Extracted
colors are darkened independently for readable controls and transition smoothly.
`react-native-image-colors` requires a native development binary; Expo Go does
not certify this custom module.

Lyrics come only from the authorized existing server endpoint. Genuine enhanced
LRC words, line timestamps and plain text are distinguished; word timing is never
fabricated. Listeners can scroll independently, resume following, seek to timed
lines, retry errors and send a lyrics report. No operator diagnostics appear.

## Web and verification

Expo web uses `expo-audio`'s player with one bounded authenticated audio blob
because browser audio elements cannot attach bearer headers. It buffers at most
128 MiB for the selected song and releases old object URLs. Advancing on web
depends on active JS and browser autoplay rules; use the native app for sustained
background queues. Native file downloads are unavailable on web, with a visible
explanation rather than a copied service worker.

Web seeking uses a keyboard-focusable range input with current/minimum/maximum
values and Arrow/Home/End controls. Seeking a paused song to its end does not
advance the queue; natural completion while playing still does. Native uses its
platform slider and playlist transport.

Focused checks:

```sh
npm run typecheck -w @mint/mobile
npm exec -w @mint/mobile -- eslint src/playback src/offline src/components/player tests/playback*.test.ts tests/offline-native.test.ts
npm exec -w @mint/mobile -- tsx --test tests/playback*.test.ts tests/offline-native.test.ts
```

Tests exercise complete queue membership, duplicates, races, paused restore,
current-item preservation, header-patch guards, leases, cancellation, incomplete
files, storage limits, real lyric timing and gesture settlement. Source checks
are **not** native execution: this Linux environment has no Android SDK/ADB/JDK
or iOS toolchain, so Android/iOS compilation, actual suspended advancement,
notification controls, image-extractor linkage and range/audio decoding remain
required device release checks. No deployment audio or paid/cloud build is used.
