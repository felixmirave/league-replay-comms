import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runValidationSteps, verifyTestResults } from './validation-steps.mjs';

const node = (name, code, args = [], extra = {}) => ({ name, executable: process.execPath, args: ['-e', code, ...args], ...extra });
const fixture = async run => { const root = await mkdtemp(join(tmpdir(), 'comms-validation-')); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } };

test('runs literal arguments, records evidence and logs, and refuses to reuse an existing report', () => fixture(async root => {
  const literal = 'comms café & $(not-a-command) `literal`';
  const options = { cwd: root, directory: join(root, 'report'), echo: false };
  await runValidationSteps([node('first', 'console.log(process.argv[1]); console.error("diagnostic");', [literal], { verify: async () => ({ checked: true }) })], options);
  const report = JSON.parse(await readFile(join(options.directory, 'validation.json'), 'utf8'));
  assert.equal(report.status, 'passed'); assert.deepEqual(report.steps[0].result, { checked: true });
  const log = await readFile(join(options.directory, 'first.log'), 'utf8');
  assert(log.includes(literal)); assert(log.includes('diagnostic'));
  await assert.rejects(runValidationSteps([node('first', '')], options), /EEXIST/);
  assert.equal(JSON.parse(await readFile(join(options.directory, 'validation.json'), 'utf8')).status, 'passed');
}));

test('stops after failed execution or failed evidence verification and leaves later stages pending', () => fixture(async root => {
  for (const failure of ['exit', 'verification', 'missing-executable']) {
    const directory = join(root, failure);
    const broken = failure === 'missing-executable' ? { name: 'broken', executable: join(root, 'missing'), args: [] } : node('broken', failure === 'exit' ? 'process.exit(7)' : '', [], { verify: async () => { throw new Error('Evidence does not match artifact'); } });
    await assert.rejects(runValidationSteps([broken, node('later', 'console.log("must not run")')], { cwd: root, directory, echo: false }));
    const report = JSON.parse(await readFile(join(directory, 'validation.json'), 'utf8'));
    assert.equal(report.status, 'failed'); assert.equal(report.steps[0].status, 'failed'); assert.equal(report.steps[1].status, 'pending');
  }
}));

test('times out an owned process and records failure instead of continuing', () => fixture(async root => {
  const directory = join(root, 'report');
  await assert.rejects(runValidationSteps([node('hung', 'setInterval(() => {}, 1000)', [], { timeoutMs: 100 })], { cwd: root, directory, echo: false }), /timed out/);
  assert.equal(JSON.parse(await readFile(join(directory, 'validation.json'), 'utf8')).status, 'failed');
}));

test('refuses green reports with skipped or absent native coverage', () => fixture(async root => {
  const path = join(root, 'tests.json');
  const report = { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, testResults: [{ name: 'C:\\project\\tests\\integration\\engine.test.ts', status: 'passed', assertionResults: [{ fullName: 'native test', status: 'passed' }] }] };
  await writeFile(path, JSON.stringify(report));
  assert.equal((await verifyTestResults(path, ['tests/integration/engine.test.ts'])).total, 1);
  await assert.rejects(verifyTestResults(path, ['tests/integration/config-edit.test.ts']), /Missing successful native/);
  await writeFile(path, JSON.stringify({ ...report, numPendingTests: 1 }));
  await assert.rejects(verifyTestResults(path, []), /skipped/);
  await writeFile(path, JSON.stringify({ ...report, numPassedTests: 0 }));
  await assert.rejects(verifyTestResults(path, []), /counts/);
  report.testResults[0].assertionResults[0].status = 'pending';
  await writeFile(path, JSON.stringify(report));
  await assert.rejects(verifyTestResults(path, []), /did not run/);
}));
