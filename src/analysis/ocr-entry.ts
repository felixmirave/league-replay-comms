import { parentPort, workerData } from 'node:worker_threads';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { createWorker, OEM, PSM } from 'tesseract.js';
import { experimentalClockPolicy, parseClock } from './clock-fit';

if (!parentPort) throw new Error('Clock reader requires a worker port');
const port = parentPort;
void (async () => {
  const root = String(workerData.resources);
  // Explicit local files and no cache fallback: a missing resource is an error.
  await stat(join(root, 'eng.traineddata.gz'));
  await stat(join(root, 'worker.cjs'));
  let initialized = false;
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: join(root, 'worker.cjs'), langPath: root, cacheMethod: 'none', gzip: true,
    errorHandler: error => { if (!initialized) port.postMessage({ type: 'error', message: `Could not load offline clock resources: ${String(error)}` }); },
  }, { load_system_dawg: '0', load_freq_dawg: '0', load_punc_dawg: '0', load_number_dawg: '0' });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: '0123456789:', user_defined_dpi: '300' });
  initialized = true;
  let busy = false;
  port.on('message', async message => {
    if (busy || message?.type !== 'read' || typeof message.id !== 'number' || !(message.png instanceof Uint8Array) || message.png.byteLength > 8_000_000) {
      port.postMessage({ type: 'error', id: message?.id, message: 'Invalid or concurrent clock request' }); return;
    }
    busy = true;
    try {
      const png = Buffer.from(message.png);
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
      let { data } = await worker.recognize(png, {}, { text: true, blocks: false });
      const usable = (value: { text: string; confidence: number }) => value.confidence >= experimentalClockPolicy.minConfidence && parseClock(value.text) !== undefined;
      // A clock is one token. Retry its segmentation once when line recognition
      // fails; retain the strict parser/confidence gate rather than guessing digits.
      if (!usable(data)) {
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_WORD });
        const retry = await worker.recognize(png, {}, { text: true, blocks: false });
        if (usable(retry.data)) data = retry.data;
      }
      port.postMessage({ type: 'result', id: message.id, text: data.text.slice(0, 200), confidence: data.confidence });
    } catch (error) { port.postMessage({ type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error) }); }
    finally { busy = false; }
  });
  port.postMessage({ type: 'ready' });
})().catch(error => { port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }); port.close(); });
