# Automated Windows validation

Run the full build and automated desktop workflow from the repository root:

```powershell
npm.cmd run validate:windows
```

This is a developer/CI procedure. It requires Windows x64, a [supported Node.js version](../../README.md#development),
npm, Windows PowerShell, and an active desktop session running as a standard user.
Keep an audio output endpoint available and close League replays before running.
Dependency preparation needs network access and sufficient disk space for native
archives, staging, and an additional extracted verification copy. End users run
the resulting executable without these developer prerequisites.

The script rejects Linux, a non-x64 Node process, an elevated account, and a
noninteractive/session-zero runner. It uses the pinned Windows media executables
and the system Windows PowerShell for native integration tests. CI must run in a
logged-in desktop session; installing a service runner alone is insufficient.
Serialize desktop validation jobs on each machine. GitHub Actions is not configured
yet.

## Stages and results

The command installs locked dependencies, prepares Electron/native/OCR/notices
resources, then runs resource checks, type checks, the full test suite, packaging
tests, the build, source desktop workflows, portable packaging, payload inspection,
and the portable workflow. A failed command or evidence check stops later stages.
The full test report must contain all required integration files with no skipped
or unfinished tests. The packaged playback check exercises Web Audio preview and requires a non-null reported output driver; its generated tracks are silent. It does not verify captured speech or sound-filter quality. `npm run test:filters-browser` is a separate optional Chromium check and is not run by this pipeline.

Each run creates `release/validation/windows-*/` containing:

- `validation.json`: host, dependency-lock digest, commands, stage outcomes, and
  individual log paths. Unexecuted stages remain pending after a failure.
- `tests.json` and `tests.xml`: Vitest results and JUnit data.
- `portable/portable-execution.json` and a screenshot: exact artifact digest,
  packaged workflow checks, and explicitly limited evidence claims.
- `artifact.json`, after success: checksum and links to the completed reports.

Expected completion prints `Windows automated validation passed for` followed by
the artifact SHA-256. A CI job should retain reports, logs, the executable, and its
digest and payload verification record even when a later stage fails. Files created
before a failure help diagnosis; their existence does not establish a pass.

To reuse already prepared dependencies and resources during local diagnosis:

```powershell
npm.cmd run validate:windows -- --prepared
```

This skips acquisition, retains integrity checks, and records that reuse in the
report. CI uses the full command. Each invocation still creates a new result
directory and must not reuse a previous passing report.

## Portable execution and isolation

The workflow starts the actual verified portable executable from an unrelated
working directory. Explicit loopback debugger ports allow attachment without
relying on stderr forwarding through NSIS. Before test actions, the driver checks
the application identity and confirms that Chromium and Node refer to the same
process. The running executable and ASAR must match the verified payload hashes.

The executable must declare support for `--user-data-dir`; older artifacts are
rejected before launch. Startup applies that absolute directory to both Electron
profile paths before acquiring the instance lock or writing library data. Tests
confirm the paths and keep all review data in a temporary profile. Packaged runs
do not enable development-only null-output or media-path overrides.

The workflow imports audio and a generated two-track video, checks audio-track preview
and pause, runs packaged OCR on a synthetic top-right clock, applies its midpoint,
saves a manual offset, opens the
fixed notice route, and restores track/offset/volume after normal exit and renamed
recording/executable paths. It checks Unicode paths and renderer isolation. Normal
shutdown waits for the portable launcher; failures trigger bounded cleanup of
owned processes. Cleanup failure fails the report.

The cross-platform driver smoke command, `npm run smoke:driver`, exercises real
Electron attachment, identity rejection, main/renderer evaluation, and cleanup
without stderr. Passing it on Linux does not establish NSIS behavior on Windows.

## Packaging and artwork maintenance

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

Packaging stages the application and compresses the portable executable in separate processes to bound memory use. Resource verification checks x64 PE imports and bundled DLL exports, including mpv's Vulkan loader; it does not replace Windows execution. Run `node --test scripts/windows-native.test.ts` after native preparation for the dependency-check regressions.

## Separate release evidence

A successful run proves the recorded automated cases for its exact executable.
It does not certify a clean account without developer tools, offline first launch,
actual League replay behavior, the real HUD-to-replay midpoint assumption, or physical audible
accuracy. Complete [the Windows procedure](WINDOWS.md) and the plan's measurement
gates separately. Record actual outcomes in [STATUS.md](STATUS.md); never infer
these results from a generated build or a passing synthetic fixture.
