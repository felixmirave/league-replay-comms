export type ConfigInspection =
  | { state: 'enabled' }
  | { state: 'disabled'; missing: 'section' | 'key' | false }
  | { state: 'ambiguous'; reason: string };

interface ConfigText { text: string; encoding: 'utf8' | 'utf16le'; bom: Buffer }
interface Line { text: string; start: number; end: number }
interface Parsed {
  source: ConfigText;
  general?: { start: number; end: number };
  setting?: { value: string; start: number; end: number };
}

function decode(bytes: Buffer): ConfigText {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    if (bytes.length % 2) throw new Error('Incomplete UTF-16 configuration');
    const text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    if (text.includes('\0')) throw new Error('Unsupported configuration encoding');
    return { text, encoding: 'utf16le', bom: bytes.subarray(0, 2) };
  }
  const bomLength = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(bomLength));
  if (text.includes('\0')) throw new Error('Unsupported configuration encoding');
  return { text, encoding: 'utf8', bom: bytes.subarray(0, bomLength) };
}

function parse(bytes: Buffer): Parsed {
  const source = decode(bytes);
  const lines: Line[] = [];
  const pattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  for (const match of source.text.matchAll(pattern)) {
    if (!match[0]) continue;
    lines.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  let general: Parsed['general'];
  let setting: Parsed['setting'];
  let insideGeneral = false;
  for (const line of lines) {
    const stripped = line.text.replace(/[\r\n]+$/, '');
    const trimmed = stripped.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const section = stripped.match(/^[\t ]*\[([^\]\r\n]+)\][\t ]*(?:[;#].*)?$/);
    if (section) {
      if (insideGeneral && general) general.end = line.start;
      insideGeneral = section[1]!.trim().toLowerCase() === 'general';
      if (insideGeneral) {
        if (general) throw new Error('Multiple [General] sections require manual review');
        general = { start: line.end, end: source.text.length };
      }
      continue;
    }
    if (trimmed.startsWith('[')) throw new Error('Malformed configuration section');
    if (!insideGeneral) continue;
    const key = stripped.match(/^([\t ]*EnableReplayApi[\t ]*=[\t ]*)([^;#]*)(.*)$/i);
    if (!key) {
      if (/^EnableReplayApi\b/i.test(trimmed)) throw new Error('Malformed EnableReplayApi setting');
      continue;
    }
    if (setting) throw new Error('Duplicate EnableReplayApi settings require manual review');
    const value = key[2]!.trim();
    if (value !== '0' && value !== '1') throw new Error('EnableReplayApi must be 0 or 1');
    const start = line.start + key[1]!.length + key[2]!.length - key[2]!.trimStart().length;
    setting = { value, start, end: start + value.length };
  }
  return { source, general, setting };
}

export function inspectReplayConfig(bytes: Buffer): ConfigInspection {
  try {
    const { general, setting } = parse(bytes);
    if (setting?.value === '1') return { state: 'enabled' };
    return { state: 'disabled', missing: !general ? 'section' : !setting ? 'key' : false };
  } catch (error) { return { state: 'ambiguous', reason: error instanceof Error ? error.message : String(error) }; }
}

/** Produces the minimal byte-preserving edit. Backups/locking belong to the file writer. */
export function enableReplayConfig(bytes: Buffer): Buffer {
  const { source, general, setting } = parse(bytes);
  if (setting?.value === '1') return Buffer.from(bytes);
  const eol = source.text.match(/\r\n|\n|\r/)?.[0] ?? '\r\n';
  let changed: string;
  if (setting) {
    changed = source.text.slice(0, setting.start) + '1' + source.text.slice(setting.end);
  } else if (general) {
    const before = source.text.slice(0, general.end);
    const separator = before && !/[\r\n]$/.test(before) ? eol : '';
    changed = before + separator + `EnableReplayApi=1${eol}` + source.text.slice(general.end);
  } else {
    const separator = source.text && !/[\r\n]$/.test(source.text) ? eol : '';
    changed = source.text + separator + `[General]${eol}EnableReplayApi=1${eol}`;
  }
  return Buffer.concat([source.bom, Buffer.from(changed, source.encoding)]);
}
