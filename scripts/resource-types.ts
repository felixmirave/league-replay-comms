/** Shapes of pinned build inputs; verification scripts also check their contents at runtime. */
export interface NativeManifest {
  platform: string;
  artifacts: { name: string; sha256: string; url: string; root?: string; binaryDirectory?: string;
    requiredFiles: string[]; documentationFiles: string[] }[];
}
export interface PackageLock {
  packages: Record<string, { version?: string; dev?: boolean; resolved?: string }>;
}
