// A conversion report that is safe to paste into a public issue or thread:
// column names, row counts, date range, public model names, how each line item
// was read, the reconciliation gap as a percentage, and the FOCUS check
// counts. No dollar amounts, account, project, workspace or key names, and
// fine-tuned model names are cut to their base model.

import { headerOf, table, unreadColumns, type ConvertResult } from './convert-common'
import { COST_COLUMNS as ANTHROPIC_COST, USAGE_COLUMNS as ANTHROPIC_USAGE } from './convert-anthropic'
import { COST_COLUMNS as OPENAI_COST, USAGE_COLUMNS as OPENAI_USAGE, parseLineItem, usageTier } from './convert-openai'
import { COST_COLUMNS as TOGETHER_COST } from './convert-together'
import { detectExport } from './detect'
import type { Report } from './engine'

export interface ReportFile { name: string; text: string }

const KNOWN: Record<string, readonly string[]> = {
  'anthropic-cost': ANTHROPIC_COST, 'anthropic-usage': ANTHROPIC_USAGE,
  'openai-cost': OPENAI_COST, 'openai-usage': OPENAI_USAGE,
  'together-cost': TOGETHER_COST,
}
const LABEL: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', together: 'Together AI' }

// Open-weight model publishers whose names are public on Together AI. Anything
// else under an org prefix may be a customer's own fine-tune.
const PUBLIC_ORGS = new Set([
  'meta-llama', 'mistralai', 'qwen', 'deepseek-ai', 'google', 'togethercomputer', 'black-forest-labs', 'moonshotai',
  'openai', 'zai-org', 'nvidia', 'microsoft', 'baai', 'intfloat', 'salesforce', 'arcee-ai', 'lgai-exaone', 'cartesia',
  'nousresearch', 'gryphe', 'upstage', 'scb10x', 'marin-community', 'perplexity-ai', 'servicenow-ai', 'minimaxai',
  'stabilityai', 'ideogram', 'kwaivgi', 'bytedance', 'hexgrad', 'canopylabs', 'mixedbread-ai', 'thenlper', 'whereisai',
])

/** Strip anything that could name a customer from a model or line-item string. */
export function redact(s: string): string {
  return s
    // OpenAI fine-tunes: ft:<base>:<org>:<suffix>:<id>
    .replace(/\bft:([A-Za-z0-9._-]+)(:[^\s,;"')]*)?/g, (_, base) => `ft:${base}:<redacted>`)
    // org/model where org isn't a known public publisher
    .replace(/\b([A-Za-z0-9_.@-]+)\/([A-Za-z0-9_.:-]+)/g, (m, org: string) => (PUBLIC_ORGS.has(org.toLowerCase()) ? m : '<private>/<redacted>'))
}

const pct = (n: number) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(n !== 0 && Math.abs(n) < 0.0001 ? 6 : 4)}%`

function dateRange(kind: string, text: string): string | null {
  const t = table(text)
  const col = kind.startsWith('anthropic') ? 'usage_date_utc' : kind.startsWith('together') ? 'Date' : null
  const days = t.body.map((r) => {
    if (col) return t.get(r, col)?.slice(0, 10) ?? null
    const iso = t.get(r, 'start_time_iso')
    if (iso) return iso.slice(0, 10)
    const secs = Number(t.get(r, 'start_time'))
    return Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000).toISOString().slice(0, 10) : null
  }).filter((d): d is string => !!d).sort()
  return days.length ? `${days[0]} to ${days[days.length - 1]}` : null
}

const distinct = (t: ReturnType<typeof table>, col: string) => [...new Set(t.body.map((r) => t.get(r, col)).filter((v): v is string => !!v))]

/** What each file's categorical columns hold, as far as is safe to share. */
function contents(kind: string, text: string): string[] {
  const t = table(text)
  const lines: string[] = []
  const list = (label: string, values: string[], max = 25) => {
    if (values.length) lines.push(`  ${label}: ${values.slice(0, max).map(redact).join(', ')}${values.length > max ? `, and ${values.length - max} more` : ''}`)
  }
  if (kind === 'anthropic-cost') {
    list('models', distinct(t, 'model'))
    list('token_type values', distinct(t, 'token_type'))
    list('cost_type values', distinct(t, 'cost_type'))
    list('usage_type values', distinct(t, 'usage_type'))
  } else if (kind === 'anthropic-usage') {
    list('models', distinct(t, 'model_version'))
    list('usage_type values', distinct(t, 'usage_type'))
  } else if (kind === 'openai-cost') {
    // How each distinct line item shape was read, with the model name kept (redacted if fine-tuned).
    const seen = new Map<string, string>()
    for (const li of distinct(t, 'line_item')) {
      const p = parseLineItem(li)
      seen.set(redact(li), `${p.kind === 'other' ? 'kept as written' : p.kind}${p.tier === 'standard' ? '' : `, ${p.tier}`}`)
    }
    if (seen.size) lines.push('  line items, and how each was read:')
    for (const [li, how] of [...seen].slice(0, 40)) lines.push(`    "${li}" -> ${how}`)
    if (seen.size > 40) lines.push(`    and ${seen.size - 40} more`)
    list('currencies', distinct(t, 'amount_currency'))
  } else if (kind === 'openai-usage') {
    list('models', distinct(t, 'model'))
    const tiers = new Map<string, number>()
    for (const r of t.body) { const k = usageTier(t.get(r, 'batch'), t.get(r, 'service_tier')); tiers.set(k, (tiers.get(k) ?? 0) + 1) }
    if (tiers.size) lines.push(`  rows by price tier: ${[...tiers].map(([k, n]) => `${k} ${n}`).join(', ')}`)
    list('service_tier values', distinct(t, 'service_tier'))
  } else if (kind === 'together-cost') {
    list('line items', distinct(t, 'Line Item'))
    list('dimensions', distinct(t, 'Dimensions'))
  }
  return lines
}

export function shareableReport(opts: {
  tool: string
  files: ReportFile[]
  result?: ConvertResult | null
  error?: string | null
  check?: Report | null
}): string {
  const out: string[] = [
    `${opts.tool}: conversion report`,
    'Safe to share: column names, counts and public model names only. No dollar amounts, account, project or key names.',
    '',
  ]
  for (const [i, f] of opts.files.entries()) {
    const kind = detectExport(f.text)
    const k = kind && kind !== 'openai-empty' ? `${kind.provider}-${kind.slot}` : null
    const header = headerOf(f.text)
    const rows = table(f.text).body.filter((r) => r.some((c) => c.trim())).length
    out.push(`File ${i + 1}: ${kind === 'openai-empty' ? 'OpenAI export with no usage' : kind ? `${LABEL[kind.provider]} ${kind.slot} export` : 'not recognised'}, ${rows} row${rows === 1 ? '' : 's'}`)
    const range = k ? dateRange(k, f.text) : null
    if (range) out.push(`  dates: ${range}`)
    out.push(`  columns: ${header.join(', ')}`)
    if (k) {
      const unread = unreadColumns(header, KNOWN[k])
      out.push(`  columns not read by the converter: ${unread.length ? unread.join(', ') : 'none'}`)
      out.push(...contents(k, f.text))
    }
    out.push('')
  }

  if (opts.error) out.push(`Conversion failed: ${redact(opts.error)}`)
  const r = opts.result
  if (r) {
    const gap = r.providerTotal ? (r.focusTotal - r.providerTotal) / r.providerTotal : 0
    out.push(`Conversion: ${r.rows} FOCUS rows; ${r.quantityRows} with quantities and unit prices, ${r.rows - r.quantityRows} dollars only, ${r.skippedZeroRows} zero rows skipped, ${r.unreadableRows} unreadable rows left out`)
    const anthropic = opts.files.some((f) => { const k = detectExport(f.text); return !!k && k !== 'openai-empty' && k.provider === 'anthropic' })
    out.push(`  reconciliation: FOCUS BilledCost vs the provider's total ${r.providerTotal || r.focusTotal ? pct(gap) : 'n/a (both zero)'}${anthropic && r.exactRows && gap ? ' (expected: the Cost export rounds each row to the cent; exact rows use tokens x public price)' : ''}`)
    // A cell that isn't a number may be a shifted name, so its value stays out.
    for (const w of r.warnings) out.push(`  note: ${redact(w.replace(/\(for example ".*?"\)/, '(cell value withheld)'))}`)
  }
  const c = opts.check
  if (c) {
    const sev = (s: string) => c.missing.filter((m) => m.severity === s).length + c.findings.filter((f) => f.severity === s).length
    out.push(`FOCUS ${c.version} check: ${sev('error')} errors, ${sev('warning')} warnings, ${c.rulesPassed} rules passed`)
    for (const m of c.missing) out.push(`  missing ${m.column} (${m.severity})`)
    for (const f of c.findings) out.push(`  ${f.id} ${f.column}: ${f.violations} row${f.violations === 1 ? '' : 's'} (${f.severity})`)
  }
  return out.join('\n').trimEnd() + '\n'
}
