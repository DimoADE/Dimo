import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { 'main/index': 'src/main/index.ts' },
    outDir: 'dist',
    format: ['cjs'],
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    clean: true,
    external: ['electron'],
    noExternal: ['electron-updater'],
    dts: false,
  },
  {
    entry: {
      'preload/index': 'src/preload/index.ts',
      'preload/webviewGuest': 'src/preload/webviewGuest.ts',
    },
    outDir: 'dist',
    format: ['cjs'],
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    clean: false,
    external: ['electron'],
    dts: false,
  },
]);
