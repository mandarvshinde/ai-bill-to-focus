// ai-bill-to-focus: AI provider bills -> FOCUS 1.4 CSV, and a FOCUS checker,
// on the command line. The checker and converters are the same code the web
// tool at cognocient.com/tools/focus-checker runs in the browser.

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { AI_CRITERIA, checkFocus, criteriaFor, VERSIONS, type ConverterId, type FocusVersion, type Report } from './lib/engine'
import { fetchPrices, parsePrices, type Account, type ConvertResult, type PriceTable } from './lib/convert-common'
import { convertAnthropic } from './lib/convert-anthropic'
import { convertOpenAI } from './lib/convert-openai'
import { convertTogether } from './lib/convert-together'
import { detectExport } from './lib/detect'

declare const __VERSION__: string

const LABEL: Record<ConverterId, string> = { anthropic: 'Anthropic', openai: 'OpenAI', together: 'Together AI' }
const UNVERIFIED: Partial<Record<ConverterId, string>> = {
  openai: 'built from OpenAI\'s documentation, not yet tested on a real export',
  together: 'built from Together AI\'s documentation, not yet tested on a real export',
}
const DEFAULT_ACCOUNT: Record<ConverterId, Account> = {
  anthropic: { id: 'anthropic-organization', name: 'My Anthropic organization' },
  openai: { id: 'openai-organization', name: 'My OpenAI organization' },
  together: { id: 'together-organization', name: 'My Together AI organization' },
}

const HELP = `ai-bill-to-focus ${__VERSION__}
Convert AI provider bills to FinOps FOCUS 1.4 CSV and check CSVs against FOCUS.
Files are read locally and never uploaded.

Usage
  ai-bill-to-focus convert <export.csv>... [options]
  ai-bill-to-focus check <file.csv> [options]
  ai-bill-to-focus detect <file.csv>...

convert
  Give the provider's cost export, plus its usage export for token quantities.
  The provider and file roles are detected from the header rows.
    Anthropic   Console Cost export (+ Usage export)        tested on real exports
    OpenAI      Usage -> Export -> Cost data (+ Completions) from documentation
    Together AI Cost analytics -> Download CSV               from documentation

  -o, --output <file>      Write the FOCUS CSV here (default: stdout)
      --account-id <id>    BillingAccountId (default: from the file, or a placeholder)
      --account-name <s>   BillingAccountName
      --prices <file>      Price list JSON (format of api.cognocient.com/api/estimate/models)
      --offline            Don't fetch the public price list (Anthropic rows keep
                           the export's rounded dollars; OpenAI skips its price sanity check)
      --check              Check the output against FOCUS 1.4 afterwards

check
  -v, --focus-version <v>  1.4 (default), 1.3 or 1.2
  -c, --criteria <list>    Applicability criteria: "ai" (default), "all", "none",
                           or comma-separated names, e.g. TAGGING_SUPPORTED
      --list-criteria      Print the criteria for the version and exit
      --json               Print the full report as JSON
      --strict             Exit non-zero on warnings too

Exit codes: 0 ok, 1 FOCUS errors found (or conversion failed), 2 bad usage.
https://www.cognocient.com/tools/focus-checker
`

class UsageError extends Error {}

const read = (file: string) => {
  try { return readFileSync(file, 'utf8') } catch (e) { throw new UsageError(`Can't read ${file}: ${(e as Error).message}`) }
}
const err = (s = '') => process.stderr.write(s + '\n')
const usd = (n: number) => `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 6 : 2)}`

async function loadPrices(file: string | undefined, offline: boolean): Promise<PriceTable | null> {
  if (file) {
    try { return parsePrices(JSON.parse(read(file))) } catch (e) { throw e instanceof UsageError ? e : new UsageError(`${file} is not a price list JSON: ${(e as Error).message}`) }
  }
  if (offline) return null
  try { return await fetchPrices() } catch (e) {
    err(`warning: couldn't fetch the public price list (${(e as Error).message}); continuing without it. Use --offline to skip.`)
    return null
  }
}

async function convert(files: string[], opts: Record<string, string | boolean | undefined>): Promise<number> {
  if (!files.length) throw new UsageError('convert needs at least one export file.')
  const slots: Partial<Record<'cost' | 'usage', { file: string; text: string }>> = {}
  let provider: ConverterId | null = null
  for (const file of files) {
    const text = read(file)
    const kind = detectExport(text)
    if (kind === 'openai-empty') throw new UsageError(`${file}: OpenAI export with no usage in its date range (only time columns). Export a range with usage.`)
    if (!kind) throw new UsageError(`${file}: not a recognised Anthropic, OpenAI or Together AI export. Run "ai-bill-to-focus detect ${basename(file)}" for details.`)
    if (provider && kind.provider !== provider) throw new UsageError(`Mixed providers: ${LABEL[provider]} and ${LABEL[kind.provider]}. Convert one provider at a time.`)
    if (slots[kind.slot]) throw new UsageError(`Two ${LABEL[kind.provider]} ${kind.slot} exports given (${slots[kind.slot]!.file}, ${file}).`)
    provider = kind.provider
    slots[kind.slot] = { file, text }
  }
  const p = provider!
  if (!slots.cost) throw new UsageError(`Only the ${LABEL[p]} usage export was given. The cost export is required; the usage export adds token quantities.`)

  const account: Account = {
    id: (opts['account-id'] as string | undefined)?.trim() || DEFAULT_ACCOUNT[p].id,
    name: (opts['account-name'] as string | undefined)?.trim() || DEFAULT_ACCOUNT[p].name,
  }
  const prices = p === 'together' ? null : await loadPrices(opts.prices as string | undefined, !!opts.offline)
  const usage = slots.usage?.text ?? null
  const result: ConvertResult =
    p === 'anthropic' ? convertAnthropic(slots.cost.text, usage, prices, account)
      : p === 'openai' ? convertOpenAI(slots.cost.text, usage, prices, account)
        : convertTogether(slots.cost.text, account)

  if (opts.output) writeFileSync(opts.output as string, result.csv)
  else process.stdout.write(result.csv)

  err(`${LABEL[p]} -> FOCUS 1.4: ${result.rows} rows${opts.output ? ` written to ${opts.output}` : ''}${UNVERIFIED[p] ? ` (converter ${UNVERIFIED[p]})` : ''}`)
  err(`  provider total ${usd(result.providerTotal)}, FOCUS BilledCost total ${usd(result.focusTotal)}`)
  err(`  ${result.exactRows} rows with quantities and unit prices, ${result.providerPricedRows} with the provider's dollars only, ${result.skippedZeroRows} zero rows skipped`)
  for (const w of result.warnings) err(`  note: ${w}`)

  if (opts.check) {
    err()
    const report = checkFocus(result.csv, '1.4', AI_CRITERIA)
    return printReport(report, `${opts.output ?? 'output'} (FOCUS 1.4)`, false)
  }
  return 0
}

function criteriaList(spec: string | undefined, version: FocusVersion): string[] {
  const all = Object.keys(criteriaFor(version))
  if (!spec || spec === 'ai') return AI_CRITERIA
  if (spec === 'all') return all
  if (spec === 'none') return []
  const list = spec.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  const unknown = list.filter((c) => !all.includes(c))
  if (unknown.length) throw new UsageError(`Unknown criteria for FOCUS ${version}: ${unknown.join(', ')}. See --list-criteria.`)
  return list
}

function printReport(r: Report, name: string, strict: boolean): number {
  const out = (s = '') => process.stdout.write(s + '\n')
  const errors = r.missing.filter((m) => m.severity === 'error').length + r.findings.filter((f) => f.severity === 'error').length
  const warnings = r.missing.filter((m) => m.severity === 'warning').length + r.findings.filter((f) => f.severity === 'warning').length

  out(`${name}: ${r.totalRows} rows, ${r.header.length} columns, checked against FOCUS ${r.version} (${r.model})`)
  if (r.checkedRows < r.totalRows) out(`  only the first ${r.checkedRows} rows were checked`)
  if (r.detected) {
    out(`\nDetected: ${r.detected.name}`)
    out(`  ${r.detected.note}`)
    if (r.detected.converter) out(`  Convert it: ai-bill-to-focus convert <files> -o focus.csv`)
  }
  if (r.missing.length) {
    out(`\nMissing columns`)
    for (const m of r.missing) out(`  ${m.severity === 'error' ? 'ERROR' : 'warn '} ${m.column}: ${m.text}`)
  }
  if (r.findings.length) {
    out(`\nRule failures`)
    for (const f of r.findings) {
      out(`  ${f.severity === 'error' ? 'ERROR' : 'warn '} ${f.id} ${f.column}: ${f.text} (${f.violations} row${f.violations === 1 ? '' : 's'})`)
      for (const s of f.samples) out(`        row ${s.row}: ${JSON.stringify(s.value)}`)
    }
  }
  if (r.suggestions.length) {
    out(`\nColumns that aren't FOCUS`)
    for (const s of r.suggestions) out(`  ${s.column} -> ${s.focus} (${s.reason})`)
  }
  out(`\n${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}; ${r.rulesPassed} rules passed, ${r.rulesNotApplicable} not applicable, ${r.rulesNotPortable} of ${r.rulesInFullSet} not checked here (need the full validator)`)
  return errors > 0 || (strict && warnings > 0) ? 1 : 0
}

function check(files: string[], opts: Record<string, string | boolean | undefined>): number {
  const version = (opts['focus-version'] as string | undefined ?? '1.4') as FocusVersion
  if (!VERSIONS.includes(version)) throw new UsageError(`FOCUS version must be one of ${VERSIONS.join(', ')}.`)
  if (opts['list-criteria']) {
    for (const [k, v] of Object.entries(criteriaFor(version))) process.stdout.write(`${k}${AI_CRITERIA.includes(k) ? ' (ai)' : ''}\n  ${v}\n`)
    return 0
  }
  if (files.length !== 1) throw new UsageError('check takes exactly one file.')
  const report = checkFocus(read(files[0]), version, criteriaList(opts.criteria as string | undefined, version))
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    const errors = report.missing.some((m) => m.severity === 'error') || report.findings.some((f) => f.severity === 'error')
    const warnings = report.missing.some((m) => m.severity === 'warning') || report.findings.some((f) => f.severity === 'warning')
    return errors || (opts.strict && warnings) ? 1 : 0
  }
  return printReport(report, basename(files[0]), !!opts.strict)
}

function detect(files: string[]): number {
  if (!files.length) throw new UsageError('detect needs a file.')
  for (const file of files) {
    const kind = detectExport(read(file))
    const report = checkFocus(read(file), '1.4', AI_CRITERIA)
    const what = kind === 'openai-empty' ? 'OpenAI export with no usage (only time columns)'
      : kind ? `${LABEL[kind.provider]} ${kind.slot} export${UNVERIFIED[kind.provider] ? ` (converter ${UNVERIFIED[kind.provider]})` : ''}`
        : report.present.length >= 10 ? `FOCUS-style file (${report.present.length} FOCUS columns); run "check" on it`
          : 'not recognised'
    process.stdout.write(`${file}: ${what}\n`)
  }
  return 0
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' },
      'account-id': { type: 'string' },
      'account-name': { type: 'string' },
      prices: { type: 'string' },
      offline: { type: 'boolean' },
      check: { type: 'boolean' },
      'focus-version': { type: 'string', short: 'v' },
      criteria: { type: 'string', short: 'c' },
      'list-criteria': { type: 'boolean' },
      json: { type: 'boolean' },
      strict: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  })
  if (values.version) { process.stdout.write(__VERSION__ + '\n'); return 0 }
  const [command, ...files] = positionals
  if (values.help || !command) { process.stdout.write(HELP); return command || values.help ? 0 : 2 }
  if (command === 'convert') return convert(files, values)
  if (command === 'check') return check(files, values)
  if (command === 'detect') return detect(files)
  throw new UsageError(`Unknown command "${command}". Commands: convert, check, detect.`)
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code },
  (e) => {
    const usage = e instanceof UsageError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
    err(`error: ${(e as Error).message}`)
    if (usage) err('Run "ai-bill-to-focus --help" for usage.')
    process.exitCode = usage ? 2 : 1
  },
)
