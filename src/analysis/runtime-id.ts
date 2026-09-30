import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Do not reuse derived observations across different decoder/model payloads. */
export async function clockRuntimeId(resources: string, decoder: string): Promise<string> {
  try {
    const [ocr, native, binary] = await Promise.all([
      readFile(join(resources, 'ocr', 'verified.json')),
      process.platform === 'win32' ? readFile(join(resources, 'bin', 'win32-x64', 'verified.json')) : Promise.resolve(Buffer.from('development-native')),
      stat(decoder, { bigint: true }),
    ]);
    return createHash('sha256').update(process.platform).update(ocr).update(native).update(`${binary.size}/${binary.mtimeNs}`).digest('hex');
  } catch {
    // Missing preparation metadata disables reuse for this launch, not manual review.
    return randomUUID();
  }
}
