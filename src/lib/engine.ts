// FOCUS checker engine — runs the official FinOps Foundation rule models in
// the browser. The rule files are generated from focus-validator by
// backend/scripts/build_focus_checker_rules.py; this file ports the check
// functions those rules use, with the validator's semantics (SQL three-valued
// logic: a check on a null cell is "unknown", which is never a violation).

import rules12 from './rules-1.2.json'
import rules13 from './rules-1.3.json'
import rules14 from './rules-1.4.json'

export type FocusVersion = '1.2' | '1.3' | '1.4'

type Req = { CheckFunction: string; [k: string]: unknown }

interface PresenceRule { id: string; col: string; kw: string; text: string; crit: string[] }
interface CheckRule extends PresenceRule { req: Req; cond: Req | null }
interface RuleFile {
  version: string
  model: string
  criteria: Record<string, string>
  currencies: string[]
  presence: PresenceRule[]
  checks: CheckRule[]
  skipped: { dynamic: number; unported: number }
}

const RULES: Record<FocusVersion, RuleFile> = {
  '1.2': rules12 as RuleFile,
  '1.3': rules13 as RuleFile,
  '1.4': rules14 as RuleFile,
}

export const VERSIONS: FocusVersion[] = ['1.4', '1.3', '1.2']
export const MAX_CHECKED_ROWS = 50_000

// The capabilities that honestly fit a direct AI API bill (OpenAI, Anthropic, ...):
// named accounts, tags, metered usage, published unit prices. No regions,
// commitments, negotiated pricing or sub-accounts the provider defines.
export const AI_CRITERIA = ['ACCOUNT_NAMING_SUPPORTED', 'TAGGING_SUPPORTED', 'USAGE_MEASUREMENT_SUPPORTED', 'UNIT_PRICING_SUPPORTED', 'PUBLIC_PRICE_LIST_SUPPORTED']

export function criteriaFor(version: FocusVersion): Record<string, string> {
  return RULES[version].criteria
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/** RFC 4180 parser: quoted fields, doubled quotes, CRLF, BOM. Detects ; and tab. */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'))
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const)
  const delim = counts.reduce((a, b) => (b[1] > a[1] ? b : a))[0]

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

// ── Cell semantics (match the validator's Polars CSV load) ──────────────────

// Polars reads these as null, alongside empty cells.
const NULL_TOKENS = new Set(['', 'NULL', 'INVALID', 'INVALID_COST', 'BAD_DATE', 'INVALID_DECIMAL', 'INVALID_INT'])
const INT_RE = /^[+-]?\d+$/
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
const NUMERIC_FORMAT_RE = /^[+-]?([0-9]*[.])?[0-9]+([eE][+-]?[0-9]+)?$/
const DATETIME_TYPE_RE = /^[0-9]{4}-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]Z$/
const DATETIME_FORMAT_RE = /^[0-9]{4}-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]Z?$/
const ASCII_RE = /^[\x00-\x7F]*$/
const CURRENCY_RE = /^[A-Z]{3}$/

type Inferred = 'int' | 'float' | 'string' | 'null'

// FOCUS UnitFormat, ported from FormatUnitGenerator._generate_unit_format_regex.
const UNIT_RE = (() => {
  const data = 'b|Kb|Mb|Gb|Tb|Pb|Eb|B|KB|MB|GB|TB|PB|EB|Kib|Mib|Gib|Tib|Pib|Eib|KiB|MiB|GiB|TiB|PiB|EiB'
  const ts = 'Year|Month|Day|Hour|Minute|Second'
  const tp = 'Years|Months|Days|Hours|Minutes|Seconds'
  const count = '[A-Za-z][A-Za-z0-9]*(?:\\s+[A-Za-z][A-Za-z0-9]*)*'
  const patterns = [
    `^(${data}|${ts}|${tp}|${count})$`,
    `^(${data}|${count})-(${tp})$`,
    `^(${data}|${count}|${tp})/(${ts})$`,
    `^[0-9]+ (${data}|${ts}|${tp}|${count})$`,
    `^(${data}|${count}|${tp})/[0-9]+ (${tp})$`,
  ]
  return new RegExp(patterns.map((p) => `(${p})`).join('|'))
})()

class Table {
  readonly index: Map<string, number>
  readonly types: Inferred[]
  constructor(readonly header: string[], readonly rows: (string | null)[][]) {
    this.index = new Map(header.map((h, i) => [h, i]))
    // Polars infers each column's type from the first 10,000 rows.
    this.types = header.map((_, c) => {
      let t: Inferred = 'null'
      for (let r = 0; r < Math.min(rows.length, 10_000); r++) {
        const v = rows[r][c]
        if (v === null) continue
        if (INT_RE.test(v)) { if (t === 'null') t = 'int' }
        else if (FLOAT_RE.test(v)) t = 'float'
        else return 'string'
      }
      return t
    })
  }
  has(col: string) { return this.index.has(col) }
  get(row: (string | null)[], col: string) { return row[this.index.get(col)!] ?? null }
  type(col: string) { return this.types[this.index.get(col)!] }
}

// ── Check functions ─────────────────────────────────────────────────────────

/** true = valid, false = violation, null = unknown (SQL NULL; not a violation). */
type Tri = boolean | null

function sameValue(cell: string, value: unknown): boolean {
  if (typeof value === 'number') return Number(cell) === value
  if (typeof value === 'boolean') return cell.toLowerCase() === String(value)
  return cell === String(value)
}

function num(v: string | null): number | null {
  if (v === null) return null
  const n = Number(v.trim())
  return Number.isFinite(n) ? n : null
}

function compare(a: string, b: string, op: string): boolean {
  const na = num(a), nb = num(b)
  const [x, y]: [number | string, number | string] = na !== null && nb !== null ? [na, nb] : [a, b]
  switch (op) {
    case '=': return x === y
    case '!=': case '<>': return x !== y
    case '>': return x > y
    case '>=': return x >= y
    case '<': return x < y
    case '<=': return x <= y
  }
  return true
}

function evalRow(req: Req, t: Table, row: (string | null)[], currencies: Set<string>): Tri {
  const f = req.CheckFunction
  if (f === 'AND' || f === 'OR') {
    const results = (req.Items as Req[]).map((i) => evalRow(i, t, row, currencies))
    if (f === 'AND') return results.includes(false) ? false : results.every((r) => r === true) ? true : null
    return results.includes(true) ? true : results.every((r) => r === false) ? false : null
  }
  const col = req.ColumnName as string
  const v = col !== undefined ? t.get(row, col) : null
  switch (f) {
    case 'CheckValue':
      if (req.Value === null) return v === null
      return v === null ? null : sameValue(v, req.Value)
    case 'CheckNotValue':
      if (req.Value === null) return v !== null
      return v === null ? null : !sameValue(v, req.Value)
    case 'TypeString': return v === null ? null : t.type(col) === 'string'
    case 'TypeDecimal': return v === null ? null : t.type(col) === 'float'
    case 'TypeDateTime': return v === null ? null : DATETIME_TYPE_RE.test(v)
    case 'FormatNumeric': return v === null ? null : NUMERIC_FORMAT_RE.test(v.trim())
    case 'FormatString': return v === null ? null : ASCII_RE.test(v)
    case 'FormatDateTime': return v === null ? null : DATETIME_FORMAT_RE.test(v) && !Number.isNaN(Date.parse(v.endsWith('Z') ? v : v + 'Z'))
    case 'FormatCurrency': return v === null ? null : CURRENCY_RE.test(v.trim())
    case 'FormatBillingCurrencyCode':
    case 'CheckNationalCurrency': return v === null ? null : currencies.has(v.trim())
    case 'FormatJSON':
      if (v === null) return null
      try { JSON.parse(v); return true } catch { return false }
    case 'FormatKeyValue': return v === null ? null : isKeyValue(v)
    case 'FormatUnit': return v === null ? null : UNIT_RE.test(v)
    case 'CheckGreaterOrEqualThanValue': { const n = num(v); return n === null ? null : n >= Number(req.Value) }
    case 'CheckGreaterThanValue': { const n = num(v); return n === null ? null : n > Number(req.Value) }
    case 'CheckLessOrEqualThanValue': { const n = num(v); return n === null ? null : n <= Number(req.Value) }
    case 'CheckRegexMatch': return v === null ? null : new RegExp(req.Pattern as string).test(v)
    case 'CheckStringEndsWith': return v === null ? null : v.endsWith(String(req.Value))
    case 'CheckSameValue':
    case 'CheckNotSameValue': {
      const a = t.get(row, req.ColumnAName as string), b = t.get(row, req.ColumnBName as string)
      if (a === null || b === null) return null
      return f === 'CheckSameValue' ? a === b : a !== b
    }
    case 'CheckColumnComparison': {
      const a = t.get(row, req.ColumnAName as string), b = t.get(row, req.ColumnBName as string)
      return a === null || b === null ? null : compare(a, b, req.Comparator as string)
    }
    case 'ColumnByColumnEqualsColumnValue': {
      // Exact float equality, as the official validator checks it.
      const a = num(t.get(row, req.ColumnAName as string))
      const b = num(t.get(row, req.ColumnBName as string))
      const r = num(t.get(row, req.ResultColumnName as string))
      return a === null || b === null || r === null ? null : a * b === r
    }
  }
  return null
}

/** FOCUS KeyValueFormat: a JSON object with unique keys whose values are
 *  number, string, boolean or null. (focus-validator only checks the JSON parses.) */
function isKeyValue(v: string): boolean {
  let parsed: unknown
  try { parsed = JSON.parse(v) } catch { return false }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  if (Object.values(parsed).some((x) => x !== null && typeof x === 'object')) return false
  // JSON.parse keeps the last of duplicate keys, so count the keys in the text.
  const keys = [...v.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map((m) => m[1])
  return new Set(keys).size === keys.length
}

function columnsOf(req: Req | null, out = new Set<string>()): Set<string> {
  if (!req) return out
  for (const k of ['ColumnName', 'ColumnAName', 'ColumnBName', 'ResultColumnName']) {
    if (typeof req[k] === 'string') out.add(req[k] as string)
  }
  for (const item of (req.Items as Req[] | undefined) ?? []) columnsOf(item, out)
  return out
}

// ── Report ──────────────────────────────────────────────────────────────────

export type Severity = 'error' | 'warning'

export interface Finding {
  id: string
  column: string
  severity: Severity
  text: string
  violations: number
  /** Up to three examples: 1-based data row number and the offending value. */
  samples: { row: number; value: string }[]
}

export interface ColumnStatus { column: string; severity: Severity; text: string; criteria: string[] }

export interface Suggestion { column: string; focus: string; reason: string }

export interface Report {
  version: FocusVersion
  model: string
  totalRows: number
  checkedRows: number
  header: string[]
  /** A provider export recognised by its headers. */
  detected: { name: string; note: string; converter?: ConverterId } | null
  missing: ColumnStatus[]
  present: string[]
  customColumns: string[]
  unknownColumns: string[]
  suggestions: Suggestion[]
  findings: Finding[]
  rulesPassed: number
  rulesNotApplicable: number
  rulesInFullSet: number
  rulesNotPortable: number
}

const severityOf = (kw: string): Severity => (kw.startsWith('MUST') ? 'error' : 'warning')

// A rule with several criteria needs all of them: the spec sentences read "supports X and
// publishes Y". (focus-validator uses any(), which demands virtual-currency columns from
// anyone with a public price list.)
const applies = (crit: string[], declared: Set<string>) => crit.every((c) => declared.has(c))

// Columns renamed or removed between versions.
const RENAMED: Record<string, string> = {
  ProviderName: 'ServiceProviderName',
  PublisherName: 'ServiceProviderName or HostProviderName',
}

// Common headers in provider and cloud exports, normalized (lowercase, no separators).
const SYNONYMS: Record<string, string> = {
  cost: 'BilledCost', amount: 'BilledCost', amountvalue: 'BilledCost', costusd: 'BilledCost', totalcost: 'BilledCost', spend: 'BilledCost', netcost: 'EffectiveCost', listcost: 'ListCost',
  currency: 'BillingCurrency', amountcurrency: 'BillingCurrency',
  date: 'ChargePeriodStart', usagedate: 'ChargePeriodStart', day: 'ChargePeriodStart', starttime: 'ChargePeriodStart', periodstart: 'ChargePeriodStart', startingat: 'ChargePeriodStart', timestamp: 'ChargePeriodStart',
  endtime: 'ChargePeriodEnd', periodend: 'ChargePeriodEnd', endingat: 'ChargePeriodEnd',
  model: 'SkuId (and model identity in SkuPriceDetails)', modelname: 'SkuId (and model identity in SkuPriceDetails)',
  lineitem: 'ChargeDescription', description: 'ChargeDescription', costtype: 'ChargeDescription',
  projectid: 'SubAccountId', workspaceid: 'SubAccountId', project: 'SubAccountName', projectname: 'SubAccountName', workspace: 'SubAccountName', workspacename: 'SubAccountName',
  organizationid: 'BillingAccountId', orgid: 'BillingAccountId', accountid: 'BillingAccountId', organizationname: 'BillingAccountName', accountname: 'BillingAccountName',
  tags: 'Tags', labels: 'Tags', metadata: 'Tags',
  quantity: 'ConsumedQuantity', usagequantity: 'ConsumedQuantity', tokens: 'ConsumedQuantity', inputtokens: 'ConsumedQuantity (one row per token type)', outputtokens: 'ConsumedQuantity (one row per token type)', unit: 'ConsumedUnit', usageunit: 'ConsumedUnit',
  provider: 'ServiceProviderName', vendor: 'ServiceProviderName', service: 'ServiceName', servicename: 'ServiceName', product: 'ServiceName',
  region: 'RegionId', location: 'RegionId', invoiceid: 'InvoiceId', unitprice: 'ListUnitPrice', price: 'ListUnitPrice',
  // Anthropic Console Usage export
  usagedateutc: 'ChargePeriodStart (as 2026-10-01T00:00:00Z) and ChargePeriodEnd',
  modelversion: 'SkuId (and model identity in SkuPriceDetails)',
  usageinputtokensnocache: 'ConsumedQuantity on its own row (uncached input)',
  usageinputtokenscachewrite5m: 'ConsumedQuantity on its own row (cache write, 5 min)',
  usageinputtokenscachewrite1h: 'ConsumedQuantity on its own row (cache write, 1 hour)',
  usageinputtokenscacheread: 'ConsumedQuantity on its own row (cache read)',
  usageoutputtokens: 'ConsumedQuantity on its own row (output)',
  websearchcount: 'ConsumedQuantity on its own row (web searches)',
}

// Provider exports recognised by their headers, to explain what the file is.
export type ConverterId = 'anthropic' | 'openai' | 'together'

// exact: the header must be exactly these columns.
const KNOWN_EXPORTS: { match: string[]; exact?: boolean; name: string; note: string; converter?: ConverterId }[] = [
  {
    match: ['usage_date_utc', 'token_type', 'cost_usd', 'list_price_usd', 'cost_type'],
    name: 'Anthropic Console Cost export',
    converter: 'anthropic',
    note: 'One row per day, model, API key and token type, with dollars rounded to the cent. It is close to FOCUS grain already: it needs FOCUS column names, full UTC timestamps, and token quantities and unit prices from the matching Usage export.',
  },
  {
    match: ['usage_date_utc', 'usage_input_tokens_no_cache', 'usage_input_tokens_cache_read'],
    name: 'Anthropic Console Usage export',
    converter: 'anthropic',
    note: 'It has token counts per day, model, API key and workspace, but no costs. FOCUS needs one priced row per token type: uncached input, the two cache-write durations, cache reads and output. Anthropic counts these separately (cache tokens are not part of the uncached input count), so they add up without double counting. The Cost page in the Console (platform.claude.com/cost) exports the dollar amounts.',
  },
  {
    match: ['amount_value', 'line_item'],
    name: 'OpenAI Cost export',
    note: 'One row per time bucket and line item (a model plus a token type, such as "cached input"), with dollars in amount_value. FOCUS needs the model and token type split into SKU columns, full UTC timestamps, and token quantities from the Completions usage export.',
    converter: 'openai',
  },
  {
    match: ['input_tokens', 'output_tokens', 'num_model_requests'],
    name: 'OpenAI Completions usage export',
    note: 'Token counts per time bucket, but no costs. Note that OpenAI counts cached input inside input_tokens, so uncached input is input_tokens minus input_cached_tokens. The Cost export carries the dollars.',
    converter: 'openai',
  },
  {
    match: ['start_time', 'end_time', 'start_time_iso', 'end_time_iso'],
    exact: true,
    name: 'OpenAI export with no usage',
    note: 'OpenAI writes only the time-bucket columns when the date range has no usage for that export type. Pick a range with usage and export again.',
  },
  {
    match: ['Date', 'Line Item', 'Quantity', 'Unit Price (USD)', 'Amount (USD)'],
    name: 'Together AI cost analytics export',
    note: 'One row per day and line item, with quantity, unit price and amount. FOCUS needs its own column names, full UTC timestamps and SKU columns.',
    converter: 'together',
  },
]

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export function checkFocus(text: string, version: FocusVersion, declaredCriteria: string[]): Report {
  const rules = RULES[version]
  const declared = new Set(declaredCriteria)
  const currencies = new Set(rules.currencies)

  const parsed = parseCsv(text)
  if (parsed.length === 0) throw new Error('The file is empty.')
  const header = parsed[0].map((h) => h.trim())
  const body = parsed.slice(1)
  const rows = body.slice(0, MAX_CHECKED_ROWS).map((r) =>
    header.map((_, i) => (NULL_TOKENS.has(r[i] ?? '') ? null : (r[i] as string))),
  )
  const t = new Table(header, rows)

  // Presence: the strongest applicable rule per FOCUS column.
  const focusColumns = new Set(rules.presence.map((p) => p.col))
  const required = new Map<string, ColumnStatus>()
  for (const p of rules.presence) {
    if (!applies(p.crit, declared)) continue
    const status = { column: p.col, severity: severityOf(p.kw), text: p.text, criteria: p.crit }
    const prev = required.get(p.col)
    if (!prev || (prev.severity === 'warning' && status.severity === 'error')) required.set(p.col, status)
  }
  const missing = [...required.values()].filter((s) => !t.has(s.column))
    .sort((a, b) => (a.severity === b.severity ? a.column.localeCompare(b.column) : a.severity === 'error' ? -1 : 1))
  const present = header.filter((h) => focusColumns.has(h))
  const customColumns = header.filter((h) => h.startsWith('x_'))
  const unknownColumns = header.filter((h) => !focusColumns.has(h) && !h.startsWith('x_'))

  const byNorm = new Map([...focusColumns].map((c) => [norm(c), c]))
  const suggestions: Suggestion[] = unknownColumns.map((h) => {
    if (/^tags?[/.:_-]./i.test(h)) return { column: h, focus: 'Tags', reason: 'FOCUS has one Tags column: a JSON object, e.g. {"team":"search"}' }
    if (RENAMED[h]) return { column: h, focus: RENAMED[h], reason: `Not a FOCUS ${version} column` }
    const exact = byNorm.get(norm(h))
    if (exact) return { column: h, focus: exact, reason: 'Same column, FOCUS spelling' }
    const syn = SYNONYMS[norm(h)]
    if (syn) return { column: h, focus: syn, reason: 'Likely mapping' }
    return { column: h, focus: `x_${h.replace(/[^A-Za-z0-9_]/g, '')}`, reason: 'Not in FOCUS; custom columns must start with x_' }
  })

  const findings: Finding[] = []
  let passed = 0, notApplicable = 0
  for (const rule of rules.checks) {
    const needed = columnsOf(rule.req, columnsOf(rule.cond))
    if (!applies(rule.crit, declared) || ![...needed].every((c) => t.has(c))) { notApplicable++; continue }

    let violations = 0
    const samples: Finding['samples'] = []
    const f = rule.req.CheckFunction
    if (f === 'CheckDistinctCount' || f === 'CheckNoDuplicates') {
      const a = (f === 'CheckDistinctCount' ? rule.req.ColumnAName : rule.req.ColumnName) as string
      const groups = new Map<string | null, { distinct: Set<string>; count: number; first: number }>()
      rows.forEach((row, i) => {
        if (rule.cond && evalRow(rule.cond, t, row, currencies) !== true) return
        const key = t.get(row, a)
        const g = groups.get(key) ?? { distinct: new Set<string>(), count: 0, first: i }
        g.count++
        const b = f === 'CheckDistinctCount' ? t.get(row, rule.req.ColumnBName as string) : null
        if (b !== null) g.distinct.add(b)
        groups.set(key, g)
      })
      for (const [key, g] of groups) {
        const bad = f === 'CheckDistinctCount' ? g.distinct.size !== Number(rule.req.ExpectedCount) : key !== null && g.count > 1
        if (!bad) continue
        violations++
        if (samples.length < 3) samples.push({ row: g.first + 1, value: `${key ?? 'null'}${f === 'CheckDistinctCount' ? ` → ${[...g.distinct].join(', ') || 'null'}` : ''}` })
      }
    } else {
      rows.forEach((row, i) => {
        if (rule.cond && evalRow(rule.cond, t, row, currencies) !== true) return
        if (evalRow(rule.req, t, row, currencies) !== false) return
        violations++
        if (samples.length < 3) samples.push({ row: i + 1, value: rule.col && t.has(rule.col) ? (t.get(row, rule.col) ?? 'null') : '' })
      })
    }
    if (violations === 0) { passed++; continue }
    findings.push({ id: rule.id, column: rule.col, severity: severityOf(rule.kw), text: explain(rule, t), violations, samples })
  }
  findings.sort((a, b) => (a.severity === b.severity ? b.violations - a.violations : a.severity === 'error' ? -1 : 1))

  return {
    version,
    model: rules.model,
    totalRows: body.length,
    checkedRows: rows.length,
    header,
    detected: KNOWN_EXPORTS.find((k) => k.match.every((c) => header.includes(c)) && (!k.exact || header.length === k.match.length)) ?? null,
    missing,
    present,
    customColumns,
    unknownColumns,
    suggestions,
    findings,
    rulesPassed: passed,
    rulesNotApplicable: notApplicable,
    rulesInFullSet: rules.checks.length + rules.skipped.dynamic + rules.skipped.unported,
    rulesNotPortable: rules.skipped.dynamic + rules.skipped.unported,
  }
}

/** The spec sentence, plus a hint where the validator's CSV typing is the cause. */
function explain(rule: CheckRule, t: Table): string {
  const f = rule.req.CheckFunction
  const col = rule.req.ColumnName as string
  if (f === 'TypeDecimal' && t.type(col) === 'int') return `${rule.text} Every value parsed as a whole number, so the column reads as an integer: write decimals (e.g. 0.0).`
  if (f === 'TypeString' && (t.type(col) === 'int' || t.type(col) === 'float')) return `${rule.text} Every value is numeric, so CSV readers type the column as a number. FOCUS treats it as a string; tools that load the CSV untyped will be fine.`
  if (f === 'TypeDateTime' || f === 'FormatDateTime') return `${rule.text} Expected UTC ISO 8601, e.g. 2026-10-01T00:00:00Z.`
  return rule.text
}
