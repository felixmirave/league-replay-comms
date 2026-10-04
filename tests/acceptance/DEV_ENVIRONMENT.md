# Verification in the Debian development environment

This workflow runs the production Electron main process, preload, renderer, utility
workers, synchronization controller, library, hashing, OCR, and media adapters.
An independent HTTPS server supplies Replay API timestamps and controls. A private
PulseAudio server routes real Electron Web Audio output to a virtual device whose monitor is
captured as PCM. No League replay file or running League client is needed.

## Prepare and run

The rootless runtime requires Debian 13 x86_64, curl, sha256sum, tar, dpkg-deb, OpenSSL,
and the usual Debian base tools. It downloads Node 22.18.0 and Debian archives
from the SHA-256-pinned `scripts/linux-runtime-lock.json`, extracts them into
`.cache/linux`, installs locked npm dependencies, and prepares Electron, OCR and offline notices.
A small POSIX shell bootstrap obtains the pinned Node executable when Node is
not installed. Runtime preparation, checksum verification, downloads, and command
launching are implemented in TypeScript using Node’s built-in APIs; Python is not
required. With Node 22.18.0 already available, the TypeScript entry points can also be run
directly: `node scripts/prepare-linux.ts` and
`node scripts/linux-run.ts COMMAND [ARGUMENTS…]`.
No sudo or system package installation is required. Stop development sessions
before re-preparing the extracted runtime. Allow approximately 2 GiB
for runtime, npm packages, media fixtures, and retained evidence.

```sh
sh scripts/linux.sh --prepare
sh scripts/linux.sh npm run verify:linux
```

In containers where Chromium's process sandbox cannot initialize, explicitly use:

```sh
COMMS_TEST_NO_SANDBOX=1 sh scripts/linux.sh npm run verify:linux
```

This disables Chromium's OS process sandbox for this development run; the app's
renderer isolation settings stay in use. Ordinary desktop runs should use the
first command. The verification report records this option.

The bundled development tools are Debian mpv 0.40.0 and FFmpeg 7.1.5, whereas the
Windows manifest currently uses mpv 0.41.0 and FFmpeg 9.0.2. The application code
is shared; native decoder/build parity is not established. Versions and lock
hashes are recorded in every run. Windows uses named pipes; Linux uses Unix
sockets for the same mpv JSON IPC protocol.

For rootless Xvfb, preparation creates a local copy with its hardcoded xkbcomp
lookup relocated to `./bin` and a wrapper that runs it from the extracted `usr`
directory. The original downloaded archive remains checksum verified. This only
changes the development display tool, not application code.

## Use a real recording

Recordings stay outside Git and are opened read-only. They need not live in this
worktree; an absolute path into the main checkout works:

```sh
sh scripts/linux.sh npm run verify:linux -- \
  --recording '/path/to/main/recordings/recording.mp4' --track 3 --at 90
```

`--track` is the one-based audio-track order, matching the app's radio buttons;
`--at` is a recording timestamp in seconds. Choose an audible segment. A silent
segment fails with a request to choose audible material, rather than reporting an
unsubstantiated pass. The real-recording case compares captured PCM at 1x with
independently FFmpeg-decoded source samples, allowing volume differences. It
verifies playback against the simulated replay time, not real-match alignment.
Synthetic coded recordings cover the other speeds and boundary cases.

## What automated verification does

The command checks prerequisites, runs type checking, verification-tool regression
tests, the full Vitest suite with real media tools, the production build, and the
existing Electron startup, timing, volume, review and driver workflows. It then
runs connected UI/audio scenarios: track selection, saved offset, explicit Start,
pause/resume, forward/backward seek, 2x and 0.5x playback, volume, recording bounds,
negative offset, Replay API failures/recovery, replay replacement, and restart. Review recovery checks interrupt the Web Audio context and verify restoration of the audible volume, selected track, and alignment.

The native file picker supplies a chosen path through Playwright; the app's
import, track choice, editing and listening controls are operated in the actual
window. Packaged builds ignore the development Replay API configuration.
The simulator uses HTTPS and a session certificate, keeping certificate validation,
network requests, JSON parsing, deadlines and controller behavior active.

Each run records native versions, dependency/build hashes and explicit Windows
helper skips in `release/validation/linux-*/validation.json`, alongside stage logs and
Vitest results. Connected scenarios retain screenshots, Playwright traces,
application diagnostics, the simulator timeline/request log, calibration,
scenario results and `output.s16le` (48 kHz mono signed little-endian 16-bit PCM).
A failed stage stops later work and preserves its evidence. Cleanup errors fail
verification. Generated media and reports are ignored by Git.

To listen to a capture or turn it into a shareable WAV:

```sh
sh scripts/linux.sh ffmpeg -f s16le -ar 48000 -ac 1 \
  -i /path/to/output.s16le /path/to/output.wav
```

## Interactive agent session

```sh
sh scripts/linux.sh npm run dev:verify
```

This builds and starts the actual app, display, virtual output/capture and replay
simulator. It prints a loopback control URL and evidence directory. The same
session is accessible to an agent through HTTP; no alternate app backend is used.
Replace the example URL with the printed value:

```sh
curl http://127.0.0.1:PORT/app
curl http://127.0.0.1:PORT/state
curl -H 'content-type: application/json' -d '{"time":90,"paused":false,"speed":2}' http://127.0.0.1:PORT/control
curl -H 'content-type: application/json' -d '{"action":"choose-file","path":"/absolute/recording.mp4"}' http://127.0.0.1:PORT/app/action
curl -H 'content-type: application/json' -d '{"action":"click","name":"Choose recording"}' http://127.0.0.1:PORT/app/action
curl -H 'content-type: application/json' -d '{"action":"track","ordinal":3}' http://127.0.0.1:PORT/app/action
curl -H 'content-type: application/json' -d '{"action":"click","name":"Use this track"}' http://127.0.0.1:PORT/app/action
curl -H 'content-type: application/json' -d '{"action":"fill","label":"Recording offset (seconds)","value":"0"}' http://127.0.0.1:PORT/app/action
curl -H 'content-type: application/json' -d '{"action":"screenshot","name":"current"}' http://127.0.0.1:PORT/app/action
curl -H 'content-type: application/json' -d '{}' http://127.0.0.1:PORT/stop
```

`click` targets exact button names. Other actions are `volume` with integer `value`
0–100, and the actions above. Replay controls accept `time`, `paused`, `speed`,
`seeking`, `length`, `processID`, `fault`, and `delayMs`. Fault values are `none`,
`offline`, `delay`, `json`, `schema`, `oversize`, and `http`. Setting `seeking=true`
holds the simulated clock until a subsequent `seeking=false` control.

Ctrl+C also closes the session. Captures are capped at 128 MiB (about 23 minutes);
start a fresh session for longer investigations. Screenshots and captures let
agents inspect output; an interactive session itself does not assert correctness.

## Audio evidence and remaining Windows checks

The analyzer identifies the source track and position from unique tone codes every
125 ms, independently of the app's clocks. Three external paplay signals calibrate
the capture mapping; reports include latency and uncertainty. Steady sample
position tolerance is 220 ms plus measured uncertainty, with at least 90% matching
frames and 98% audible frames. These are development regression thresholds, not
certification of the application's physical timing targets. Seek scenarios require five consecutive matching capture windows within a 1.5 s
development recovery budget; they do not certify the 350 ms product recovery target.

Null-output tests remain useful for engine behavior, but the connected scenarios
require real Web Audio output routed through PulseAudio and inspect captured
samples. Timing fixtures disable speech filters through the app controls because
those filters intentionally attenuate the tone codes; filter behavior has separate
model/graph regression coverage. The tone decoder recognizes a transition only
when both halves independently identify adjacent codes on the same track. Timing,
audibility, and silence thresholds remain unchanged. Filter regression checks also
inject a suppression-worker failure and require original audio to keep playing.
A virtual sink does not establish Windows WASAPI behavior, Bluetooth/headphone latency or
physical sound delivery. Windows installation discovery, UAC, protected handle
checks, real sleep/hotplug, and portable executable execution remain in the
existing Windows acceptance workflow. The existing PowerShell helper tests can
also run on Linux if `COMMS_TEST_POWERSHELL` points to an installed pwsh; the
rootless runtime does not include PowerShell.
