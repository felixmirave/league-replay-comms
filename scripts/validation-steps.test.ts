import type { ValidationStep } from './validation-steps.ts';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { runValidationSteps, verifyTestResults } from './validation-steps.ts';

const node = (name: string, mode: 'log' | 'pass' | 'fail' | 'hang', args: string[] = [], extra: Partial<ValidationStep> = {}) => ({ name, executable: process.execPath, args: [resolve('scripts/fixtures/validation-child.ts'), mode, ...args], ...extra });
const fixture = async (run: (root: string) => Promise<void>) => { const root = await mkdtemp(join(tmpdir(), 'comms-validation-')); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } };

test('runs literal arguments, records evidence and logs, and refuses to reuse an existing report', () => fixture(async root => {
  const literal = 'comms café & $(not-a-command) `literal`';
  const options = { cwd: root, directory: join(root, 'report'), echo: false };
  await runValidationSteps([node('first', 'log', [literal], { verify: async () => ({ checked: true }) })], options);
  const report = JSON.parse(await readFile(join(options.directory, 'validation.json'), 'utf8'));
  assert.equal(report.status, 'passed'); assert.deepEqual(report.steps[0].result, { checked: true });
  const log = await readFile(join(options.directory, 'first.log'), 'utf8');
  assert(log.includes(literal)); assert(log.includes('diagnostic'));
  await assert.rejects(runValidationSteps([node('first', 'pass')], options), /EEXIST/);
  assert.equal(JSON.parse(await readFile(join(options.directory, 'validation.json'), 'utf8')).status, 'passed');
}));

test('stops after failed execution or failed evidence verification and leaves later stages pending', () => fixture(async root => {
  for (const failure of ['exit', 'verification', 'missing-executable']) {
    const directory = join(root, failure);
    const broken = failure === 'missing-executable' ? { name: 'broken', executable: join(root, 'missing'), args: [] } : node('broken', failure === 'exit' ? 'fail' : 'pass', [], { verify: async () => { throw new Error('Evidence does not match artifact'); } });
    await assert.rejects(runValidationSteps([broken, node('later', 'log', ['must not run'])], { cwd: root, directory, echo: false }));
    const report = JSON.parse(await readFile(join(directory, 'validation.json'), 'utf8'));
    assert.equal(report.status, 'failed'); assert.equal(report.steps[0].status, 'failed'); assert.equal(report.steps[1].status, 'pending');
  }
}));

test('times out an owned process and records failure instead of continuing', () => fixture(async root => {
  const directory = join(root, 'report');
  await assert.rejects(runValidationSteps([node('hung', 'hang', [], { timeoutMs: 100 })], { cwd: root, directory, echo: false }), /timed out/);
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
  report.testResults[0]!.assertionResults[0]!.status = 'pending';
  await writeFile(path, JSON.stringify(report));
  await assert.rejects(verifyTestResults(path, []), /did not run/);
}));
