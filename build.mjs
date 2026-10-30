// Bundles the CLI with the FOCUS checker and converters from the web app
// (frontend/src/lib/focus-checker, copied to src/lib by scripts/sync-lib.mjs),
// so both run the same code.
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  banner: { js: '#!/usr/bin/env node' },
  define: {
    'process.env.NEXT_PUBLIC_API_BASE_URL': JSON.stringify('https://api.cognocient.com'),
    __VERSION__: JSON.stringify(version),
  },
  legalComments: 'none',
})
