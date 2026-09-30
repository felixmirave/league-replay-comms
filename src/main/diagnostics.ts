// Trace paths occur principally inside native error strings. Known paths handle
// spaces and unusual characters exactly; the fallback covers other absolute paths.
// URL alternatives preserve the local API address when no file path is involved.
const paths = /https?:\/\/[^\s'"<>]+|file:\/\/[^\r\n'"<>]+|[A-Za-z]:[\\/][^\r\n'"<>|?*]+|\\\\[^\r\n'"<>]+|\/\/[^\r\n'"<>]+|(?:^|(?<=[\s('"=:@]))\/(?!\/)[^\r\n'"<>]+/g;

export function diagnosticExport(value: unknown, includePaths: boolean, knownPaths: string[] = []): unknown {
  if (includePaths) return value;
  const known = [...new Set(knownPaths.filter(path => path.length > 1))].sort((a, b) => b.length - a.length);
  const scrub = (input: unknown): unknown => {
    if (typeof input === 'string') {
      let result = input;
      for (const path of known) result = result.split(path).join('<local path>');
      return result.replace(paths, path => /^https?:\/\//.test(path) ? path : '<local path>');
    }
    if (Array.isArray(input)) return input.map(scrub);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, child]) => [key,
      /^(?:path|filename|directory|cwd)$/i.test(key) && typeof child === 'string' ? '<local path>' : scrub(child)]));
    return input;
  };
  return scrub(value);
}
