// Copies the checker and converters from the web app into src/lib, which the
// CLI imports. In the monorepo src/lib is generated (gitignored); in the
// public repo it is committed and this script is a no-op.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'

const from = '../frontend/src/lib/focus-checker'
if (existsSync(from)) {
  rmSync('src/lib', { recursive: true, force: true })
  mkdirSync('src/lib', { recursive: true })
  for (const f of readdirSync(from)) if (f !== 'sample.ts') cpSync(`${from}/${f}`, `src/lib/${f}`)
}
if (!existsSync('src/lib/engine.ts')) throw new Error('src/lib is missing: run from the monorepo or a full checkout.')
