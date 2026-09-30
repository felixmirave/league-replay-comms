import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import executable from 'electron';
import { launchDesktop } from './portable-driver.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const folder = await mkdtemp(join(tmpdir(), 'comms driver café '));
const profile = join(folder, 'profile'), cwd = join(folder, 'unrelated directory');
await mkdir(cwd); await mkdir(profile);
const env = { ...process.env, COMMS_TEST_USER_DATA: join(folder, 'must not be used') };
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const options = { executable, args: [root, ...(process.env.COMMS_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])], cwd, profile, env };
let app;
try {
  let rejectedPid;
  await assert.rejects(launchDesktop({ ...options, verifyIdentity: identity => { rejectedPid = identity.pid; throw new Error('Deliberately rejected identity'); } }), /Deliberately rejected identity/);
  assert(rejectedPid, 'Identity rejection did not reach the launched app');
  assert.throws(() => process.kill(rejectedPid, 0), { code: 'ESRCH' }, 'Rejected app was left running');
  app = await launchDesktop({ ...options, verifyIdentity: identity => {
    assert.equal(resolve(identity.executable), resolve(executable));
    assert.equal(resolve(identity.userData), profile); assert.equal(resolve(identity.sessionData), profile);
    assert.equal(identity.packaged, false);
  } });
  const window = await app.firstWindow();
  await window.locator('#task-title').waitFor();
  assert.equal(await window.evaluate(() => typeof window.review.command), 'function');
  const literal = 'café & $(literal) `quotes` " \\ \n';
  assert.deepEqual(await app.evaluate(({ app }, value) => ({ name: app.getName(), value }), literal), { name: 'LeagueReplayComms', value: literal });
  await assert.rejects(app.evaluate(() => { throw new Error('Evaluation rejection'); }), /Evaluation rejection/);
  const pid = app.identity.pid;
  await app.close(); app = undefined;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'Normal close left the app running');
  console.log('Loopback driver passed real Electron launch without stderr, identity rejection/cleanup, isolated profiles, main/renderer evaluation, and normal exit. This does not certify Windows NSIS execution.');
} finally {
  await app?.close();
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
