# League Replay Comms

A Windows companion for listening to original-match comms while reviewing a replay
in League. The application follows the replay's clock, pause state, speed, and seeks.

Implementation is in progress. The application supports media preview, audio-track
selection, a single live timing offset, replay following, diagnostic export, and a
saved recording library. Background content hashing restores track and timing after
recording renames or moves to known/configured folders. Automatic video alignment
uses the midpoint between consecutive frames where the game timer advances one
second, and applies that offset automatically. Partial recordings are supported;
no start/end-of-match footage, consistency checks or phase profile is required.
Manual correction remains available. The guided setup
detects configuration, enables the Replay API with a backup, and restores an
unchanged configuration from that backup. Windows elevation is requested only
after a permission failure. Windows/UAC behavior and timing targets have not yet
been validated against League.

Media import probes audio/video streams and preserves their timestamp origins.
When track duration is missing, a cancellable background packet scan determines
audio bounds while preview remains available. Probed information is cached with
the recording identity; following stays silent outside the selected track.
Automatic detection reads the game clock in the top-right corner of the video.
If it cannot read a usable clock tick, the app opens manual alignment directly.
Type an offset or move the recording back/forward while listening alongside League.
For videos, **Adjust timing → Detect offset from video clock** retries automatic alignment.
There are no waveform, timestamp-pair, or clock-region selection steps. The selected
pair of clock frames is cached by recording contents; its midpoint is recomputed when reused.

Unsaved alignment changes remain attached to their recording and audio track when
you switch views. Recording/track choices, volume, media
folders, and installation selection also retain failed saves for retry. A saved
recording and track can be restored before an alignment has been set; following
still requires alignment. If a save fails, retry pending changes from the review
window. Closing first drains accepted edits and tries saving again; remaining
errors offer retry, cancel, or explicit discard. Cancelling close keeps audio paused.
If closing interrupts recording identification, reopening the app resumes
the unfinished import at its unchanged original path, including its track and
manual edits. A changed or missing file requires explicit reopening.

System interruption recovery stops the old player and reloads the unchanged
recording paused with its selected track and volume. Saved alignment is retained;
select **Start listening** again before following. **Retry playback** also restarts the
player. Output changes also stop and replace the player, preserving the recording,
track, volume, and saved offset. Preview returns paused; following must obtain a
fresh replay clock and verified seek. Repeated output failures stop automatic
retries. Diagnostics show the reported driver and configured device selection.
Real Windows sleep, device changes, and physical audio timing remain acceptance
requirements.

See [the implementation plan](IMPLEMENTATION_PLAN.md) and
[current validation results](tests/acceptance/STATUS.md).

## Development

Use Node.js 22.18+ from the 22.x line, or Node.js 23.6+. Windows is the supported
application platform.

Application code, tooling, and tests use TypeScript. Node runs the scripts in
`scripts/` directly; use explicit `.ts` extensions for their local runtime imports
and erasable type syntax. `npm run typecheck` checks both the application and
scripts. Electron test entry points in `scripts/fixtures/` are checked with the
application and bundled to JavaScript before launch.

```sh
npm ci
npm run setup:electron
npm run prepare:native
npm run prepare:ocr
npm run prepare:notices
npm start
```

`prepare:native` downloads pinned Windows mpv, FFmpeg/ffprobe, and Vulkan-loader archives, verifies
their checksums, and extracts them into ignored resource directories. This is a
developer build step; the packaged application uses local bundled executables.
FFmpeg and ffprobe share seven bundled DLLs; mpv uses the smaller upstream MSVC
build. Exact versions, build sources, and packaging choices are documented in
[Native dependencies](resources/NATIVE_DEPENDENCIES.md).
`prepare:ocr` builds the local clock worker and copies its WASM and language data
from the locked npm packages. OCR never downloads a model at runtime.
`prepare:notices` collects full license texts from production npm packages and
checksum-pinned upstream sources, then creates an offline **Third-party notices**
page accessible from the application. It retains provenance qualifications and
known source-coverage gaps. A changed dependency requires regenerating notices;
changes to audited upstream bundles also require updating their pinned manifest.

## Checks and packaging

```sh
npm run check
npm run test:packaging
npm run test:engine
npm run smoke:ui
npm run test:startup-ui
npm run test:volume-ui
npm run test:timing-ui
npm run smoke:driver
npm run test:review-ui
npm run package:win
npm run verify:artifact
```

`check` performs TypeScript checks, deterministic tests, and the production build.
It includes the [reviewed screenshot corpus](tests/fixtures/ocr/README.md#real-images)
through the production clock crop/OCR. This requires prepared OCR resources and
FFmpeg: the bundled executable on Windows, or `COMMS_TEST_FFMPEG` / `ffmpeg` on Linux.
Run just these 31 cases with `npm run test:ocr-corpus`.
The real-engine test is skipped by the default suite unless `COMMS_TEST_MPV` is set.
`test:engine` requires a real mpv and defaults to the prepared Windows executable;
it uses null audio output to verify engine behavior, not physical audible timing.
`smoke:ui` launches the real Electron application and requires a desktop session.
`test:review-ui` additionally exercises real mpv with null output, the hash worker,
saved manual alignment, restart, rename detection, and folder-based relocation.
Both UI tests use isolated temporary library directories. They do not test League
or physical audio output.
`test:volume-ui` runs the renderer in Electron with controlled desktop responses
and requires a desktop session. It checks pointer and keyboard volume changes
across replay-clock updates, delayed replies, and failed saves in both controls.
`test:startup-ui` holds initialization I/O in the real Electron app to check that
the loading window appears first, errors replace it, and closing during startup
exits cleanly. It also requires a desktop session.
When `COMMS_TEST_FFMPEG` is provided (or bundled FFmpeg is available on Windows),
the review test also imports a generated POV video, resolves missing track timing
in the background, verifies cached timing, and edits a single offset after failed
detection. `test:timing-ui` checks live controls, partial signed input, stale replies,
save failures, and explicit listening intent in the real renderer. With prepared OCR resources, it also
reads a generated top-right clock, cancels an analysis through a manual edit,
re-runs detection, and checks automatic midpoint alignment and saved timing
restoration after rename.
It also blocks a library write, cancels a window-close attempt with unsaved changes,
then restores the destination and verifies successful saving.
Setup checks use a synthetic installation to verify config detection and refresh
independently of replay connectivity. On Windows, or when `COMMS_TEST_POWERSHELL`
points to a test PowerShell executable, the helper integration tests exercise
actual config edits, backups, restore, sharing conflicts, and stale-file rejection.
The desktop workflow also exercises enable/restore through the real helper.
Actual Windows discovery, handle checks, and elevation remain separate gates.

The portable executable is generated under `release/`. This development artifact
is unsigned and is not a completed public release. Packaging refuses missing or
modified native resources. Public distribution and Windows acceptance gates remain
in [the plan](IMPLEMENTATION_PLAN.md).

The portable launcher shows **Starting…** while extracting the app. Once Electron
starts, the main window shows an animated loading indicator while the library and
services initialize. The launcher splash closes before Electron starts, so a brief
gap between the two windows is possible. Edit `build/splash.svg` and run
`npm run prepare:splash` in a desktop session to regenerate the checked-in bitmap;
ordinary builds use that bitmap without needing image conversion or a desktop.
The replay-headset artwork is shared by the splash and app header through
`src/renderer/public/icon.png` (256×256). `build/icon.ico` contains the Windows
sizes from 16 to 256 pixels and supplies both executable icons and the running
window's icon. Windows resource editing stays enabled; only code signing is
disabled. Regenerate the splash bitmap after changing the PNG.

Release builds minify the main process and workers and omit source maps and npm
packages already compiled into `dist`. The portable payload keeps English Electron
locales, Node OCR cores with all SIMD fallbacks, and native license/build notices.
Browser OCR bundles, upstream manuals, and installer examples are omitted. A pack
hook removes Electron's duplicate Chromium notices only after checking that the
copy linked from the offline notices page is identical.

`verify:artifact` checks both executables' embedded icon resolutions and the staged
app against the current build/resources, then extracts the portable executable's
embedded archive into a temporary directory.
It compares every extracted file with the staged build, including runtime libraries
and notices, and removes the temporary copy. Verification needs roughly 1 GiB of
additional disk space for the current payload. It writes SHA-256 and verification
records beside the executable; neither record establishes Windows execution or
audible accuracy.

For the complete automated Windows build and desktop validation, use
`npm run validate:windows` from an unelevated interactive desktop session. It
produces per-stage logs and checksum-bound reports under `release/validation/`,
then tests the actual portable executable with an isolated profile. See the
[Windows automation guide](tests/acceptance/AUTOMATED_WINDOWS.md) for runner
requirements, covered cases, and the separate real-client/audio gates.
The [timing measurement tools](tests/acceptance/TIMING.md) generate a known marker
recording and summarize independent capture annotations, including uncertainty,
failed responses, and muted time. They do not infer physical accuracy from player
command acknowledgments.

[Diagnostic traces](tests/acceptance/WINDOWS.md#diagnostic-traces) include controller
state, active timing context, and explicit retention limits. Export masks local
file paths by default; the diagnostics panel offers explicit path inclusion.
Resource verification checks x64 PE imports and local DLL exports, including mpv's
Vulkan loader, so startup does not rely on an extra graphics-runtime installation
or the launch directory. This structural check does not replace Windows execution.
The dependency-check regression tests run with
`node --test scripts/windows-native.test.ts` after native preparation.

Packaging stages the application and compresses the portable executable in separate
processes to bound memory use. `verify:artifact` checks the current staged modules
and native digests and writes the executable's SHA-256 file. It does not substitute
for running that executable on Windows.

For Linux development, pure tests and builds work without a desktop. Set
`COMMS_TEST_MPV` to an available Linux mpv to run the engine test. Running the UI also
requires Electron's Linux libraries and a display; Linux application distribution
is not a product target.
Set `COMMS_TEST_FFMPEG` and `COMMS_TEST_FFPROBE` as well to include generated media
timeline fixtures in `test:engine`. Windows defaults to the prepared bundled tools.

## Verification in a Debian development environment

Run the actual app with a controllable HTTPS replay simulator and captured virtual
audio output, including UI actions, pause/seek/speed changes and source-sample checks:

```sh
sh scripts/linux.sh --prepare
sh scripts/linux.sh npm run verify:linux
sh scripts/linux.sh npm run dev:verify
```

See [development verification](tests/acceptance/DEV_ENVIRONMENT.md) for real recording
input, interactive agent controls, retained evidence, rootless setup and limits.

## Review workflow

The window shows one current task and its primary action. Settings and diagnostics
are secondary; there is no replay-file picker or replay confirmation step.

1. If needed, choose your League folder and select **Enable replay connection**.
   The app backs up `game.cfg` before enabling `EnableReplayApi` under `[General]`.
   It offers Windows permission only after a permission failure. Open or restart
   a replay in League; the app detects the connection automatically.
2. **Choose recording**, drop an audio/video file, or reopen a recent recording.
   Saved track and timing are restored by content hash, including after a rename.
   Choose the comms track only when multiple tracks need a choice.
3. For video, the app reads the game clock in the top-right corner. If detection
   fails, it opens **Adjust timing** for manual alignment.
   A readable tick automatically sets the timing. Recordings can start late or
   end early. **Adjust timing** offers manual corrections; playback starts only
   when you select **Start listening**.
4. For manual alignment, type **Recording offset (seconds)** or use **Back 0.1 s**
   and **Forward 0.1 s**. A positive offset starts further into the recording; a
   negative offset starts earlier. Arrow keys also adjust the value. Hold Shift
   for 1-second steps or Alt for 0.01-second steps. Changes apply and save immediately.
5. Select **Start listening** in the editor, then control playback in League while
   adjusting the offset by ear. **Done** closes the editor and keeps listening.
   **Adjust timing** reopens it without interrupting an active listening session.
   A changed replay connection requires another explicit start; the offset survives.

**Prepare a recording without League** allows offline offset entry.
**Settings** contains connection details, config backups and guarded restoration,
recording search folders, track selection, clock-detection retry, volume, and timing diagnostics.
**Locate recording** verifies the contents of a moved file before restoring timing;
a changed or transcoded recording is treated as a new file.

Library data lives in Electron's per-user application data directory, independently
of the executable. Original recordings are not modified. Schema 6 stores timing by
recording contents and audio track. Upgrades preserve legacy replay associations as
recovery data; conflicting offsets require manual correction. Automatic replay-to-
recording lookup is omitted until current-client identification is validated.

See [validation status](tests/acceptance/STATUS.md) for build evidence and remaining
Windows/current-League checks.
