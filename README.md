# League Replay Comms

Review a League of Legends match with your team's original voice comms. This Windows app plays audio from a recording alongside League's replay viewer, following its pauses, speed changes, and jumps.

Recordings stay on your computer and are opened read-only. Track choices and timing are saved for future reviews.

**Development status:** Real-League integration, clean-Windows execution, and timing accuracy on physical audio devices remain unverified. See the [validation status](tests/acceptance/STATUS.md).

## Run on Windows

Download the Windows x64 executable from the [latest release](https://github.com/felixmirave/league-replay-comms/releases/latest) and run it. The portable `.exe` includes all runtime dependencies; no installation or compilation is required.

Playback, clock detection, and sound processing run locally.

## Review a match

You need League installed, a replay you can open in League, and an audio or video recording containing comms from the same match. Use a continuous recording; cuts, pauses during the original match, or timing drift can break alignment.

1. **Connect to League.** Choose your League folder if prompted, then select **Enable replay connection**. The app backs up League's `game.cfg` before enabling replay access. Open a replay from League's match history, or restart it if it was already open.
2. **Choose the recording.** Select **Choose recording**, drop a file onto the recording prompt, or reopen a recent recording. If it contains multiple audio tracks, preview them and choose the comms track.
3. **Set the timing.** For video, the app tries to read the game clock in the top-right corner. For audio-only recordings or failed detection, use **Adjust timing** to enter a recording offset or nudge it with **Back 0.1 s** / **Forward 0.1 s**. Changes apply and save immediately; select **Done** when ready.
4. **Review in League.** Comms play automatically once the connection, recording, and timing are ready. Control playback in League. Supported speeds are **0.5×–2×**; comms are silent outside that range or outside the recorded portion of the match.

The offset is the recording time minus the game time. For example, if game time `5:00` occurs at recording time `6:30`, enter `90` seconds. You can reopen **Adjust timing** while listening to correct it by ear.

Volume, mute, **Radio voice**, **Noise suppression**, and **Sound position** are available while listening. Noise suppression reduces background sound; it cannot isolate individual speakers.

## If something needs fixing

- **Replay not detected:** reopen the replay, then use **Connection help** or **Settings → Replay connection setup** to check the selected installation.
- **Comms out of sync:** use **Adjust timing**. A positive offset moves further into the recording; a negative offset moves earlier.
- **Recording moved:** use **Locate recording** to restore saved timing from the unchanged file.

## Development

The app uses TypeScript, Electron, and React, with FFmpeg, mpv, and Tesseract.js for media and clock detection.

To build and run from source on Windows x64, use Git and Node.js **22.18+ on the 22.x line**, or **23.6+**:

```sh
git clone https://github.com/felixmirave/league-replay-comms.git
cd league-replay-comms
npm ci
npm run setup:electron
npm run prepare:native
npm run prepare:ocr
npm run prepare:notices
npm start
```

Setup downloads dependencies and prepares the media tools, clock detection, and third-party notices.

| Command | Purpose |
| --- | --- |
| `npm run check` | Type checks, application tests, and production build |
| `npm run package:win` | Build an unsigned portable executable in `release/` |
| `npm run validate:windows` | Run automated Windows desktop validation |

Linux is a development and verification environment. See [Debian setup and verification](tests/acceptance/DEV_ENVIRONMENT.md) for its separate preparation steps.

- [Architecture and scope](IMPLEMENTATION_PLAN.md) · [UI design](UX_DESIGN.md)
- [Windows validation guide](tests/acceptance/AUTOMATED_WINDOWS.md) · [Real-League acceptance](tests/acceptance/WINDOWS.md)
- [Bundled dependencies and distribution requirements](resources/NATIVE_DEPENDENCIES.md)
