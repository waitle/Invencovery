import { defineConfig } from 'tsup';

// Single self-contained ESM bundle: the plugin runs without node_modules.
// The createRequire banner lets bundled CJS dependencies call require() on Node builtins.
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  noExternal: [/.*/],
  // tsup strips the node: prefix by default; node:sqlite exists only with the prefix.
  removeNodeProtocol: false,
  splitting: false,
  sourcemap: false,
  dts: false,
  clean: true,
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __rwCreateRequire } from 'node:module';",
      'const require = __rwCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});
