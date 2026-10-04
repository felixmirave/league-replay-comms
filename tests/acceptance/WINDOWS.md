# Windows application acceptance

This procedure checks the current application on Windows and against real League replays. It does not certify the completed
application or establish physical audible accuracy by itself.

The [automated Windows workflow](AUTOMATED_WINDOWS.md) builds and checks the exact
portable artifact on a developer runner. Run this manual procedure separately on
the clean test account and with the real League client and physical output setup.

## Prerequisites

- A supported Windows x64 machine, current League client, and compatible replay.
- The corresponding uninterrupted original-match recording containing comms.
- A portable executable built from the current source, its SHA-256 file, and the
  `.verification.json` record produced by `npm run verify:artifact`. Compare that
  record's artifact digest with the executable being tested. Embedded-payload
  comparison is required before this procedure and does not replace execution.
- A known matching event to establish an initial manual anchor.

Record Windows version, League patch, application version/checksum, recording container
and codec, audio device, connection type (wired/Bluetooth), and display refresh rate.
Do not install Node, npm, Python, mpv, or FFmpeg on the clean test account.

## Startup and playback

Verify metadata mpv startup and audible FFmpeg/Web Audio playback from an unrelated working directory on a clean Windows machine without a separately installed Vulkan runtime. Its pinned loader must resolve from
the native-tool directory. Exercise audio-from-video loading, seeks and rates with
the optional renamed D3D compiler absent. Passing the PE dependency check alone
does not establish successful Windows startup or audio output.

1. Launch the executable as a standard user with network access unavailable for
   dependency downloads. Confirm the window opens without a runtime installation.
   Check a cold launch: the **Starting…** splash must appear during extraction,
   followed by the main window's loading indicator if initialization is still
   running. Record the time to first feedback and any gap between the windows.
   Verify the splash is centered and readable at 100%, 150%, and 200% display
   scaling. Confirm the replay-headset icon appears on the portable EXE in
   Explorer (small and large icons), the running taskbar button, the title bar,
   and Alt+Tab, and matches the logo on both startup screens and the app header.
   Close the main window during startup and confirm the process exits
   without reopening a window; launch again and confirm normal operation.
2. Follow the current setup task. Verify detected installations and choose the
   correct one, including a custom drive or multiple installations. If detection
   fails, use **Choose League folder**. Select **Enable replay connection** for the
   displayed config path, confirm the backup appears, and restart the replay.
   Configuration being enabled must not falsely report a live connection when no
   replay is open. Manual instructions remain available if automatic editing fails.
3. Open a replay in League and wait for automatic connection. Choose the original recording,
   including a filename with spaces or non-ASCII text.
   Preview each relevant audio track and select the comms track.
4. Open **Adjust timing**. Playback starts automatically when timing is valid. Type an offset or use
   **Back 0.1 s** / **Forward 0.1 s** while watching League. Verify that Back moves
   the recording backward and Forward moves it forward. Check Shift (1 s), Alt
   (0.01 s), and arrow-key steps. **Done** and reopening the editor must keep listening.
5. Exercise the matrix below. Export timing traces after each group rather than
   expecting the bounded in-memory trace to retain an entire match.

| Action in League | Required observation |
| --- | --- |
| Play at 1× | Comms follow without periodic skips or accumulating drift |
| Pause/resume | Audio stops/resumes with the replay |
| Set 0.5× and 2× | Audio follows rate with pitch preserved |
| Set higher navigation speed | The app reports unsupported speed and suppresses audio |
| Seek forward/backward, including under two seconds | Audio recovers to the corresponding moment |
| Seek while paused | Audio stays paused at the new position |
| Rapidly scrub between distant points | Intermediate targets do not resume obsolete audio |
| Seek outside recorded coverage | Silence and an outside-recording status |
| Minimize the companion and foreground League | Following continues |
| Stop/restart the replay | Audio stops; a changed process ID requires choosing a recording for the new viewer |
| Sleep/hibernate, then resume | The old player stops; unchanged recording/track/volume/mute and alignment survive; the same verified viewer resumes automatically |
| Resume while opening/seeking, or repeat transitions | Obsolete commands/completions cannot restart output; recovery is bounded and can be retried |
| Select Retry audio after media-process failure | The player restarts; restore track, volume, mute, and timing, then resume automatically after a fresh verified connection |
| Change the default output while both devices remain connected | The old player stops; selected track/volume/offset survive; preview stays paused, and following requires a fresh clock and verified seek |
| Unplug/reconnect USB or Bluetooth output, or change its format | Missing output stays silent; successful replacement restores the selected stream, while failed restoration offers Retry audio |
| Trigger repeated output failures | Automatic replacements are bounded; no recurring playback/restart loop; deliberate retry remains available |
| Change output during a seek or track selection | Obsolete position/completion cannot resume playback; the selected stream is verified before recovery completes |
| Reach recording EOF, then seek backward in League | Comms resume at the corresponding recording position without an output-recovery loop |
| Terminate the companion or its sync process | The hidden audio renderer and owned native children stop; no indefinite orphan audio |

## Sound filters and mute

Use audible speech with background noise, not only synthetic timing tones. Record filter settings and output hardware with each result.

1. Verify **Radio voice**, **Noise suppression**, and **Sound position** appear directly below volume and in Settings → Recording, with matching values in both locations. Each has a toggle, slider, and short explanation. Disabled sliders retain their values; radio strength shows Lighter–Stronger without percentages.
2. In a fresh profile, verify radio and suppression are enabled at their defaults and sound position is disabled. Exercise both slider endpoints and the default values in `src/shared/filters.ts`. Check left/right direction and the Center indication.
3. Listen with each filter separately and all combinations. Check for echo, reverberation, clipping, or unexpected level changes; radio includes a fixed +12 dB gain with output compression. Repeat at 0.5×, 1×, and 2×.
4. Change suppression amount during steady playback. The listening screen must remain available and original audio must keep playing while suppression prepares. Seek to distant positions with suppression off and on: original audio resumes after prefill, then suppression fades in at the same source position. Measure recovery separately from filter warm-up.
5. On the developer runner, run `npm run test:filters-browser` for the controlled suppression-worker failure case: it verifies rendered original audio continues and the suppression error is reported. On the packaged app, check the local filter message if an actual suppression failure occurs. Keep browser regression evidence separate from Windows physical-output observations.
6. Toggle the speaker icon beside volume with mouse and keyboard in both locations. Verify **Mute comms**/**Unmute comms** tooltips and accessible labels, pressed state, and fixed 40 × 40 px button dimensions. The button and slider must not move when toggled. Muting leaves synchronization active; unmuting restores the chosen volume at the current replay position.
7. Change volume while muted, then unmute. Verify the new volume is used. Restart and exercise API, power, and output recovery; the selected volume, mute flag and filters must survive. Include mute/filter changes in the unwritable-library save/retry tests below.

The standalone browser filter check is useful regression evidence but does not certify Windows device behavior or physical timing. It is not part of `validate:windows`.

## Saved reviews and media import

1. Set a manual offset and adjust it by 10 ms; select another audio track and set a
   different offset. Check that switching tracks restores their individual values.
2. Close/reopen the app and reopen the recent recording. Verify recording, selected
   track, effective offset, volume, mute, and sound filters.
3. Rename the recording in its current folder and repeat. Then move it elsewhere;
   verify **Locate recording** and **Add media folder**, including a different file with
   the same name and size that must not inherit the saved alignment.
4. Edit alignment while hashing and audio-timing analysis are running. Check that
   completion retains the edit. Switch recordings during analysis and confirm a
   late result cannot affect the new recording.
5. Repeat with audio-only files and MP4/MKV POV recordings, including several audio
   tracks, leading video without comms, and an audio track shorter than the video.
   Check reported audio bounds and silence outside them. Unknown timing must show
   analysis progress or an actionable error; it must not fabricate a zero timestamp.
6. With League disconnected, enter a signed offset. Verify that Done saves and returns to offline review, and reopening restores it.
   Connect to League; playback must begin automatically after verifying the viewer PID.
7. Type a partial negative value and change it while replay clocks update. Rapidly
   click Back/Forward, then leave or close the app. The newest valid edit must
   persist. Slow saves must not reset input, move the controls, or flash warnings.
   Check nonzero stream starts and switching recordings/tracks. No waveform,
   recording scrubber, timestamp pairs, or video/crop controls should appear.
8. Read a video's top-right game clock. With an unreadable or hidden clock, or a
   decoding/OCR failure, the app must open **Adjust timing** directly. Enter and
   save a manual anchor. Retry detection and cancel during decoding or recognition. Change the offset while analysis runs; a late result
   must retain the edit. Re-run while aligned and check that failure retains it.
   A successful reading must apply the consecutive-frame midpoint automatically,
   including for late-starting or early-ending clips. Following starts automatically when the chosen track, bounds, and fresh verified replay are ready; it stays silent when League is paused or disconnected.
   Use the exact executable with network access unavailable to test local OCR assets.
9. Restart after a successful clock reading, rename the video, and reopen it. Verify
   its saved automatic timing is restored. Explicit **Read game clock again**
   must run a fresh analysis. Test loading/postgame footage and short clips. After
   one readable adjacent tick is found, the reader must stop without checking
   later clocks for consistency. Confirm manual timing corrections still work.
10. In a disposable test profile, make the library destination unwritable. Enter
    distinct offsets for two tracks, switch recordings/replays, and verify the
    unsaved count remains visible. Restore write access and retry; reopen to verify
    every offset. Repeat while media identification is pending.
11. With a save failure active, close the window. Verify audio pauses, new edit
    requests are rejected, and the retry/cancel/discard decision appears. Cancel,
    restore write access, and retry saving. Separately verify successful retry on
    exit, explicit discard, and closing immediately after accepting an edit. The
    last committed library must remain valid after all cases.
12. Select a recording and a different audio track without setting an alignment.
    Restart and rename/move the recording: the selected track must return while
    following still requires an alignment. Manually reopen a renamed recording
    and verify hash completion restores its saved track without overriding a
    newer manual choice. Upgrade disposable libraries from versions 1–5 and check
    that existing offsets, corrections, and preferences survive.
13. Repeat the unwritable-library case for volume, media-folder additions, selected
    installation, and track choices on two recordings. Keep the intended choices visible
    while switching/refreshing. Retry in the window and on exit, then restart to
    verify each choice. A delayed older track save must not replace a newer choice.
14. Open a large recording and close before identification completes, with and
    without setting an offset or choosing another track. Reopen the app:
    the unfinished recording, selected track, and any manual alignment
    must return, and identification must resume. Repeat after changing/removing
    that file; its earlier offset must not be applied, and an older recording must
    not open automatically in its place. A newer verified choice must take
    precedence over an older unfinished import.

Verify **Third-party notices** opens the packaged page and preserved texts without
a network connection. Use the checksum and verification record produced for the
exact executable under test; a version number alone does not identify its bytes.
Check the verification record for explicit profile-isolation support before using
it with the automated portable test.

## Configuration editing

Use disposable installation/config fixtures for failure cases. Keep the original
real-client config and generated backup when testing the actual installation.

1. Compare original and enabled bytes across UTF-8/UTF-16LE, BOM, comments, line
   endings, and missing key/section cases. Only the intended setting may change.
2. Verify missing, malformed, duplicate, read-only, junction, and hard-linked configs
   are refused without replacement. Hold the file open in another process and
   confirm the helper reports that League must be closed before retrying.
3. Modify the config after inspection and before applying. Verify the digest check
   refuses the edit, refresh updates the view, and no later changes are lost.
4. Restore an unchanged enabled config through **Configuration backups**. Then make
   another unrelated edit and confirm restoration is refused. Restart the app and
   verify the original backup is still discoverable, including when game.cfg is
   missing or unreadable and recovery must be manual.
5. In a protected fixture, verify the initial standard-user operation changes
   nothing and offers **Allow Windows permission**. Test accepting and declining
   UAC. Only the short-lived helper may elevate; ordinary review stays unelevated.
   Change the target after the prompt is shown and verify the digest is rechecked.
6. Exercise write/readback failure and interrupted writes on a disposable volume.
   Verify rollback where possible, backup durability, and useful recovery guidance
   when rollback cannot finish. Closing the app normally must drain the operation.

Run the helper integration tests on Windows as well. The Linux helper tests validate
the common parser/transaction path; they do not establish Windows sharing, native
handle validation, UAC behavior, or resilience to power loss.

Verify audible recovery through the Web Audio path after device changes and player/renderer failures. Metadata mpv uses null output; its `ao-reload` fallback is not proof of audible recovery. Record seek recovery cost and device clicks/dropouts. An internal command reply is not evidence that the right sample reached the output.

## Diagnostic traces

Use **Timing diagnostics → Export timing trace** during each test group. The
default export masks local file paths; enable **Include local file paths in
exported trace** when those paths are needed for diagnosis. This choice affects
the exported file only. Nothing is uploaded.

Export schema 2 contains app/Electron/Node versions, platform, selected replay and
recording digests when available, and whether the selection is bound to the current
viewer. Preserve the executable digest separately. The worker trace uses its own
monotonic clock, not the renderer clock or capture timestamps. Align external
capture evidence independently; export wall time is not a precise cross-clock
calibration.

The trace contains raw replay/audio observations, controller states and reported
sample ages, alignment/binding and preview changes, issued actions, seek results,
connection errors, output changes, and recovery events. Export context retains the
current controller configuration, binding, offset, media timeline/track, and output
state even when earlier events have been evicted. Reported output selection and
driver do not prove the physical endpoint or audible timing.

History is limited to 12,000 entries and 4 MiB of serialized entries, with a 64 KiB
payload limit. Exported retention counters identify evicted entries and omitted
oversized/unserializable payloads. This is a recent window, not a full-match log;
an absent event in truncated history is not proof that it never happened. The
capture measurement report remains the source for physical timing results.

## Accuracy measurements

Use the [timing fixture and measurement reporter](TIMING.md) to prepare known
recording markers, retain raw capture annotations, and calculate uncertainty-aware
statistics bound to the executable and capture digests.

Use independently established matching events near the beginning and end of the
recording to separate a wrong constant offset from clock-rate drift. Record the
uncertainty of manual anchors. Repeat across WAV, compressed audio, and video input.

For physical audible timing, capture the replay reference and output audio on a
shared measurement clock, accounting for the capture path's latency. Loopback-only
capture can omit downstream hardware latency. Keep transition intervals separate
from steady playback and report p95, maxima, sample counts, dropouts, hard seeks,
and time muted. Test the planned 100/150/350 ms gates; do not replace them with
successful API requests or the application's estimated error display.

Save results under `tests/acceptance/` with the exact artifact version and hardware.
Mark each gate measured/pass, measured/fail, or untested. Retain untested status
when evidence is insufficient.
