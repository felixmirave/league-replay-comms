import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { body, json } from './replay-simulator.ts';
import { command, startDesktop } from './dev-desktop.ts';

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('click'), name: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('fill'), label: z.string().min(1).max(200), value: z.string().max(200) }).strict(),
  z.object({ action: z.literal('choose-file'), path: z.string().min(1).max(32768) }).strict(),
  z.object({ action: z.literal('track'), ordinal: z.number().int().min(1).max(32) }).strict(),
  z.object({ action: z.literal('volume'), value: z.number().int().min(0).max(100) }).strict(),
  z.object({ action: z.literal('screenshot'), name: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/) }).strict(),
]);
const folder = resolve('release/validation', 'session-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(folder, { recursive: true });
console.log('Building the production app…');
await command('npm', ['run', 'build']);
let session: Awaited<ReturnType<typeof startDesktop>> | undefined;
let finish: () => void = () => undefined;
const finished = new Promise<void>(resolveFinished => { finish = resolveFinished; });
let actions = Promise.resolve();
try {
  session = await startDesktop(folder, async (request, response) => {
    if (!session) { json(response, { error: 'Session is starting' }, 503); return true; }
    if (request.method === 'GET' && request.url === '/app') { json(response, await session.page.evaluate(() => window.review.snapshot())); return true; }
    if (request.method === 'POST' && request.url === '/stop') { await body(request); json(response, { stopping: true }); setTimeout(finish, 50); return true; }
    if (request.method !== 'POST' || request.url !== '/app/action') return false;
    const action = actionSchema.parse(await body(request));
    const operation = actions.then(async () => {
      const { page } = session!;
      if (action.action === 'click') await page.getByRole('button', { name: action.name, exact: true }).click();
      if (action.action === 'fill') await page.getByLabel(action.label, { exact: true }).fill(action.value);
      if (action.action === 'choose-file') await session!.selectFile(action.path);
      if (action.action === 'track') await page.locator('input[name=track]').nth(action.ordinal - 1).check();
      if (action.action === 'volume') {
        const slider = page.getByRole('slider', { name: 'Comms volume', exact: true }).first();
        await slider.focus(); await slider.press('Home');
        for (let i = 0; i < action.value; i++) await slider.press('ArrowRight');
      }
      if (action.action === 'screenshot') { const path = join(folder, action.name + '.png'); await page.screenshot({ path }); return { path }; }
      return page.evaluate(() => window.review.snapshot());
    });
    actions = operation.then(() => undefined, () => undefined);
    json(response, await operation); return true;
  });
  const metadata = { controlUrl: session.simulator.controlUrl, folder, capture: session.capture.path, latencySeconds: session.latency,
    uncertaintySeconds: session.uncertainty, pid: process.pid, limits: 'Linux virtual audio output; 128 MiB capture limit (about 23 minutes); restart for longer sessions' };
  await writeFile(join(folder, 'session.json'), JSON.stringify(metadata, null, 2));
  console.log(JSON.stringify(metadata, null, 2));
  console.log('Replay: GET /state, POST /control. App: GET /app, POST /app/action. End: POST /stop with {}.');
  process.once('SIGINT', finish); process.once('SIGTERM', finish);
  session.app.process().once('exit', finish);
  await finished;
  await actions;
} finally {
  if (session) {
    try {
      await session.app.context().tracing.stop({ path: join(folder, 'playwright.zip') });
    } finally {
      await writeFile(join(folder, 'replay-timeline.json'), JSON.stringify(session.simulator.timeline.events, null, 2));
      await session.close();
    }
  }
  console.log('Session ended. Evidence:', folder);
}
