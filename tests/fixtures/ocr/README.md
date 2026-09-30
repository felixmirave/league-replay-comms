# Clock image fixtures

## Synthetic images

These are generated text fixtures, not League screenshots or accuracy evidence.
`clock.png` reads `12:34`, `rollover.png` reads `60:00`, and `blank.png` is empty.
They test the packaged offline reader without a font dependency on the test host.

Generated with FFmpeg 5.1.9: 240×90 background `0x111827`, white 48 px FreeSansBold,
at (20,20), PNG output. Source font: Debian `fonts-freefont-ttf`. No font file is
redistributed. Timer placement, compression, HUD scale, and phase require separate
real-recording fixtures.

`clock-video.mkv` is a generated 130-second, 30 fps H.264 recording of a clock
showing `floor(t + 100)` as `mm:ss`. Its original video PTS starts at 5 seconds.
With canonical media origin 5, the known offset is −100 seconds. It contains no
audio; this fixture isolates video decoding/OCR and never serves as a comms file.
Regenerate with `COMMS_TEST_FFMPEG` and `COMMS_TEST_FONT` set, then run
`node tests/fixtures/ocr/generate-video.mjs`. The generation script uses FFmpeg's
original input time, before adding the output timestamp origin.

## Real images

[real/manifest.json](real/manifest.json) identifies 31 user-reviewed League frames:
29 visible clocks and two negative controls. Unmodified originals are in
`real/images/`; hashes, expected timestamps and source provenance are in the manifest.
`twitch_jasper7se` was excluded by the user because its right margin contains
non-game content. The historical split labels describe the initial experiment;
all retained images are now regression fixtures, not an independent holdout.

Prepare dependencies with `npm ci` and `npm run prepare:ocr`. Windows uses the
bundled FFmpeg from `npm run prepare:native`. On Linux, install FFmpeg or set
`COMMS_TEST_FFMPEG` to its executable. From the repository root:

```sh
npm run test:ocr-corpus
```

Expect 31 passing cases. The same suite runs in `npm test` and `npm run check`.
Missing images, changed hashes, missing native/OCR dependencies, wrong timestamps,
low-confidence readings and false clocks fail the suite; none are skipped or
marked as expected failures. Tests pass original full frames through
`VideoClockAnalyzer.readFrame`, also used by `analyze`, with the real decoder worker,
FFmpeg preprocessing, offline OCR worker, strict parser and confidence cutoff.
They supply no crop or OCR override. These assets are excluded from the application
package; they do not increase its executable size.

See [validation status](../../acceptance/STATUS.md) for results and limitations.
