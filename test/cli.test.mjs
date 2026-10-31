// End-to-end tests of the built CLI on synthetic exports (no network: prices come from fixtures/prices.json).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

test('openai: Batch line items get only Batch tokens, standard ones only standard tokens', () => {
  const r = run('convert', fx('openai-batch-cost.csv'), fx('openai-batch-usage.csv'), '--prices', fx('prices.json'), '--check')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const row = (sku) => r.stdout.split('\n').find((l) => l.includes(`${sku}@`))
  assert.ok(row('openai/gpt-4o-2024-08-06/input').includes('openai/gpt-4o-2024-08-06/input@2.5,'))
  assert.ok(row('openai/gpt-4o-2024-08-06/input').includes(',100000.0,Tokens,'))
  assert.ok(row('openai/gpt-4o-2024-08-06/input-batch').includes('openai/gpt-4o-2024-08-06/input-batch@1.25,'))
  assert.ok(row('openai/gpt-4o-2024-08-06/input-batch').includes(',400000.0,Tokens,'))
  assert.ok(row('openai/gpt-4o-2024-08-06/output-batch').includes('@5.0,'))
  assert.ok(row('openai/gpt-4o-2024-08-06/output').includes('@10.0,'))
  assert.match(r.stdout, /Input Tokens \(Batch\)/)
  assert.doesNotMatch(r.stderr, /blend/)
})

test('openai: a cost file that does not split Batch gets a blended price and a note', () => {
  // The same dollars, with each Batch line item folded into its standard one.
  const cost = readFileSync(fx('openai-batch-cost.csv'), 'utf8').split(/\r?\n/).filter((l) => !l.includes('(batch)'))
    .map((l) => l.replace(',0.25,usd,', ',0.75,usd,').replace(',0.3,usd,', ',0.8,usd,')).join('\n')
  const file = join(out, 'openai-unsplit.csv')
  writeFileSync(file, cost)
  const r = run('convert', file, fx('openai-batch-usage.csv'), '--prices', fx('prices.json'))
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /blend the two rates/)
  assert.ok(r.stdout.split('\n').find((l) => l.includes('openai/gpt-4o-2024-08-06/input@')).includes(',500000.0,Tokens,'))
})

test('format changes: unknown columns are named, non-numeric cells fail the run', () => {
  // Split on CRLF too: git on Windows checks the fixtures out with CRLF line endings.
  const lines = readFileSync(fx('openai-cost.csv'), 'utf8').trim().split(/\r?\n/)
  const extra = join(out, 'openai-extra.csv')
  writeFileSync(extra, lines.map((l, i) => l + (i ? ',0' : ',amount_tax')).join('\n'))
  const a = run('convert', extra, '--offline')
  assert.equal(a.status, 0, a.stderr)
  assert.match(a.stderr, /column this converter doesn't read: amount_tax/)

  const shifted = join(out, 'openai-shifted.csv')
  writeFileSync(shifted, lines.map((l, i) => (i === 1 ? l.replace(',0.25,usd,', ',Search,usd,') : l)).join('\n'))
  const b = run('convert', shifted, '--offline')
  assert.equal(b.status, 1, b.stderr)
  assert.match(b.stderr, /1 row was left out because a dollar or token cell wasn't a number \(for example "Search"\)/)
})

test('report: describes the files without dollars, names or fine-tune owners', () => {
  const r = run('report', fx('openai-batch-cost.csv'), fx('openai-batch-usage.csv'), '--prices', fx('prices.json'))
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /File 1: OpenAI cost export, 5 rows/)
  assert.match(r.stdout, /columns: start_time, end_time/)
  assert.match(r.stdout, / {4}"gpt-4o-2024-08-06, input \(batch\)" -> input, batch\n/)
  assert.match(r.stdout, /rows by price tier: standard 2, batch 1/)
  assert.match(r.stdout, /reconciliation: .* \+0\.0000%/)
  assert.match(r.stdout, /FOCUS 1\.4 check: 0 errors/)
  assert.match(r.stdout, /ft:gpt-4o-mini-2024-07-18:<redacted>/)
  for (const secret of ['Secret Project', 'Acme Corp', 'acme-corp', 'proj_abc', 'org_123', 'AbC123', '$', '0.25']) assert.ok(!r.stdout.includes(secret), secret)

  // An unrecognised file is still described, with its name withheld.
  const odd = join(out, 'acme-billing.csv')
  writeFileSync(odd, 'when,what,how much\n2026-10-01,thing,1\n')
  const u = run('report', odd)
  assert.equal(u.status, 1)
  assert.match(u.stdout, /File 1: not recognised, 1 row/)
  assert.match(u.stdout, /columns: when, what, how much/)
  assert.ok(!u.stdout.includes('acme'), u.stdout)
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
