# Native playback dependencies

The probe bundles Windows x64 mpv, FFmpeg/ffprobe, and a Vulkan loader from the pinned archives in
`native-manifest.json`. Downloads are verified against SHA-256 digests published
with the upstream release. The preparation script copies only the binaries and
license/build files declared in the manifest. Manuals, examples, and upstream
installers remain in the download cache. mpv's license texts are collected by
`prepare:notices`.

- [mpv Windows builds](https://github.com/shinchiro/mpv-winbuild-cmake/releases/tag/20260928), linked by [mpv's installation page](https://mpv.io/installation/).
- [FFmpeg and ffprobe Windows build](https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2).
- [Electron Windows archive supplying the Vulkan loader](https://github.com/electron/electron/releases/tag/v44.5.0), verified against its published SHA-256. `vulkan-1.dll` is copied beside mpv; its Electron/Chromium notices are under `native-docs/vulkan-loader/`.
- [Build recipes and dependency sources](https://github.com/shinchiro/mpv-winbuild-cmake).
- [mpv copyright and licensing](https://github.com/mpv-player/mpv/blob/master/Copyright).
- [FFmpeg licensing](https://ffmpeg.org/legal.html).

mpv directly imports the Vulkan loader even though this application selects no
video track. The build verifies that the local x64 loader exports every imported
function, and that each statically imported non-system DLL is present beside the
native tools. This is a structural check; clean-Windows startup remains untested.
The optional, renamed `d3dcompiler_43.dll` from mpv's archive is not distributed.
Its video-renderer use is outside this application's audio-only mpv configuration.

Public distribution still requires auditing the selected build's complete license
and corresponding-source obligations. This development probe is not a completed
public release. Offline OCR resources are included under `ocr/`. The generated
`notices/THIRD_PARTY_NOTICES.html` page collects production npm license texts and
pinned mpv, OCR-native, runtime, model, Unicode, and browser-bundle notices. Its
inventory records exact source URLs and checksums, including later-added upstream
license texts and unresolved model provenance. Corresponding-source coverage for
native binaries and the complete linked-code/launcher inventory remain release
requirements; collected notice texts do not establish their completion.
