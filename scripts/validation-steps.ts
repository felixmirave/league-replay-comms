import type { ChildProcess } from 'node:child_process';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';

export interface ValidationStep {
  name: string; executable: string; args: string[]; timeoutMs?: number;
  verify?: () => Promise<Record<string, unknown>>;
}
interface ValidationOptions {
  cwd: string; env?: NodeJS.ProcessEnv; directory: string;
  evidence?: Record<string, unknown>; signal?: AbortSignal; echo?: boolean;
}
interface ExecutionOptions extends Pick<ValidationOptions, 'cwd' | 'env' | 'signal' | 'echo'> { logPath: string }
interface StepResult {
  name: string; executable: string; args: string[]; log: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  startedAt?: string; finishedAt?: string; result?: Record<string, unknown>; error?: string;
}
interface ValidationReport {
  schemaVersion: number; platform: string; architecture: string; startedAt: string; finishedAt?: string;
  status: 'running' | 'passed' | 'failed'; evidence: Record<string, unknown>; steps: StepResult[];
}
interface TestReport {
  success: boolean; numTotalTests: number; numFailedTests: number; numPendingTests: number;
  numTodoTests?: number; numPassedTests: number;
  testResults: { name: string; status: string; assertionResults?: { status: string; fullName: string }[] }[];
}

export async function terminateOwned(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot;
    assert(systemRoot, 'Windows SystemRoot is unavailable');
    await new Promise<void>(resolve => {
      const killer = spawn(join(systemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolve(); });
      killer.once('exit', () => { child.kill(); resolve(); });
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
  }
}

async function execute(step: ValidationStep, { cwd, env, logPath, signal, echo }: ExecutionOptions) {
  const log = createWriteStream(logPath, { flags: 'wx' });
  let child: ChildProcess | undefined, timer: NodeJS.Timeout | undefined, stopped: Error | undefined;
  const stop = (reason: Error) => {
    if (stopped) return;
    stopped = reason;
    if (child) void terminateOwned(child).catch(() => child?.kill());
  };
  const abort = () => stop(signal?.reason instanceof Error ? signal.reason : new Error('Validation cancelled'));
  try {
    if (signal?.aborted) throw signal.reason;
    child = spawn(step.executable, step.args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    log.on('error', error => stop(error));
    child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false });
    if (echo) { child.stdout!.pipe(process.stdout, { end: false }); child.stderr!.pipe(process.stderr, { end: false }); }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop(new Error(`Validation stage timed out: ${step.name}`)), step.timeoutMs ?? 30 * 60 * 1000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('close', (code, exitSignal) => stopped ? reject(stopped) : exitSignal ? reject(new Error(`Stage terminated by ${exitSignal}`)) : resolve(code));
    });
    if (code !== 0) throw new Error(`Validation stage ${step.name} exited with code ${code}`);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    log.end(); await finished(log);
  }
}

/** Persistent stage evidence; only successful exit AND result verification pass a step. */
export async function runValidationSteps(steps: ValidationStep[], { cwd, env = process.env, directory, evidence = {}, signal, echo = true }: ValidationOptions) {
  assert(Array.isArray(steps) && steps.length > 0, 'Validation requires at least one stage');
  const names = new Set<string>();
  for (const step of steps) {
    assert(/^[a-z0-9-]+$/.test(step.name) && !names.has(step.name), 'Invalid or duplicate validation stage');
    names.add(step.name);
    assert(typeof step.executable === 'string' && Array.isArray(step.args) && step.args.every(arg => typeof arg === 'string'), 'Invalid validation command');
  }
  await mkdir(directory, { recursive: true });
  const reportPath = join(directory, 'validation.json');
  const report: ValidationReport = { schemaVersion: 1, platform: process.platform, architecture: process.arch, startedAt: new Date().toISOString(), status: 'running', evidence,
    steps: steps.map(step => ({ name: step.name, executable: step.executable, args: step.args, status: 'pending', log: `${step.name}.log` })) };
  // Reusing an earlier run's directory must not leave a stale passing report.
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  try {
    for (const [index, step] of steps.entries()) {
      const result = report.steps[index]!;
      result.status = 'running'; result.startedAt = new Date().toISOString(); await save();
      if (echo) console.log(`Validation: ${step.name}`);
      try {
        await execute(step, { cwd, env, signal, echo, logPath: join(directory, result.log) });
        if (step.verify) result.result = await step.verify();
        result.status = 'passed';
      } catch (error) { result.status = 'failed'; result.error = error instanceof Error ? error.message : String(error); throw error; }
      finally { result.finishedAt = new Date().toISOString(); await save(); }
    }
    report.status = 'passed';
    return report;
  } catch (error) { report.status = 'failed'; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await save(); }
}

/** A green test command alone is insufficient if required native cases were skipped. */
export async function verifyTestResults(path: string, requiredFiles: string[]) {
  const report: TestReport = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(report.success, true, 'Test report did not pass');
  assert(Number.isInteger(report.numTotalTests) && report.numTotalTests > 0, 'Test report contains no tests');
  assert.equal(report.numFailedTests, 0, 'Tests failed');
  assert.equal(report.numPendingTests, 0, 'Required tests were skipped');
  assert.equal(report.numTodoTests ?? 0, 0, 'Required tests are not implemented');
  assert.equal(report.numPassedTests, report.numTotalTests, 'Test counts do not establish that every test passed');
  assert(Array.isArray(report.testResults) && report.testResults.length > 0, 'Missing test-file results');
  for (const file of requiredFiles) assert(report.testResults.some(result => typeof result.name === 'string' && result.name.replaceAll('\\', '/').endsWith(`/${file}`) && result.status === 'passed' && (result.assertionResults?.length ?? 0) > 0), `Missing successful native test file: ${file}`);
  for (const result of report.testResults) {
    assert.equal(result.status, 'passed', `Test file did not pass: ${result.name}`);
    for (const test of result.assertionResults ?? []) assert.equal(test.status, 'passed', `Test did not run successfully: ${test.fullName}`);
  }
  return { total: report.numTotalTests, passed: report.numPassedTests, skipped: report.numPendingTests, files: report.testResults.length };
}
