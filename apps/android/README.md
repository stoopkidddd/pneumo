# Android

Native app for `dev.pneumo.app`: minSdk 26, target API 37, compile SDK 37.2,
Kotlin 2.x, Compose and Material 3. Dynamic color is off. The non-UI core mirrors
the frozen shared protocol and cryptography contracts.

## One-time SDK setup on macOS

Java comes from `mise install`; do not use the macOS Java stub.
The Homebrew command-line tools can be used without Android Studio or sudo:

```sh
brew install --cask android-commandlinetools
mkdir -p "$HOME/Library/Android"
# Only create this link if no SDK already exists at the destination.
ln -s "$(brew --prefix)/share/android-commandlinetools" "$HOME/Library/Android/sdk"
mise install
mise exec -- sdkmanager --sdk_root="$HOME/Library/Android/sdk" --install \
  "platform-tools" "platforms;android-37.2" "build-tools;37.0.0" "emulator"
yes | mise exec -- sdkmanager --sdk_root="$HOME/Library/Android/sdk" --licenses
```

If command-line tools are already installed, skip the Homebrew installation.
For a separately installed SDK, put the command-line tools in
`$HOME/Library/Android/sdk/cmdline-tools/latest` instead of creating the link.
Stop if an installation asks for sudo or GUI consent.

`sdkmanager` currently emits a deprecation notice in favor of `android sdk`;
it remains the command used here to match the M0 setup contract.

## Worktree setup and verification

Run from the repository root:

```sh
mise install
mise run android:setup
mise run check:android
mise run e2e:android
mise exec -- apps/android/gradlew -p apps/android assembleDebug
```

`android:setup` can be repeated. It writes only the ignored
`apps/android/local.properties`, with the physical SDK path resolved from mise's
`ANDROID_HOME`. Resolving symlinks keeps Gradle's managed-device image lookup
consistent with the SDK package index. Spaces and colons are escaped as Java properties.
The Gradle wrapper and its distribution checksum are committed; no global Gradle
installation is needed. APK: `app/build/outputs/apk/debug/app-debug.apk`.

`check:android` runs Spotless/ktlint, detekt, Android Lint (warnings are errors),
JUnit4/Robolectric tests and Roborazzi verification. `mise run check` includes this
lane. JVM contracts cover every shared crypto vector (including the 600,000-
iteration KDF case once), all 90 valid and 111 invalid protocol fixtures, streaming
file validation, MockWebServer requests/errors and encrypted credential persistence.

Detekt uses the stable pair `1.23.8` with Compose Rules `0.4.23`. The detekt config
builds on the default rules and enables Compose checks.

Lint's `AndroidGradlePluginVersion`, `GradleDependency` and `NewerVersionAvailable`
checks are disabled because upstream releases would otherwise make the gate
depend on the date rather than the pinned code. Other lint warnings remain
errors, and the lint baseline contains no suppressed issues. The older stable
Compose Rules version is a compatibility pin, not a lint incompatibility.

## Core APIs

- `crypto`: `MasterKey.derive`, `Hkdf.derive`, `deriveKeys`, `keyCheck`,
  `PushCrypto`, streaming `FileCrypto`, strict `PairingUri` and `Uuidv7`.
  Implementations use JCA/JCE and `SecureRandom`; wire formats follow
  [SPEC §6](../../docs/SPEC.md#6-cryptography-normative). Enforce the passphrase
  minimum in the caller. `FileCrypto.ciphertextSize` computes the upload size.
  PBKDF2 derivation accepts iteration counts through `Int.MAX_VALUE`, the
  `PBEKeySpec` API limit; protocol models retain the shared safe-integer range.
  File operations leave streams open. Discard all output if decryption fails:
  earlier authenticated chunks may already have been written.
- `protocol`: kotlinx.serialization models for every shared schema, including
  sealed payloads and WebSocket frames. `ProtocolJson` ignores unknown keys,
  including decrypted payload fields, but keeps required nullable fields required.
  Refinements validate canonical binary encoding, ids, timestamps, URLs and safe
  integer ranges. Only `ListPushesQuery` coerces numeric strings.
- `net.ApiClient`: suspend APIs for account/pairing, devices, files and pushes.
  JSON reads run on the IO dispatcher. Errors expose `ApiError.code`, `status`
  and `message`; every 401 is `ApiError.Unauthorized`. Bearer credentials go only
  to authenticated origin requests or relative proxy transfers, never direct
  external transfers. Redirects are not followed. Download methods return an
  owned `ResponseBody`: consume it on an IO dispatcher and close it with `use`.
- `data.SecureStore.create(context)`: `save`, `read` and `clear` persist or remove
  MK and token together. DataStore contains only authenticated ciphertext wrapped
  by the Android Keystore AES-256-GCM key `pneumo_wrap`, without user authentication.
  JVM callers inject a `KeyWrapper` through the constructor. Never log credentials,
  plaintext, pairing URIs or transfer URLs.

`syncSharedFixtures` copies the frozen shared files into
`app/build/generated/sharedFixtures/crypto/vectors` and
`app/build/generated/sharedFixtures/protocol/fixtures`. Generated resources are
wired into every host-test variant before resource processing and unit tests;
they are not committed.

## Screenshots

The light and dark `@Preview` functions are rendered by `PneumoScreenshotTest`
using Robolectric API 34 native graphics, a fixed 360×800 dp viewport and xhdpi.
Goldens live in `app/src/test/screenshots/debug/`.

Only record when intentionally changing the expected UI:

```sh
mise exec -- apps/android/gradlew -p apps/android recordRoborazziDebug
mise run check:android
```

Review the image changes and say that baselines were recorded in the commit
message. Roborazzi's variant-specific directories are enabled because Gradle 9
requires tasks not to share screenshot output directories. Comparison reports
and lint/JUnit reports stay under `build/`.

## Managed-device smoke test

`e2e:android` runs `pixel6Api34DebugAndroidTest`: Pixel 6, API 34, `aosp-atd`,
with no Google Play Services dependency. Gradle downloads the matching system
image and creates/boots/stops the device. Hardware virtualization must be
available. Run only one Android emulator/managed-device suite at a time on this
Mac. Tests launch `MainActivity` and assert that “Pneumo” is displayed, then exercise
SecureStore with the real Android Keystore, including reopening the wrapper and
clearing both credentials.
