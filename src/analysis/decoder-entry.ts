import { parentPort, workerData } from 'node:worker_threads';
import { MediaDecoder } from './decoder';
import { decodeRequestSchema } from '../shared/analysis';

if (!parentPort) throw new Error('Preview decoder requires a worker');
const port = parentPort;
const abort = new AbortController();
port.on('message', message => { if (message?.type === 'cancel') abort.abort(); });
void (async () => {
  try {
    if (typeof workerData?.executable !== 'string') throw new Error('Decoder executable is missing');
    const request = decodeRequestSchema.parse(workerData.request);
    const result = await new MediaDecoder(workerData.executable).decode(request, abort.signal);
    port.postMessage({ type: 'result', result });
  } catch (error) { port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
  finally { port.close(); }
})();
