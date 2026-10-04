# League Replay Comms

A Windows companion for listening to original-match comms while reviewing a replay in League. It follows the replay's clock, pause state, speed, and jumps automatically once a recording and its timing are ready.

Version 0.3.1 includes track selection, automatic video-clock alignment, manual timing correction, sound filters, and a saved recording library. Recordings stay on your computer and are opened read-only. The portable development executable is unsigned; Windows/current-League acceptance and physical timing targets remain open. See [current validation status](tests/acceptance/STATUS.md).

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
   end early. **Adjust timing** offers manual corrections; playback starts automatically
   when the recording, selected track, timing, and replay connection are ready.
4. For manual alignment, type **Recording offset (seconds)** or use **Back 0.1 s**
   and **Forward 0.1 s**. A positive offset starts further into the recording; a
   negative offset starts earlier. Arrow keys also adjust the value. Hold Shift
   for 1-second steps or Alt for 0.01-second steps. Changes apply and save immediately.
5. Control playback in League while adjusting the offset by ear. **Done** closes the editor and keeps listening.
   **Adjust timing** reopens it without interrupting an active listening session.
   Brief connection failures recover automatically. A changed League process requires
   choosing a recording for the new replay; saved timing remains available.
   The speaker icon beside volume mutes/unmutes comms while preserving the chosen volume and synchronization. Its tooltip and accessible label describe the action.

**Prepare a recording without League** allows offline offset entry.
**Settings** contains connection details, config backups and guarded restoration,
recording search folders, track selection, clock-detection retry, volume, mute, sound filters, and timing diagnostics.
**Locate recording** verifies the contents of a moved file before restoring timing;
a changed or transcoded recording is treated as a new file.

Library data lives in Electron's per-user application data directory, independently
of the executable. Original recordings are not modified. Schema 6 stores timing by
recording contents and audio track. Upgrades preserve legacy replay associations as
recovery data; conflicting offsets require manual correction. Automatic replay-to-recording lookup is not implemented.

## Sound filters

**Radio voice**, **Noise suppression**, and **Sound position** sit directly below comms volume. Each has a toggle, slider, and short explanation; the same controls appear in Settings → Recording. Values save automatically. Radio strength uses Lighter–Stronger labels without percentages; position uses Left–Right and indicates Center.

Filter edits keep playback running. After a jump, original audio starts after a small prefill while suppression prepares and fades in at the same source position. If suppression fails, original audio keeps playing and a message appears beside the controls. Noise suppression reduces background sound; it cannot isolate particular speakers. The model is bundled locally, with no disk cache or retained prepared audio sections.

## Development

Use Node.js 22.18+ from the 22.x line, or Node.js 23.6+. Windows is the supported application platform. Application code, tooling, and tests use TypeScript; Node scripts use explicit `.ts` imports and erasable syntax. `typecheck` checks the application and scripts.

```sh
npm ci
npm run setup:electron
npm run prepare:native
npm run prepare:ocr
npm run prepare:notices
npm start
```

Preparation downloads checksum-pinned Windows native tools, builds offline OCR assets from locked packages, and collects third-party notices. Packaged runtime resources are local. See [native dependencies](resources/NATIVE_DEPENDENCIES.md) for versions, packaging choices, and outstanding distribution obligations. Regenerate notices when dependencies change.

For the rootless Debian development environment:

```sh
sh scripts/linux.sh --prepare
sh scripts/linux.sh npm run verify:linux
sh scripts/linux.sh npm run dev:verify
```

[Development verification](tests/acceptance/DEV_ENVIRONMENT.md) describes real recording input, the HTTPS replay simulator, captured audio, individual test prerequisites, and interactive controls. Linux output evidence does not establish Windows or real-League behavior.

## Checks and packaging

| Command | Purpose |
| --- | --- |
| `npm run check` | Type checks, application tests including the 31-image OCR corpus, and production build |
| `npm run test:packaging` / `npm run test:validation` | Packaging and validation-tool regression checks |
| `npm run test:engine` | Native mpv timeline/adapter checks with null output |
| `npm run smoke:ui` / `npm run smoke:driver` | Real Electron startup and automation attachment |
| `npm run test:startup-ui` / `npm run test:review-ui` | Startup lifecycle and recording/persistence workflows |
| `npm run test:volume-ui` / `npm run test:timing-ui` | Real renderer controls, delayed replies, save failures, mute layout and live timing |
| `npm run test:filters-browser` | Separate Chromium model/filter/seek/control checks |
| `npm run package:win` | Required checks, resource integrity, and Windows portable packaging |
| `npm run verify:artifact` | Embedded icons and exact extracted-payload comparison against the staged build |
| `npm run validate:windows` | Automated build and source/portable desktop workflows on Windows |

UI checks require a display; native/OCR checks require prepared resources. Details and overrides are in [development verification](tests/acceptance/DEV_ENVIRONMENT.md#individual-checks-and-prerequisites). Packaging writes `release/LeagueReplayComms-0.3.1-x64.exe`; artifact verification writes checksum and payload records beside it. These records do not establish Windows execution or physical audio accuracy.

Run Windows validation from an unelevated interactive desktop. The [Windows automation guide](tests/acceptance/AUTOMATED_WINDOWS.md) documents stages, isolation, packaging details, and artwork maintenance. Browser filter verification is separate from both automated Windows and Linux pipelines.

For the browser filter check, install a Playwright-compatible Chromium or set `COMMS_CHROMIUM_EXECUTABLE`; `COMMS_FFMPEG` overrides the decoder. `node scripts/benchmark-audio-seek.ts` measures seek preparation and first rendered sound in generated recordings, with suppression off/on. `COMMS_SEEK_REPORT` saves JSON; use the same Chromium/FFmpeg overrides. These measurements exclude League observation latency and physical output.

## Documentation

- [Architecture, scope, and acceptance requirements](IMPLEMENTATION_PLAN.md)
- [Guided UI contract](UX_DESIGN.md)
- [Current validation status](tests/acceptance/STATUS.md) and [historical evidence](tests/acceptance/HISTORY.md)
- [Windows real-client acceptance](tests/acceptance/WINDOWS.md), including bounded diagnostic exports with paths masked by default
- [Independent timing measurements](tests/acceptance/TIMING.md)
