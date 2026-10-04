# Implementation and validation status

Updated: 2026-10-04. Version 0.3.1 implements sound filters, fast seeking, and automatic replay following. Windows execution, current-League integration, and physical timing remain unverified.

## Current behavior

- `GuidedWorkflow` presents setup, recording, track, alignment, and listening tasks. There is no replay-file picker or Start/Stop listening action.
- A chosen recording follows automatically once its track, accepted timing, playable bounds, and a fresh verified viewer are ready. Track audition has separate preview ownership.
- `/replay/game` process ID identifies the viewer. API failures retain the selection; fresh state for the same PID resumes playback. A verified PID change requires choosing a recording again. PID is not proof of match identity, and automatic replay-to-recording lookup is not implemented.
- FFmpeg decodes audio for a hidden Web Audio renderer; mpv supplies native track and timestamp metadata with null output. Radio voice, noise suppression, and sound position share saved settings between the listening screen and Settings.
- Seeking starts with original audio after bounded prefill; suppression prepares independently and fades in at the same source position. Filter edits do not pause playback. Suppression failure leaves original audio playing.
- The fixed-size mute icon preserves the chosen volume and synchronization. Volume, mute, filters, recording/track choices, timing, and other preferences participate in save/retry handling.
- Video alignment uses one consecutive-frame clock tick and applies its midpoint automatically. Failed detection opens the live offset editor. Manual edits survive late analysis, failed saves, and recording switches.
- Schema 6 restores recording/track timing by content identity, including renamed/moved recordings and legacy timing. Power/output recovery retains the association and restores unchanged media before following fresh state.
- Packaging bundles pinned native tools, offline OCR/model assets, and notices. Diagnostic export is bounded and masks local paths by default.

The [architecture and requirements](../../IMPLEMENTATION_PLAN.md) and [UI contract](../../UX_DESIGN.md) describe the current design. [Historical results](HISTORY.md) retain earlier counts and findings separately.

## Latest recorded checks

The full Linux verification run after automatic playback changes passed type checking, the production build, 285 application tests, existing Electron desktop checks, and all 22 connected UI/audio scenarios. Thirteen Windows-only helper tests were explicitly excluded. Cases included automatic startup, mute/unmute, API fault recovery, power/output recovery, verified PID replacement, and persistence. Evidence is retained locally in `release/validation/linux-2026-10-04T14-45-56-246Z/validation.json`.

After the mute icon change, all eight volume UI checks passed in Electron under Xvfb, including unchanged button and slider bounds in both control locations. Packaging reran type checking, all 285 application tests, the production build, and resource checks. Twelve packaging-tool and five validation-tool checks had also passed during the preceding automatic playback work.

The standalone Chromium filter check passed real-model, graph/prototype parity, combined-filter, seek, speed, track-replacement, EOF, suppression-failure fallback, and renderer-control cases before the icon change. This command is separate from `verify:linux` and `validate:windows`; it is not evidence of Windows device behavior.

The most recently verified executable is version 0.3.0, includes source commit `b6da184` and has SHA-256 `d5c6bbda63aafbc810dcb94b0ddada02ae912848bf91e61dacfa8f0794c65b11`. Payload verification matched all 111 extracted files to the staged build/resources and checked both executables' icon resolutions. The executable has not been run on clean Windows. The 0.3.1 version bump has not yet been packaged or verified. Generated reports and binaries are ignored local artifacts, not checked-in release evidence.

## Findings to carry into Windows acceptance

- **Metadata versus audio:** earlier mpv paused-seek and `ao-reload` findings apply to the native adapter and its tests. Production audible seeking uses the Web Audio path; verify that path independently after device changes and interruptions.
- **Media coordinates:** mpv's verified timeline origin remains the canonical coordinate. FFmpeg decoding and OCR must preserve nonzero starts, delayed/shorter audio, codec priming, and VFR timestamps. Generated fixtures do not establish every recorder/demuxer combination.
- **Clock alignment:** half the chosen frame interval describes sampling resolution, not measured HUD/API accuracy. Original POV/replay pairs must establish midpoint accuracy and microphone/picture delay.
- **Viewer identity:** the implementation uses PID alone. Validate League viewer replacement behavior; PID reuse or a different match opened inside an unchanged process is not independently detected.

## Remaining acceptance work

1. Run the [automated Windows workflow](AUTOMATED_WINDOWS.md) in an interactive,
   unelevated desktop session. Validate the exact portable executable offline on a
   clean account without developer tools.
2. Complete the [real-client procedure](WINDOWS.md): API behavior, pause/rate/seek
   following, stale clocks, replay replacement, minimization, and repeated scrubbing.
   Verify the PID-based recording-choice safeguard. Automatic replay-to-recording lookup is not implemented; manual replay selection is outside scope.
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
