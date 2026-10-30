// End-to-end tests of the built CLI on synthetic exports (no network: prices come from fixtures/prices.json).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const cli = join(here, '..', 'dist', 'cli.js')
const fx = (f) => join(here, 'fixtures', f)
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
const out = mkdtempSync(join(tmpdir(), 'ai-bill-to-focus-'))

const parse = (csv) => {
  const [header, ...rows] = csv.trim().split('\n')
  return { header: header.split(','), rows }
}

test('detect names each export', () => {
  const r = run('detect', fx('anthropic-cost.csv'), fx('anthropic-usage.csv'), fx('openai-cost.csv'), fx('openai-usage.csv'), fx('together.csv'), fx('openai-empty.csv'))
  assert.equal(r.status, 0)
  for (const s of ['Anthropic cost export', 'Anthropic usage export', 'OpenAI cost export', 'OpenAI usage export', 'Together AI cost export', 'OpenAI export with no usage']) assert.match(r.stdout, new RegExp(s))
})

test('anthropic: every token row priced exactly and passes the checker', () => {
  const file = join(out, 'anthropic.csv')
  const r = run('convert', fx('anthropic-cost.csv'), fx('anthropic-usage.csv'), '--prices', fx('prices.json'), '-o', file, '--check')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stderr, /4 rows with quantities and unit prices \(4 at Anthropic's public prices, 0 from its rounded cents\), 1 with the provider's dollars only/)
  assert.match(r.stdout, /0 errors, 0 warnings/)
  const { header, rows } = parse(readFileSync(file, 'utf8'))
  assert.equal(rows.length, 5)
  assert.ok(header.includes('x_PriceSource') && header.includes('Tags'))
  assert.equal(rows.filter((r) => r.includes(',public-price,')).length, 4)
  // 40k cache-write tokens at 1.25 x $3 / 1M
  assert.ok(rows.some((r) => r.includes('anthropic/claude-sonnet-4-6/cache-write-5m@3.75')))
})

test('anthropic --offline: unit prices from the rounded cents, no float noise', () => {
  const file = join(out, 'anthropic-offline.csv')
  const r = run('convert', fx('anthropic-cost.csv'), fx('anthropic-usage.csv'), '--offline', '-o', file, '--check')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stderr, /4 rows with quantities and unit prices \(0 at Anthropic's public prices, 4 from its rounded cents: no price list\)/)
  assert.match(r.stdout, /0 errors, 0 warnings/)
  const csv = readFileSync(file, 'utf8')
  // 0.3 / 0.1 is 2.9999999999999996 in floating point; the unit price and dollars are written clean.
  // ListCost stays the exact product 3.0 x 0.1, which the validator checks with exact equality.
  assert.ok(csv.includes('anthropic/claude-sonnet-4-6/input@3.0,'), csv)
  assert.ok(csv.includes(',0.1,3.0,0.30000000000000004,0.3,0.3,0.3,'), csv)
})

test('openai: dollars from amount_value, uncached input = input - cached', () => {
  const r = run('convert', fx('openai-cost.csv'), fx('openai-usage.csv'), '--prices', fx('prices.json'), '--check')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /provider total \$0\.63, FOCUS BilledCost total \$0\.63/)
  assert.match(r.stderr, /not yet tested on a real export/)
  const input = r.stdout.split('\n').find((l) => l.includes('openai/gpt-4o-2024-08-06/input@'))
  assert.ok(input, r.stdout)
  assert.ok(input.includes(',100000.0,Tokens,'), input) // 120000 input - 20000 cached
})

test('together: amount kept, unit neutral', () => {
  const r = run('convert', fx('together.csv'), '--check')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /provider total \$1\.76/)
  assert.match(r.stdout, /,Units,/)
})

test('usage errors exit 2 with a reason', () => {
  for (const [args, msg] of [
    [['convert', fx('openai-empty.csv')], /no usage in its date range/],
    [['convert', fx('anthropic-usage.csv')], /cost export is required/],
    [['convert', fx('anthropic-cost.csv'), fx('together.csv')], /Mixed providers/],
    [['check', fx('together.csv'), '-v', '2.0'], /FOCUS version must be/],
    [['check', fx('together.csv'), '-c', 'NOPE'], /Unknown criteria/],
    [['frobnicate'], /Unknown command/],
  ]) {
    const r = run(...args)
    assert.equal(r.status, 2, args.join(' '))
    assert.match(r.stderr, msg)
  }
})

test('check fails a raw provider export and explains it', () => {
  const r = run('check', fx('anthropic-cost.csv'))
  assert.equal(r.status, 1)
  assert.match(r.stdout, /Detected: Anthropic Console Cost export/)
  assert.match(r.stdout, /ERROR BilledCost/)
  const j = run('check', fx('anthropic-cost.csv'), '--json')
  assert.equal(j.status, 1)
  assert.equal(JSON.parse(j.stdout).version, '1.4')
})
