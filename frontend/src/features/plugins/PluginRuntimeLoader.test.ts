import { describe, expect, it, vi } from 'vitest';

import {
  isLoopbackOrLocalEsmUrl,
  loadEsmUrlModule,
  rewriteRelativeEsmSpecifiers,
} from './esmUrlLoader';
import {
  evaluateSingleFileEsmModule,
  injectPluginCss,
  isPluginRuntimeActive,
  loadPluginRuntime,
  rewriteSharedBareImports,
  unloadAllPluginRuntimes,
  unloadPluginRuntime,
} from './PluginRuntimeLoader';

describe('PluginRuntimeLoader ESM fallback', () => {
  it('rewrites shared bare imports without touching nested export lists in strings', () => {
    const code = `
import { definePluginApp } from '@dimoai/plugin-sdk/app';
const note = \`
export { hidden as default }
\`;
export default definePluginApp;
`;
    const rewritten = rewriteSharedBareImports(code);
    expect(rewritten).toContain(
      'globalThis.__DIMO_HOST_MODULES__["@dimoai/plugin-sdk/app"]'
    );
    expect(rewritten).toContain('export { hidden as default }');
  });

  it('evaluates top-level export { a, b } into the module object', () => {
    const mod = evaluateSingleFileEsmModule(`
const a = 1;
const b = 2;
export { a, b };
`);
    expect(mod).toEqual({ a: 1, b: 2 });
  });

  it('evaluates top-level export { x as default }', () => {
    const mod = evaluateSingleFileEsmModule(`
function activate() { return 'ok'; }
export { activate as default };
`);
    expect(typeof mod.default).toBe('function');
    expect((mod.default as () => string)()).toBe('ok');
  });

  it('evaluates multiline export lists and shared re-exports', () => {
    const mod = evaluateSingleFileEsmModule(`
const local = 'kept';
export {
  local as alias,
  local as default
};
export { defineDimoPlugin } from '@dimoai/plugin-sdk';
`);
    expect(mod.alias).toBe('kept');
    expect(mod.default).toBe('kept');
    expect(typeof mod.defineDimoPlugin).toBe('function');
  });

  it('does not rewrite export lists that only appear inside template strings', () => {
    const mod = evaluateSingleFileEsmModule(`
const a = 7;
const source = \`
export { a, b }
\`;
export default source;
`);
    expect(mod.a).toBeUndefined();
    expect(String(mod.default)).toContain('export { a, b }');
  });
});

describe('esmUrlLoader loopback/local CSP compatibility', () => {
  it('classifies loopback and local custom-scheme URLs while rejecting remote origins', () => {
    expect(
      isLoopbackOrLocalEsmUrl('http://127.0.0.1:43210/demo/app/main.js')
    ).toBe(true);
    expect(
      isLoopbackOrLocalEsmUrl('http://localhost:5173/remoteEntry.js')
    ).toBe(true);
    expect(
      isLoopbackOrLocalEsmUrl('dimo-app://localhost/plugins/main.js')
    ).toBe(true);
    expect(isLoopbackOrLocalEsmUrl('blob:dimo-app://localhost/abc')).toBe(true);
    expect(isLoopbackOrLocalEsmUrl('https://evil.example/plugin.js')).toBe(
      false
    );
    expect(isLoopbackOrLocalEsmUrl('http://192.168.1.20:8080/plugin.js')).toBe(
      false
    );
  });

  it('rewrites relative static, side-effect, and dynamic imports against the entryUrl base', () => {
    const rewritten = rewriteRelativeEsmSpecifiers(
      [
        "import helper from './helper.js';",
        "import '../polyfill.js';",
        "export { shared } from './shared.js';",
        "const lazy = () => import('./chunk.js');",
      ].join('\n'),
      'http://127.0.0.1:43210/acme.demo/app/main.js'
    );
    expect(rewritten).toContain(
      "import helper from 'http://127.0.0.1:43210/acme.demo/app/helper.js';"
    );
    expect(rewritten).toContain(
      "import 'http://127.0.0.1:43210/acme.demo/polyfill.js';"
    );
    expect(rewritten).toContain(
      "export { shared } from 'http://127.0.0.1:43210/acme.demo/app/shared.js';"
    );
    expect(rewritten).toContain(
      "import('http://127.0.0.1:43210/acme.demo/app/chunk.js')"
    );
  });

  it('falls back to fetch + rewrite + blob import and revokes temporary Blob URL after import settles', async () => {
    let capturedBlobCode = '';
    const registeredBlobs: string[] = [];
    const revokedBlobs: string[] = [];
    const importModule = vi.fn(async (url: string) => {
      if (url.startsWith('http://127.0.0.1:')) {
        throw new TypeError('Failed to resolve bare specifier');
      }
      return { default: { loadedFrom: url } };
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          "import { definePluginApp } from '@dimoai/plugin-sdk/app';\nimport './side.js';\nexport default definePluginApp;",
          { status: 200 }
        )
    ) as unknown as typeof fetch;

    const mod = await loadEsmUrlModule(
      'http://127.0.0.1:43210/acme.demo/app/main.js',
      {
        rewriteBareImports: rewriteSharedBareImports,
        registerBlobUrl: (url) => registeredBlobs.push(url),
        revokeBlobUrl: (url) => revokedBlobs.push(url),
        importModule,
        fetchImpl,
        createBlobUrl: (code) => {
          capturedBlobCode = code;
          return 'blob:dimo-app://localhost/rewritten-1';
        },
      }
    );

    expect(mod).toEqual({
      default: { loadedFrom: 'blob:dimo-app://localhost/rewritten-1' },
    });
    expect(registeredBlobs).toEqual(['blob:dimo-app://localhost/rewritten-1']);
    expect(revokedBlobs).toEqual(['blob:dimo-app://localhost/rewritten-1']);
    expect(capturedBlobCode).toContain(
      'globalThis.__DIMO_HOST_MODULES__["@dimoai/plugin-sdk/app"]'
    );
    expect(capturedBlobCode).toContain(
      "import 'http://127.0.0.1:43210/acme.demo/app/side.js';"
    );
  });

  it('does not fetch remote non-loopback origins when direct import fails', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      loadEsmUrlModule('https://remote.example/untrusted.js', {
        rewriteBareImports: rewriteSharedBareImports,
        registerBlobUrl: () => undefined,
        importModule: async () => {
          throw new Error('CSP blocked');
        },
        fetchImpl,
      })
    ).rejects.toThrow('CSP blocked');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('PluginRuntimeLoader async generation guard and cleanup', () => {
  it('disposes a stale async module activation when unloaded mid-flight', async () => {
    let finishActivate: (() => void) | undefined;
    const disposed = vi.fn();
    const pluginId = 'test.stale-async-plugin';

    const loadPromise = loadPluginRuntime(pluginId, {
      kind: 'module',
      module: {
        activate: () =>
          new Promise<() => void>((resolve) => {
            finishActivate = () => resolve(disposed);
          }),
      },
    });

    unloadPluginRuntime(pluginId);
    finishActivate?.();
    await loadPromise;

    expect(disposed).toHaveBeenCalledTimes(1);
    expect(isPluginRuntimeActive(pluginId)).toBe(false);
  });

  it('removes orphaned plugin style nodes in unloadAllPluginRuntimes', () => {
    injectPluginCss('test.orphan-style', '.orphan { color: red; }');
    expect(
      document.querySelector('style[data-dimo-plugin="test.orphan-style"]')
    ).not.toBeNull();

    unloadAllPluginRuntimes();

    expect(
      document.querySelector('style[data-dimo-plugin="test.orphan-style"]')
    ).toBeNull();
  });
});
