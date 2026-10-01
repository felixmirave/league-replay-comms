# Timing measurements

Generate a known 40-minute recording for engine and seek experiments:

```sh
node scripts/generate-timing-fixture.ts reference.wav
```

The command writes 48 kHz mono 16-bit PCM plus `reference.wav.markers.json`, with
the file digest and exact sample/time of each marker. It uses bounded memory and
refuses to overwrite either output. An optional final argument sets an integer
duration from 6 to 3600 seconds. At 40 minutes the WAV is about 230 MB.

Every interior second begins with a decaying click at its exact PCM sample. A
12-bit tone sequence identifies that second, least-significant bit first, starting
50 ms later. The marker map describes the encoding. The first and last seconds
are silent. A quiet continuous 440 Hz pilot between markers makes pause/resume
observable; its presence alone cannot prove correct seek position. Sparse markers
cannot certify a 350 ms recovery interval without an independent continuous
reference. Use suitable original content/reference capture for that gate.
These generated files are developer measurement fixtures; the app
does not write metadata beside users' original recordings or perform audio-only
anchor detection. This fixture does not establish real-match alignment or audible
accuracy by itself.

## Collect independent evidence

1. Keep the exact portable executable, its `.verification.json`, and the capture
   produced while testing it. Record Windows/League versions and output hardware.
2. Capture a replay reference and physical audio output on a shared measurement
   clock. A camera/microphone or calibrated physical loopback can include the
   downstream device path. WASAPI loopback is a separate diagnostic case. Measure
   differential capture latency and its uncertainty; do not infer it from the
   companion's displayed playback error.
3. Establish the recording offset independently. For a generated marker at media
   time `m`, the expected game time is `m - offset`. The integer League HUD alone
   cannot establish a subsecond reference without a measured HUD/API phase model.
   Keep the reference apparatus, calibration, and uncertainty with the capture.
4. Before calculating percentiles, classify the entire capture as steady,
   transition, muted, or excluded. Preserve failed trials and loading/recovery
   intervals. Give every exclusion a reason. Record unexpected hard seeks and
   dropouts instead of omitting them from the review.
5. Annotate steady samples with both the game time and the recording moment heard
   at the same capture time. Use distinct increasing capture timestamps. For
   pause/speed changes, annotate the actual trigger and output response in distinct,
   increasing trigger order; for seeks,
   additionally annotate when the replay picture/clock settles. A seek response is
   the first stable return within the audible alignment bound, including reference
   uncertainty, not merely the first sound. A missing response is `null`.

Transition uncertainty must include differential reference/audio capture delay.
The report does not subtract the steady-state capture bias from transition
durations: those are different measurements. A delayed but consistent microphone
path can affect a reference-to-audio delay even when the timestamps share a clock.

## Annotation format

Save JSON using this structure. Paths are relative to the annotation file. This
short illustrative input deliberately lacks enough samples to pass a gate;
replace its values with actual annotations and retain the original capture.

```json
{
  "schemaVersion": 1,
  "artifactPath": "LeagueReplayComms-0.1.1-x64.exe",
  "capturePath": "physical-capture.mkv",
  "environment": {
    "windows": "Record tested Windows version",
    "leaguePatch": "Record tested League patch",
    "outputDevice": "Record device and driver",
    "connection": "wired",
    "displayRefreshHz": 60
  },
  "capture": {
    "kind": "physical",
    "apparatus": "Describe the independent capture apparatus",
    "clock": "capture presentation timestamps",
    "pathBiasSeconds": 0,
    "pathUncertaintySeconds": 0.01,
    "calibrationEvidence": "Describe the measured bias, its sign, and uncertainty"
  },
  "alignment": {
    "offsetSeconds": 45,
    "uncertaintySeconds": 0.02,
    "evidence": "Identify the independent matching anchors"
  },
  "durationSeconds": 20,
  "segments": [
    { "id": "play", "startSeconds": 0, "endSeconds": 10, "kind": "steady", "rate": 1 },
    { "id": "seek", "startSeconds": 10, "endSeconds": 20, "kind": "transition", "rate": 1 }
  ],
  "steady": [
    { "id": "sample-1", "segment": "play", "capturedAtSeconds": 5, "gameSeconds": 600,
      "heardMediaSeconds": 645.03, "gameUncertaintySeconds": 0.01, "mediaUncertaintySeconds": 0.002 }
  ],
  "transitions": [
    { "id": "seek-1", "segment": "seek", "kind": "seek", "triggeredAtSeconds": 12,
      "settledAtSeconds": 12.5, "responseAtSeconds": 12.7, "uncertaintySeconds": 0.02 }
  ],
  "observations": { "unexpectedHardSeeks": 0, "dropouts": 0, "notes": "Describe every failed or excluded trial" }
}
```

`capture.kind` is `physical`, `wasapi-loopback`, or `synthetic`. The latter two
never establish the physical audible gates. `pathBiasSeconds` is the measured
signed error introduced by the steady capture path, in wall seconds; the analyzer
subtracts it from `(heardMedia - game - offset) / rate`. Its uncertainty is added
to the anchor/game/media uncertainty after converting those into wall seconds.
Do not fill missing uncertainty with zero to obtain a passing result.

## Generate and review the report

```sh
node scripts/analyze-timing.ts measurements.json timing-report.json
```

The command validates annotations, verifies the executable against its payload
record, hashes the completed capture and exact input bytes, and writes a new
report. It rejects a changing capture and refuses to overwrite an existing report.
It does not upload anything or require the League client to remain running.

The report includes signed media/wall errors, additive uncertainty, p95/p99/maxima,
definite/possible deadline misses, missing responses, and all classified durations.
Missing responses remain in the percentile denominator as unbounded delays. A
`null` percentile or maximum when responses are missing means unbounded, not zero.
Seek recovery is measured after settling; replay settling duration is also retained.

Policy version 1 uses the plan's 100 ms steady 1×, 150 ms pause/speed reaction, and
350 ms seek-recovery targets. It requires at least 200 steady samples or 20 trials
for a descriptive assessment. An upper uncertainty bound within the target yields
`within-target`; a lower bound beyond it yields `exceeds-target`; overlapping bounds
are `uncertain`. Insufficient counts and unclassified time cannot pass. Other rates
remain diagnostic and retain both media and wall coordinates.

These minimum counts are a reporting guard, not a statistical reliability claim;
p99 validation needs substantially more independent trials. Inspect muted time,
dropouts, failed trials, calibration, and representativeness alongside percentiles.
A report always leaves independent review and release certification unproven.
Hashing establishes which files were measured, not whether annotations or apparatus
are correct. Record reviewed findings in [STATUS.md](STATUS.md) and complete the
[Windows acceptance procedure](WINDOWS.md).
