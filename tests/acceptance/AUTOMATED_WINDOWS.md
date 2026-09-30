# Automated Windows validation

Run the full build and automated desktop workflow from the repository root:

```powershell
npm.cmd run validate:windows
```

This is a developer/CI procedure. It requires Windows x64, Node 22.18 or later,
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
or unfinished tests. The packaged playback check requires a real output driver;
its generated tracks are silent.

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

The workflow imports audio and a generated two-track video, checks preview and
seeking, runs packaged OCR on a synthetic clock, retains a manual offset, opens the
fixed notice route, and restores track/offset/volume after normal exit and renamed
recording/executable paths. It checks Unicode paths and renderer isolation. Normal
shutdown waits for the portable launcher; failures trigger bounded cleanup of
owned processes. Cleanup failure fails the report.

The cross-platform driver smoke command, `npm run smoke:driver`, exercises real
Electron attachment, identity rejection, main/renderer evaluation, and cleanup
without stderr. Passing it on Linux does not establish NSIS behavior on Windows.

## Separate release evidence

A successful run proves the recorded automated cases for its exact executable.
It does not certify a clean account without developer tools, offline first launch,
actual League replay behavior, the real HUD-to-replay midpoint assumption, or physical audible
accuracy. Complete [the Windows procedure](WINDOWS.md) and the plan's measurement
gates separately. Record actual outcomes in [STATUS.md](STATUS.md); never infer
these results from a generated build or a passing synthetic fixture.
