import { z } from 'zod';
import { probeSchema } from '../shared/media';
import { clockEvidenceSchema } from '../shared/clock';
import { cropSchema } from '../shared/geometry';
import { librarySchema as legacySchema, validateLibrary as validateLegacy, FutureLibraryError } from './legacy';
export { FutureLibraryError } from './legacy';

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const fileVersionSchema = z.object({ size: z.number().int().nonnegative().safe(), mtimeNs: z.string(), ctimeNs: z.string(), device: z.string(), inode: z.string() });
export const identitySchema = z.object({ path: z.string(), sha256: digestSchema, version: fileVersionSchema, verifiedAt: z.string() });
export type FileVersion = z.infer<typeof fileVersionSchema>;
export type FileIdentity = z.infer<typeof identitySchema>;
export const alignmentSchema = z.object({
  baseOffsetSeconds: z.number().finite(), correctionSeconds: z.number().finite(), source: z.enum(['manual', 'video-clock']),
  revision: z.number().int().nonnegative(), updatedAt: z.string(),
  clock: z.object({ crop: cropSchema, videoStreamIndex: z.number().int().nonnegative(), originSeconds: z.number().finite(), evidence: clockEvidenceSchema }).optional(),
});
export type Alignment = z.infer<typeof alignmentSchema>;
const clockSelectionSchema = z.object({ videoStreamIndex: z.number().int().nonnegative(), crop: cropSchema.optional(), revision: z.number().int().nonnegative() });
export type ClockSelection = z.infer<typeof clockSelectionSchema>;
const trackPreferenceSchema = z.object({ trackKey: z.string(), revision: z.number().int().nonnegative() });
export type TrackPreference = z.infer<typeof trackPreferenceSchema>;
const pendingSchema = z.object({
  id: z.string(), path: z.string(), version: fileVersionSchema, createdAt: z.string(),
  edits: z.record(z.string(), alignmentSchema), conflicts: z.record(z.string(), z.array(alignmentSchema)).default({}),
  preferredTrack: trackPreferenceSchema.optional(), clockSelection: clockSelectionSchema.optional(),
});
export type PendingImport = z.infer<typeof pendingSchema>;
export const timingSchema = z.object({ mediaHash: digestSchema, trackKey: z.string(), alignment: alignmentSchema, createdAt: z.string(), updatedAt: z.string() });
export type RecordingTiming = z.infer<typeof timingSchema>;
export const librarySchema = z.object({
  schemaVersion: z.literal(6), revision: z.number().int().nonnegative(),
  media: z.record(digestSchema, z.object({
    hash: digestSchema, name: z.string(), size: z.number().int().nonnegative().safe(), locations: z.array(identitySchema.omit({ sha256: true })),
    probe: z.object({ version: z.literal(1), data: probeSchema }).optional().catch(undefined),
    clockSelection: clockSelectionSchema.optional(), preferredTrack: trackPreferenceSchema.optional(), lastOpenedAt: z.string().optional(),
  })),
  timings: z.record(z.string(), timingSchema), conflicts: z.record(z.string(), z.array(alignmentSchema)),
  pendingImports: z.record(z.string(), pendingSchema),
  settings: z.object({ mediaFolders: z.array(z.string()), volume: z.number().min(0).max(100), selectedInstallation: z.string().optional() }),
  // Recovery copy only: old manually asserted replay links cannot select recordings.
  legacy: legacySchema.optional(),
});
export type LibraryData = z.infer<typeof librarySchema>;
export const emptyLibrary = (): LibraryData => ({ schemaVersion: 6, revision: 0, media: {}, timings: {}, conflicts: {}, pendingImports: {}, settings: { mediaFolders: [], volume: 100 } });
export const timingKey = (mediaHash: string, trackKey: string): string => JSON.stringify([mediaHash, trackKey]);
export const sameFileVersion = (a: FileVersion, b: FileVersion): boolean => a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.device === b.device && a.inode === b.inode;

function equivalent(a: Alignment, b: Alignment): boolean {
  return a.baseOffsetSeconds === b.baseOffsetSeconds && a.correctionSeconds === b.correctionSeconds && a.source === b.source && JSON.stringify(a.clock) === JSON.stringify(b.clock);
}
function commonAlignment(values: Alignment[]): Alignment | undefined {
  const newest = [...values].sort((a, b) => b.revision - a.revision)[0];
  return newest && values.every(value => equivalent(value, newest)) ? newest : undefined;
}
function commonTrack(values: TrackPreference[]): TrackPreference | undefined {
  const newest = [...values].sort((a, b) => b.revision - a.revision)[0];
  return newest && values.every(value => value.trackKey === newest.trackKey) ? newest : undefined;
}
function migrate(raw: unknown): LibraryData {
  const legacy = validateLegacy(raw);
  const data: LibraryData = { ...emptyLibrary(), revision: legacy.revision, settings: legacy.settings, legacy };
  for (const file of Object.values(legacy.media)) {
    const choices = Object.values(legacy.replays).filter(replay => replay.preferredRecording?.mediaHash === file.hash)
      .map(replay => ({ trackKey: replay.preferredRecording!.trackKey, revision: replay.preferenceRevision }));
    data.media[file.hash] = { ...file, preferredTrack: commonTrack(choices) };
  }
  const groups = new Map<string, typeof legacy.associations[string][]>();
  for (const item of Object.values(legacy.associations)) {
    const key = timingKey(item.mediaHash, item.trackKey); groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  for (const [key, values] of groups) {
    const alignment = commonAlignment(values.map(value => value.alignment));
    if (alignment) {
      const item = values.find(value => value.alignment === alignment)!;
      data.timings[key] = { mediaHash: item.mediaHash, trackKey: item.trackKey, alignment, createdAt: item.createdAt, updatedAt: item.updatedAt };
    } else data.conflicts[key] = values.map(value => value.alignment);
  }
  for (const item of Object.values(legacy.pendingImports)) {
    const pending: PendingImport = { id: item.id, path: item.path, version: item.version, createdAt: item.createdAt,
      edits: {}, conflicts: {}, clockSelection: item.clockSelection, preferredTrack: commonTrack(Object.values(item.preferences)) };
    for (const track of new Set(Object.values(item.edits).map(edit => edit.trackKey))) {
      const values = Object.values(item.edits).filter(edit => edit.trackKey === track).map(edit => edit.alignment), alignment = commonAlignment(values);
      if (alignment) pending.edits[track] = alignment; else pending.conflicts[track] = values;
    }
    data.pendingImports[pending.id] = pending;
  }
  return data;
}
export function validateLibrary(raw: unknown): LibraryData {
  if (raw && typeof raw === 'object' && 'schemaVersion' in raw && raw.schemaVersion !== 6) {
    if (typeof raw.schemaVersion !== 'number' || raw.schemaVersion > 6) throw new FutureLibraryError();
    raw = migrate(raw);
  }
  const data = librarySchema.parse(raw);
  for (const [hash, file] of Object.entries(data.media)) {
    if (hash !== file.hash || file.locations.some(location => location.version.size !== file.size)) throw new Error('Invalid recording identity');
  }
  for (const [key, timing] of Object.entries(data.timings)) {
    if (key !== timingKey(timing.mediaHash, timing.trackKey) || !data.media[timing.mediaHash]) throw new Error('Invalid recording timing');
  }
  for (const [key, values] of Object.entries(data.conflicts)) {
    const parts: unknown = JSON.parse(key);
    if (!Array.isArray(parts) || parts.length !== 2 || typeof parts[0] !== 'string' || !data.media[parts[0]] || typeof parts[1] !== 'string' || values.length < 2 || data.timings[key]) throw new Error('Invalid timing conflict');
  }
  for (const [id, pending] of Object.entries(data.pendingImports)) if (id !== pending.id) throw new Error('Invalid provisional import');
  return data;
}
