import assert from 'node:assert/strict';
import electron from 'electron';

// In Node, this package exports the executable path; inside Electron it exports
// the API described by its declarations. These scripts always run in Node.
const executable: unknown = electron;
assert(typeof executable === 'string', 'Run desktop tooling with Node, outside Electron');
const executablePath: string = executable;
export default executablePath;
