// Optional fixture regeneration; application users never need this or a font.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const font = process.env.COMMS_TEST_FONT;
if (!font) throw new Error('Set COMMS_TEST_FONT to FreeSansBold.ttf');
const folder = await mkdtemp(join(tmpdir(), 'comms-clock-fixture-'));
try {
  const text = join(folder, 'clock.txt');
  await writeFile(text, '%{eif:floor((t+100)/60):d:2}:%{eif:mod(floor(t+100),60):d:2}');
  const escape = value => value.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "'\\''");
  const filter = `drawtext=fontfile='${escape(resolve(font))}':textfile='${escape(text)}':fontcolor=white:fontsize=48:x=20:y=20`;
  await promisify(execFile)(process.env.COMMS_TEST_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x111827:s=240x90:r=30:d=130',
    '-vf', filter, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-g', '30', '-threads', '1', '-output_ts_offset', '5', '-y', resolve('tests/fixtures/ocr/clock-video.mkv')]);
} finally { await rm(folder, { recursive: true, force: true }); }
