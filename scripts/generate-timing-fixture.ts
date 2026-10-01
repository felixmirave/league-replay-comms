import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeTimingFixture } from './timing-fixture.ts';

assert(process.argv.length === 3 || process.argv.length === 4, 'Usage: node scripts/generate-timing-fixture.ts <new.wav> [duration-seconds]');
const path = resolve(process.argv[2]!);
const result = await writeTimingFixture(path, process.argv[3] === undefined ? 2400 : Number(process.argv[3]));
console.log(`Wrote ${path} and marker map: ${result.durationSeconds}s, ${result.markers.length} markers, SHA-256 ${result.sha256}`);
