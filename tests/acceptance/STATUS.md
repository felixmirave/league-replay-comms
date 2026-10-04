## TypeScript development tooling recorded on 2026-10-04

Linux preparation and command launching now use TypeScript, with a small POSIX
shell bootstrap for machines without Node. Python is not required. A clean runtime
preparation, real HTTPS archive download with pinned checksum, and Node bootstrap
from a verified archive passed. The full Linux workflow passed again: eight
verification-tool tests, 230 Vitest tests, existing desktop checks, and all
20 connected UI/audio scenarios including the supplied recording. Thirteen
Windows helper integration tests remain explicitly excluded. The retained local
report is `release/validation/linux-2026-10-04T01-18-20-252Z/validation.json`;
`prepare-linux.log` in that directory records clean preparation.

## Debian app verification recorded on 2026-10-03

The [development verification workflow](DEV_ENVIRONMENT.md) now runs the production
Electron application with an independent HTTPS replay simulator and captures actual
mpv output from a private PulseAudio virtual device. No corresponding League replay
is required. The local run for version 0.2.1 passed type checking, the production
build, all existing Linux desktop workflows, four verification-tool tests, and
230 Vitest tests. Thirteen Windows PowerShell/handle integration tests were excluded
explicitly. All 20 connected scenarios passed, covering UI operations, track/offset
selection, pause/resume, jumps, speed changes, volume, boundaries, API failures,
replay replacement, persistence, and a supplied recording.

For that recording, captured audio track 3 at a simulated timestamp near 90 seconds
matched independently decoded source samples with 0.996 correlation. The measured
position difference was 6 ms; capture calibration uncertainty was 39 ms. This is
software loopback evidence, not a physical timing result. The run used Debian mpv
0.40.0 and FFmpeg 7.1.5, and explicitly disabled Chromium's OS process sandbox in
this container. Native Windows build parity remains unverified.

The retained local report is
`release/validation/linux-2026-10-03T20-19-13-873Z/validation.json`, with screenshots,
Playwright traces, application logs, timeline, calibration, and captured PCM.
Five existing validation-tooling tests also passed. The packaging-tooling suite
passed ten checks but could not run its two Windows native-payload checks because
`resources/bin/win32-x64` has not been prepared in this worktree.

# Implementation and validation status

Updated: 2026-10-01. Version 0.2.0 implements the guided review workflow and
single-transition video alignment. Windows/current-League acceptance remains open.

## Implemented behavior

- A main-process finite state machine guides setup, connection, recording choice,
  track choice, alignment, and listening. There is no manual replay-file picker.
- Original audio or a POV video's selected audio track follows the Replay API's
  clock, pause state, speed, and seeks. Preview and following have separate ownership.
- Video alignment finds one clock tick between consecutive decoded frames, takes
  their timestamp midpoint, and maps it to the newly displayed game second. It
  supports partial recordings and applies timing automatically without consistency,
  holdout, or phase-calibration gates. Following requires **Start listening**.
- Audio-only recordings and failed top-right clock detection use one live offset.
  Type seconds or use Back/Forward while following League. Opening the editor and
  selecting Done preserve active listening; edits save immediately. Waveform,
  timestamp-pair, and frame/crop controls are removed. Late analysis cannot overwrite
  newer edits. Legacy base offsets and corrections still restore their combined value.
- Schema 6 saves timing by recording SHA-256 and audio track, restores renamed/moved
  files, preserves legacy records, and retains failed edits for retry. Analysis
  version 4 caches the chosen frame pair and invalidates earlier sparse-window caches.
- Replay API setup inspects configuration independently of connectivity. Enable and
  restore operations use byte-preserving edits, backups, version checks, and a scoped
  helper. Windows permission is offered only after a permission failure.
- Process, power, and output recovery stop obsolete audio and restore unchanged
  recordings paused. Diagnostics retain bounded timing context and mask file paths
  by default.
- Portable packaging bundles native playback, decoding, OCR, and notices. Dependency
  preparation and payload verification use pinned checksums.

The [implementation plan](../../IMPLEMENTATION_PLAN.md) defines requirements; the
[UI design](../../UX_DESIGN.md) defines the guided flow.

## Manual timing simplification, 2026-10-01

Local Linux validation passed TypeScript checking, the production build, and 227
Vitest tests with native FFmpeg/ffprobe/mpv enabled (13 optional tests skipped).
Five Electron timing-control tests cover signed input, keyboard/button steps,
stale replies, failed saves, and explicit listening intent; seven volume tests
also passed. The full Electron flow passed import, immediate offset persistence,
failed-detection fallback, successful OCR, retry, restart, rename, and relocation.
The full-window run used null audio output; actual League listening and Windows
acceptance remain open.

## Validation recorded before repository cleanup

These results describe the local Linux development run for version 0.1.1. They are
reported results, not a checked-in release or Windows certification. Reproduce the
checks using the [development commands](../../README.md#checks-and-packaging).

| Check | Recorded result | Limit |
| --- | --- | --- |
| TypeScript and production build | Passed | Does not establish Windows runtime behavior |
| Full Vitest suite with native tools configured | 221 passed, 1 Windows-only test skipped, across 27 files | Linux native tools and synthetic API/config fixtures |
| Real-image OCR regression suite | 29 visible clocks recognized; 2 clock-absent frames rejected | Reviewed development fixtures, not an independent holdout |
| Electron review workflow | Passed setup/restore, preview, track selection, automatic midpoint alignment, manual cancellation, explicit Start, save retry, restart, rename, and relocation | Null audio output; no League client or physical audio measurement |
| Packaging and validation harness tests | 14 passed | Structural/tooling checks |
| Portable payload verification | All 206 extracted files matched the staged build | Executable was not run on Windows |

The [OCR fixtures](../fixtures/ocr/README.md) include original images, expected
readings, hashes, and source provenance. Tests exercise the production decoder,
crop, preprocessing, and offline OCR without overriding expected readings.
The midpoint tests include the 65.030/65.040-second example, subsecond recordings,
late-starting footage, actual adjacent VFR frames, and nonzero timestamp origins.

## Findings to preserve during Windows validation

### Paused seeks

On the tested Linux mpv build, a paused backward seek could retain an old output
delay and report the wrong position. The adapter waits for restart, checks the
reported position, and reloads the audio output once before retrying if necessary.
It does not treat the requested target as a measured position. The regression is
covered in [engine tests](../integration/engine.test.ts). Verify the `ao-reload`
fallback, recovery cost, and audible side effects on the pinned Windows build.

### Media time

Generated MP4/MKV fixtures with video starting at PTS 5 seconds reported different
mpv timeline origins. The adapter reads mpv's origin rather than universally
subtracting ffprobe's format start. Tests cover delayed/shorter audio tracks, VFR,
MP3/AAC/Opus priming, and decoded frame timestamps. These fixture results do not
establish compatibility with every recorder or demuxer.

### Clock alignment

Half the chosen frame interval describes sampling resolution; it is not measured
HUD-to-Replay-API accuracy. Search stops at the first readable adjacent tick, within
its 300-frame / 180-second budget. Original POV/replay pairs are still required to
measure the midpoint assumption, microphone/picture delay, and false readings.

## Remaining acceptance work

1. Run the [automated Windows workflow](AUTOMATED_WINDOWS.md) in an interactive,
   unelevated desktop session. Validate the exact portable executable offline on a
   clean account without developer tools.
2. Complete the [real-client procedure](WINDOWS.md): API behavior, pause/rate/seek
   following, stale clocks, replay replacement, minimization, and repeated scrubbing.
   Automatic replay-to-recording lookup remains omitted until current-client
   identity detection is validated; manual replay selection is outside scope.
3. Exercise original audio/POV recordings with pinned Windows native tools and
   different containers, tracks, frame rates, recording boundaries, and HUD layouts.
4. Validate Windows installation discovery, locks, reparse/handle checks, UAC
   acceptance/decline, config restoration, interrupted writes, and upgrade recovery.
5. Test real sleep/resume, USB/Bluetooth/default-output changes, missing devices,
   player failures, shutdown/logoff, and cleanup after abnormal process termination.
6. Collect independently reviewed [physical timing measurements](TIMING.md). The
   100 ms steady, 150 ms reaction, and 350 ms seek-recovery targets remain unproven.
7. Finish the [native distribution requirements](../../resources/NATIVE_DEPENDENCIES.md),
   corresponding-source and linked-component coverage, and signing preparation.

Generated verification records identify the executable actually tested. Payload
integrity, software loopback, and synthetic tests do not establish physical audible
accuracy or complete these acceptance gates.
