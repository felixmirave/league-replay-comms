import { spawn } from 'node:child_process';
import { projectRoot, runtimeEnvironment } from './linux-runtime.ts';

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('Usage: sh scripts/linux.sh COMMAND [ARGUMENTS…]');
  const env = await runtimeEnvironment();
  const child = spawn(command, args, { cwd: projectRoot, env, stdio: 'inherit' });
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const handlers = signals.map(signal => { const handler = () => { child.kill(signal); }; process.on(signal, handler); return handler; });
  const removeHandlers = () => signals.forEach((signal, index) => process.removeListener(signal, handlers[index]!));
  child.once('error', error => { removeHandlers(); console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    removeHandlers();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
