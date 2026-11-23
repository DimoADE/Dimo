const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const RELATIVE_STATIC_IMPORT_RE =
  /(\b(?:import|export)\b[^'"\n;]*?\bfrom\s*)(['"])(\.\.?\/[^'"]+)\2/g;
const RELATIVE_SIDE_EFFECT_IMPORT_RE = /(\bimport\s*)(['"])(\.\.?\/[^'"]+)\2/g;
const RELATIVE_DYNAMIC_IMPORT_RE =
  /(\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]+)\2(\s*\))/g;

export function isLoopbackOrLocalEsmUrl(entryUrl: string): boolean {
  try {
    const base =
      typeof window !== 'undefined' && window.location?.href
        ? window.location.href
        : 'http://localhost/';
    const parsed = new URL(entryUrl, base);
    if (parsed.protocol === 'blob:') {
      return true;
    }
    if (
      (parsed.protocol === 'dimo-app:' || parsed.protocol === 'dimo-asset:') &&
      parsed.hostname === 'localhost'
    ) {
      return true;
    }
    return (
      parsed.protocol === 'http:' &&
      LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export function rewriteRelativeEsmSpecifiers(
  code: string,
  baseUrl: string
): string {
  const resolveRelative = (specifier: string): string => {
    try {
      return new URL(specifier, baseUrl).toString();
    } catch {
      return specifier;
    }
  };
  return code
    .replace(
      RELATIVE_STATIC_IMPORT_RE,
      (_m, prefix: string, quote: string, spec: string) =>
        `${prefix}${quote}${resolveRelative(spec)}${quote}`
    )
    .replace(
      RELATIVE_SIDE_EFFECT_IMPORT_RE,
      (_m, prefix: string, quote: string, spec: string) =>
        `${prefix}${quote}${resolveRelative(spec)}${quote}`
    )
    .replace(
      RELATIVE_DYNAMIC_IMPORT_RE,
      (_m, prefix: string, quote: string, spec: string, suffix: string) =>
        `${prefix}${quote}${resolveRelative(spec)}${quote}${suffix}`
    );
}

export interface LoadEsmUrlOptions {
  rewriteBareImports: (code: string) => string;
  registerBlobUrl?: (blobUrl: string) => void;
  revokeBlobUrl?: (blobUrl: string) => void;
  importModule?: (url: string) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  createBlobUrl?: (code: string) => string;
}

export async function loadEsmUrlModule(
  entryUrl: string,
  options: LoadEsmUrlOptions
): Promise<unknown> {
  const importModule =
    options.importModule ??
    ((url: string) => import(/* @vite-ignore */ url) as Promise<unknown>);

  try {
    return await importModule(entryUrl);
  } catch (directError) {
    const fetchImpl =
      options.fetchImpl ??
      (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
    const createBlobUrl =
      options.createBlobUrl ??
      (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
        ? (code: string) =>
            URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
        : undefined);
    const revokeBlobUrl =
      options.revokeBlobUrl ??
      (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function'
        ? (url: string) => URL.revokeObjectURL(url)
        : undefined);

    if (!fetchImpl || !createBlobUrl || !isLoopbackOrLocalEsmUrl(entryUrl)) {
      throw directError;
    }

    const response = await fetchImpl(entryUrl);
    if (!response.ok) {
      throw directError;
    }
    const rawCode = await response.text();
    const rewritten = rewriteRelativeEsmSpecifiers(
      options.rewriteBareImports(rawCode),
      entryUrl
    );
    const blobUrl = createBlobUrl(rewritten);
    options.registerBlobUrl?.(blobUrl);
    try {
      return await importModule(blobUrl);
    } finally {
      revokeBlobUrl?.(blobUrl);
    }
  }
}
