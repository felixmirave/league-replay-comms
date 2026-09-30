import { parentPort, workerData } from 'node:worker_threads';
import { identifyFile } from '../library/identity';

if (!parentPort || typeof workerData?.path !== 'string') throw new Error('Invalid hash-worker request');
const port = parentPort;
const abort = new AbortController();
port.on('message', message => { if (message === 'cancel') abort.abort(); });
void identifyFile(workerData.path, abort.signal, (completed, total) => port.postMessage({ type: 'progress', completed, total }))
  .then(identity => port.postMessage({ type: 'result', identity }))
  .catch(error => port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }))
  .finally(() => port.close());
