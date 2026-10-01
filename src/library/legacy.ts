import { z } from 'zod';
import { probeSchema } from '../shared/media';
import { clockEvidenceSchema } from '../shared/clock';
import { cropSchema } from '../shared/geometry';

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const fileVersionSchema = z.object({
  size: z.number().int().nonnegative().safe(), mtimeNs: z.string(), ctimeNs: z.string(),
  device: z.string(), inode: z.string(),
});
export const identitySchema = z.object({ path: z.string(), sha256: digestSchema, version: fileVersionSchema, verifiedAt: z.string() });
export type FileVersion = z.infer<typeof fileVersionSchema>;
export type FileIdentity = z.infer<typeof identitySchema>;

const alignmentSchema = z.object({
  baseOffsetSeconds: z.number().finite(), correctionSeconds: z.number().finite(),
  source: z.enum(['manual', 'video-clock']), revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
  clock: z.object({ crop: cropSchema, videoStreamIndex: z.number().int().nonnegative(), originSeconds: z.number().finite(), evidence: clockEvidenceSchema }).optional(),
});
export type Alignment = z.infer<typeof alignmentSchema>;
const locationSchema = identitySchema.omit({ sha256: true });
const fileSchema = z.object({ hash: digestSchema, name: z.string(), size: z.number().int().nonnegative().safe(), locations: z.array(locationSchema) });
export const associationSchema = z.object({
  replayHash: digestSchema, mediaHash: digestSchema, trackKey: z.string(),
  alignment: alignmentSchema, createdAt: z.string(), updatedAt: z.string(),
});
export type Association = z.infer<typeof associationSchema>;
const legacyPendingSchema = z.object({
  id: z.string(), path: z.string(), version: fileVersionSchema, replayHash: digestSchema.optional(),
  trackKey: z.string().optional(), alignment: alignmentSchema.optional(), createdAt: z.string(),
});
export const pendingKey = (replayHash: string, trackKey: string): string => JSON.stringify([replayHash, trackKey]);
const pendingEditSchema = z.object({ replayHash: digestSchema, trackKey: z.string(), alignment: alignmentSchema });
const pendingSchema = legacyPendingSchema.omit({ replayHash: true, trackKey: true, alignment: true }).extend({
  edits: z.record(z.string(), pendingEditSchema),
  preferences: z.record(digestSchema, z.object({ trackKey: z.string(), revision: z.number().int().nonnegative() })).default({}),
});
export type PendingImport = z.infer<typeof pendingSchema>;
const recordingSelectionSchema = z.object({ mediaHash: digestSchema, trackKey: z.string() });
export type RecordingSelection = z.infer<typeof recordingSelectionSchema>;
const legacyReplaySchema = fileSchema.extend({ preferredAssociation: z.string().optional(), preferenceRevision: z.number().int().nonnegative().default(0) });
export const librarySchema = z.object({
  schemaVersion: z.literal(5), revision: z.number().int().nonnegative(),
  replays: z.record(digestSchema, fileSchema.extend({ preferredRecording: recordingSelectionSchema.optional(), preferenceRevision: z.number().int().nonnegative().default(0) })),
  media: z.record(digestSchema, fileSchema.extend({ probe: z.object({ version: z.literal(1), data: probeSchema }).optional().catch(undefined) })),
  associations: z.record(z.string(), associationSchema),
  pendingImports: z.record(z.string(), pendingSchema),
  settings: z.object({ mediaFolders: z.array(z.string()), volume: z.number().min(0).max(100), selectedInstallation: z.string().optional() }),
});
export type LibraryData = z.infer<typeof librarySchema>;
export const emptyLibrary = (): LibraryData => ({ schemaVersion: 5, revision: 0, replays: {}, media: {}, associations: {}, pendingImports: {}, settings: { mediaFolders: [], volume: 100 } });
export const associationKey = (replayHash: string, mediaHash: string, trackKey: string): string => JSON.stringify([replayHash, mediaHash, trackKey]);
export const sameFileVersion = (a: FileVersion, b: FileVersion): boolean => a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.device === b.device && a.inode === b.inode;

export function validateLibrary(raw: unknown): LibraryData {
  if (raw && typeof raw === 'object' && 'schemaVersion' in raw) {
    let version = raw.schemaVersion;
    if (version === 1) {
      const legacy = librarySchema.extend({ schemaVersion: z.literal(1), replays: z.record(digestSchema, legacyReplaySchema), pendingImports: z.record(z.string(), legacyPendingSchema) }).parse(raw);
      raw = { ...legacy, schemaVersion: 2, pendingImports: Object.fromEntries(Object.entries(legacy.pendingImports).map(([id, pending]) => {
        const { replayHash, trackKey, alignment, ...base } = pending;
        return [id, { ...base, edits: replayHash && trackKey && alignment ? { [pendingKey(replayHash, trackKey)]: { replayHash, trackKey, alignment } } : {} }];
      })) };
      version = 2;
    }
    if (version === 2 || version === 3 || version === 4) {
      const legacy = librarySchema.extend({ schemaVersion: z.number(), replays: z.record(digestSchema, legacyReplaySchema) }).parse(raw);
      raw = { ...legacy, schemaVersion: 5, replays: Object.fromEntries(Object.entries(legacy.replays).map(([hash, replay]) => {
        const { preferredAssociation, ...rest } = replay;
        const association = preferredAssociation ? legacy.associations[preferredAssociation] : undefined;
        if (preferredAssociation && (!association || association.replayHash !== hash || preferredAssociation !== associationKey(hash, association.mediaHash, association.trackKey))) throw new Error('Invalid preferred recording');
        return [hash, { ...rest, preferredRecording: association && { mediaHash: association.mediaHash, trackKey: association.trackKey } }];
      })) };
    } else if (version !== 5) throw new FutureLibraryError();
  }
  const data = librarySchema.parse(raw);
  for (const [id, file] of [...Object.entries(data.replays), ...Object.entries(data.media)]) {
    if (id !== file.hash || file.locations.some(location => location.version.size !== file.size)) throw new Error('Invalid library file identity');
  }
  for (const [id, association] of Object.entries(data.associations)) {
    if (id !== associationKey(association.replayHash, association.mediaHash, association.trackKey) || !data.replays[association.replayHash] || !data.media[association.mediaHash]) throw new Error('Invalid library association');
  }
  for (const replay of Object.values(data.replays)) {
    if (replay.preferredRecording && !data.media[replay.preferredRecording.mediaHash]) throw new Error('Invalid preferred recording');
  }
  for (const [id, pending] of Object.entries(data.pendingImports)) {
    if (pending.id !== id) throw new Error('Invalid provisional import');
    for (const [key, edit] of Object.entries(pending.edits)) {
      if (key !== pendingKey(edit.replayHash, edit.trackKey) || !data.replays[edit.replayHash]) throw new Error('Invalid provisional alignment');
    }
    for (const replayHash of Object.keys(pending.preferences)) if (!data.replays[replayHash]) throw new Error('Invalid provisional preference');
  }
  return data;
}
export class FutureLibraryError extends Error { constructor() { super('This library was written by an unsupported application version. It has not been changed.'); } }
