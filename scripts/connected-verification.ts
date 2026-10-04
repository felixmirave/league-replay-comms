import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { analyzePcm, fixturePcm, matchRecording, verifyCodedAudio, verifySilence, writeWav } from './audio-verification.ts';
import { command, startDesktop, waitSnapshot } from './dev-desktop.ts';
import { seconds } from './replay-simulator.ts';

export async function verifyConnected(folder: string, recording?: { path: string; track: number; at: number }) {
  const session = await startDesktop(folder);
  let page = session.page, app = session.app;
  let offset = 2, track = 2;
  const results: { name: string; started: number; ended?: number; result?: unknown; error?: string }[] = [];
  const screenshots: string[] = [];
  const checkpoint = async (name: string, action: () => Promise<unknown>) => {
    console.log('Connected app:', name);
    const result: typeof results[number] = { name, started: seconds() }; results.push(result);
    try {
      result.result = await action(); result.ended = seconds();
      const path = join(folder, name + '.png'); await page.screenshot({ path }); screenshots.push(path);
    } catch (error) { result.error = String(error); throw error; }
    finally { await writeFile(join(folder, 'scenarios.json'), JSON.stringify(results, null, 2)); }
  };
  const segment = async (duration = 1.2) => {
    const start = seconds(); await session.capture.until(start + duration);
    const pcm = session.capture.slice(start, start + duration);
    return { start, pcm, frames: analyzePcm(pcm, start - session.latency) };
  };
  const audible = async (duration = 1.2) => {
    const data = await segment(duration);
    return verifyCodedAudio(data.frames, at => session.simulator.timeline.at(at).time + offset, track, 0.22 + session.uncertainty);
  };
  const silent = async () => verifySilence((await segment(0.8)).frames);
  const follow = async () => {
    await page.getByRole('button', { name: 'Start listening', exact: true }).click();
    await waitSnapshot(page, state => state.sync.state === 'following' || state.sync.state === 'paused');
  };
  const setAlignment = async (value: number) => {
    await waitSnapshot(page, state => !state.busy && !!state.library?.recording?.hash && state.library.trackChosen && state.workflow?.state === 'alignment.manual', 60000);
    await page.getByLabel('Recording offset (seconds)', { exact: true }).fill('');
    await page.getByLabel('Recording offset (seconds)', { exact: true }).fill(String(value));
    const aligned = await waitSnapshot(page, state => !!state.library?.alignment && Math.abs(state.library.alignment.baseOffsetSeconds + state.library.alignment.correctionSeconds - value) < 1e-6 && state.library.unsavedAlignments === 0);
    if (aligned.workflow?.state === 'alignment.manual') await page.getByRole('button', { name: 'Done', exact: true }).click();
    offset = value;
  };
  const chooseTrack = async (ordinal: number) => {
    await waitSnapshot(page, state => state.workflow?.state === 'recording.track');
    await page.locator('input[name=track]').nth(ordinal - 1).check();
    await page.getByRole('button', { name: 'Use this track', exact: true }).click();
  };
  let success = false;
  try {
    await checkpoint('import-and-align', async () => {
      const first = join(folder, 'track-one.wav'), second = join(folder, 'track-two.wav'), fixture = join(folder, 'coded-tracks.mka');
      await writeWav(first, fixturePcm(1)); await writeWav(second, fixturePcm(2));
      await command(resolve('resources/bin/linux-x64/ffmpeg'), ['-v', 'error', '-i', first, '-i', second, '-map', '0:a', '-map', '1:a', '-c:a', 'pcm_s16le', '-metadata:s:a:0', 'title=Track one', '-metadata:s:a:1', 'title=Track two', fixture], session.env);
      await session.selectFile(fixture);
      await page.getByRole('button', { name: 'Choose recording', exact: true }).click();
      await chooseTrack(2);
      // Tone codes verify timing and volume; speech filters intentionally remove
      // these signals. Disable them through the real controls for this baseline.
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      for (const name of ['Radio voice', 'Noise suppression', 'Sound position']) {
        const toggle = page.getByRole('dialog').getByRole('switch', { name, exact: true });
        if (await toggle.isChecked()) await toggle.uncheck();
      }
      await waitSnapshot(page, state => !state.library?.filters?.radio.enabled && !state.library?.filters?.noise.enabled && !state.library?.filters?.position.enabled && state.library?.unsavedPreferences === 0);
      await page.getByRole('button', { name: 'Close settings', exact: true }).click();
      await page.getByLabel('Recording offset (seconds)', { exact: true }).waitFor();
      await setAlignment(2);
      const state = await waitSnapshot(page, state => state.workflow?.state === 'ready');
      assert.equal(state.media!.selectedTrackId, 2); assert.equal(state.audioOutput?.driver, 'Web Audio');
      return { media: state.media, output: state.audioOutput };
    });
    await checkpoint('start-listening', async () => {
      session.simulator.timeline.set({ time: 8, speed: 1, paused: false }); await follow(); await delay(500);
      return audible();
    });
    await checkpoint('pause', async () => {
      session.simulator.timeline.set({ paused: true }); await waitSnapshot(page, state => state.sync.state === 'paused'); await delay(300); return silent();
    });
    await checkpoint('resume', async () => {
      session.simulator.timeline.set({ paused: false }); await waitSnapshot(page, state => state.sync.state === 'following'); await delay(400); return audible();
    });
    for (const [name, time] of [['forward-jump', 20], ['backward-jump', 5]] as const) {
      await checkpoint(name, async () => {
        const at = seconds(); session.simulator.timeline.set({ time, seeking: true });
        await waitSnapshot(page, state => state.replay?.seeking === true);
        await delay(150); session.simulator.timeline.set({ seeking: false });
        await waitSnapshot(page, state => state.sync.state === 'following' && Math.abs((state.sync.targetSeconds ?? 0) - (session.simulator.timeline.at().time + offset)) < 0.3);
        await delay(500); const data = await audible();
        const transition = analyzePcm(session.capture.slice(at, seconds() - 0.1), at - session.latency);
        let recovery: number | undefined;
        for (let i = 0; i + 5 <= transition.length; i++) {
          if (transition.slice(i, i + 5).every(frame => frame.track === track && frame.sourceSeconds !== undefined && Math.abs(frame.sourceSeconds - (session.simulator.timeline.at(frame.at).time + offset)) <= 0.22 + session.uncertainty)) {
            recovery = Math.max(0, transition[i]!.at - at); break;
          }
        }
        assert(recovery !== undefined && recovery <= 1.5, 'Captured audio failed to recover within the development seek budget');
        return { ...data, capturedRecoverySeconds: recovery, developmentRecoveryBudgetSeconds: 1.5 };
      });
    }
    for (const speed of [2, 0.5]) await checkpoint('speed-' + speed, async () => {
      session.simulator.timeline.set({ time: 8, speed });
      await waitSnapshot(page, state => state.sync.state === 'following' && Math.abs((state.sync.rate ?? 0) - speed) < 0.05);
      await delay(500); return audible(1.8);
    });
    await checkpoint('volume', async () => {
      session.simulator.timeline.set({ time: 8, speed: 1 }); await delay(600);
      const before = await audible(0.8);
      const slider = page.getByRole('slider', { name: 'Comms volume', exact: true });
      await slider.focus(); await slider.press('Home');
      for (let i = 0; i < 50; i++) await slider.press('ArrowRight');
      await waitSnapshot(page, state => state.library?.volume === 50 && state.library.unsavedPreferences === 0);
      await delay(300); const after = await audible(0.8);
      assert(after.rms < before.rms * 0.8 && after.rms > before.rms * 0.01, 'Volume must reduce captured sample amplitude');
      return { before, after, amplitudeRatio: after.rms / before.rms };
    });
    await checkpoint('recording-end', async () => {
      session.simulator.timeline.set({ time: 40 }); await waitSnapshot(page, state => state.sync.state === 'outside-recording'); await delay(400); return silent();
    });
    await checkpoint('negative-offset-boundary', async () => {
      await page.getByRole('button', { name: 'Adjust timing', exact: true }).click(); await setAlignment(-4);
      session.simulator.timeline.set({ time: 1 }); await waitSnapshot(page, state => state.sync.state === 'outside-recording'); await delay(400); await silent();
      session.simulator.timeline.set({ time: 10 }); await waitSnapshot(page, state => state.sync.state === 'following'); await delay(500); return audible();
    });
    for (const fault of ['offline', 'json', 'schema', 'oversize', 'http', 'delay'] as const) await checkpoint('replay-fault-' + fault, async () => {
      session.simulator.timeline.set({ fault }); await waitSnapshot(page, state => !!state.connectionError && state.paused); await delay(400); const silence = await silent();
      session.simulator.timeline.set({ fault: 'none', time: 12 });
      await waitSnapshot(page, state => !!state.replay && !state.connectionError && !state.library?.boundToRuntime);
      await silent(); await follow(); await delay(500); return { silence, recovery: await audible(0.8) };
    });
    await checkpoint('replay-replacement', async () => {
      session.simulator.timeline.set({ processID: 2000, time: 12 });
      await waitSnapshot(page, state => !state.library?.boundToRuntime && state.paused, 10000);
      await delay(300); await silent(); await follow(); await delay(500); return audible();
    });
    await checkpoint('restart-and-persistence', async () => {
      session.simulator.timeline.set({ paused: true, time: 8 });
      const relaunched = await session.restart(); page = relaunched.page; app = relaunched.app;
      await page.locator('.recent').filter({ hasText: 'coded-tracks.mka' }).first().click();
      const state = await waitSnapshot(page, state => state.library?.recordingReady === true && state.workflow?.state === 'ready');
      assert.equal(state.media!.selectedTrackId, track); assert.equal(state.library!.volume, 50);
      assert(state.library!.filters && !state.library!.filters.radio.enabled && !state.library!.filters.noise.enabled && !state.library!.filters.position.enabled, 'Filter baseline must persist across restart');
      assert.equal(state.library!.alignment!.baseOffsetSeconds + state.library!.alignment!.correctionSeconds, offset);
      assert(!state.library!.boundToRuntime); await silent();
      session.simulator.timeline.set({ paused: false }); await follow(); await delay(500); return audible();
    });
    if (recording) await checkpoint('uploaded-recording', async () => {
      session.simulator.timeline.set({ time: recording.at, speed: 1, paused: true });
      await page.getByRole('button', { name: 'Change recording', exact: true }).click();
      await session.selectFile(recording.path); await page.getByRole('button', { name: 'Choose recording', exact: true }).click();
      await chooseTrack(recording.track);
      const state = await waitSnapshot(page, state => ['alignment.analyzing', 'alignment.manual', 'ready', 'recording.identifying'].includes(state.workflow?.state ?? ''), 60000);
      if (state.workflow?.state === 'alignment.analyzing' || state.workflow?.state === 'recording.identifying') await page.getByRole('button', { name: 'Align manually', exact: true }).click();
      else if (state.workflow?.state === 'ready') await page.getByRole('button', { name: 'Adjust timing', exact: true }).click();
      await setAlignment(0);
      session.simulator.timeline.set({ time: recording.at, paused: false }); await follow(); await delay(800);
      const data = await segment(2);
      const expected = session.simulator.timeline.at(data.start - session.latency).time;
      const referenceStart = Math.max(0, expected - 1);
      const referencePath = join(folder, 'recording-reference.s16le');
      await command(resolve('resources/bin/linux-x64/ffmpeg'), ['-v', 'error', '-ss', String(referenceStart), '-i', resolve(recording.path), '-map', `0:a:${recording.track - 1}`, '-t', '4', '-ac', '1', '-ar', '48000', '-f', 's16le', referencePath], session.env);
      const match = matchRecording(data.pcm, await readFile(referencePath), referenceStart);
      const expectedMatch = session.simulator.timeline.at(data.start + match.capturedSeconds - session.latency).time;
      const error = match.sourceSeconds - expectedMatch;
      assert(Math.abs(error) <= 0.22 + session.uncertainty, 'Uploaded recording audio position differs from simulator: ' + JSON.stringify({ match, expectedMatch, error }));
      return { recording: resolve(recording.path), audioTrackOrdinal: recording.track, match, expectedMatch, errorSeconds: error };
    });
    assert.deepEqual(session.rendererErrors, []);
    success = true;
  } catch (error) {
    await page.screenshot({ path: join(folder, 'failure.png') }).catch(() => undefined);
    await writeFile(join(folder, 'failure-state.json'), JSON.stringify(await page.evaluate(() => window.review.snapshot()).catch(() => null), null, 2));
    throw error;
  } finally {
    try {
      await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog; }, join(folder, 'timing-trace.json'));
      await page.evaluate(() => window.review.command({ type: 'export-trace' }));
      await app.context().tracing.stop({ path: join(folder, 'playwright.zip') });
    } finally {
      await writeFile(join(folder, 'replay-timeline.json'), JSON.stringify(session.simulator.timeline.events, null, 2));
      await session.close();
    }
  }
  return { success, results, screenshots, audio: { latencySeconds: session.latency, uncertaintySeconds: session.uncertainty, sampleRate: 48000,
    claim: 'Captured Linux virtual-device samples checked against independent source codes and replay timeline; no Windows or physical timing claim' } };
}
