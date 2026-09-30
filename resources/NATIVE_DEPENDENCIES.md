# Native playback dependencies

The probe bundles Windows x64 mpv, FFmpeg/ffprobe, and a Vulkan loader from the pinned archives in
`native-manifest.json`. Downloads are verified against SHA-256 digests published
with the upstream release. The preparation script copies only the binaries and
license/build files declared in the manifest. Manuals, examples, and upstream
installers remain in the download cache. mpv's license texts are collected by
`prepare:notices`.

- [mpv 0.41.0 upstream Windows x64 MSVC build](https://github.com/mpv-player/mpv/releases/tag/v0.41.0), replacing the larger shinchiro development build. The executable retains LuaJIT, WASAPI, IPC, seeking, and playback-speed support. Its PDB, console launcher, and registration scripts are not shipped.
- [FFmpeg 9.0.2 shared GPL build from BtbN](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-09-30-13-08), revision `2a571b6068`. FFmpeg and ffprobe use the same seven DLLs listed in the manifest. `ffplay`, headers, import libraries, presets, and manuals are not shipped.
- [Electron Windows archive supplying the Vulkan loader](https://github.com/electron/electron/releases/tag/v44.5.0), verified against its published SHA-256. `vulkan-1.dll` is copied beside mpv; its Electron/Chromium notices are under `native-docs/vulkan-loader/`.
- Build recipes: [mpv MSVC](https://github.com/mpv-player/mpv/blob/v0.41.0/ci/build-win32.ps1) and [BtbN FFmpeg](https://github.com/BtbN/FFmpeg-Builds/tree/autobuild-2026-09-30-13-08).
- [mpv copyright and licensing](https://github.com/mpv-player/mpv/blob/v0.41.0/Copyright).
- [FFmpeg licensing](https://ffmpeg.org/legal.html).

mpv directly imports the Vulkan loader even though this application selects no
video track. The build verifies that the local x64 loader exports every imported
function, and that every non-system DLL and imported symbol in the transitive
dependency graph is present beside the native tools. It also rejects unexpected
native files. This is a structural check; clean-Windows startup remains untested.

mpv still contains its own statically linked FFmpeg libraries. Only the FFmpeg and
ffprobe command-line tools share DLLs; replacing mpv's internal libraries would
require a separate compatible mpv build. No decoder or filter was selectively
removed from the upstream binaries. The application's Windows integration tests
exercise probing, waveforms, frame extraction, clock OCR, Lua heartbeat, track
switching, and playback timing with the prepared executables.

Public distribution still requires auditing the selected build's complete license
and corresponding-source obligations. This development probe is not a completed
public release. Offline OCR resources are included under `ocr/`. The generated
`notices/THIRD_PARTY_NOTICES.html` page collects production npm license texts and
pinned mpv, OCR-native, runtime, model, Unicode, and browser-bundle notices. Its
inventory records exact source URLs and checksums, including later-added upstream
license texts and unresolved model provenance. Corresponding-source coverage for
native binaries and the complete linked-code/launcher inventory remain release
requirements; collected notice texts do not establish their completion.
