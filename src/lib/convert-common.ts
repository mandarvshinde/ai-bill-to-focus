// Shared pieces of the provider-export -> FOCUS 1.4 converters. Column set and
// conventions mirror the proxy's own export (backend/app/chargeback.py).

import { parseCsv } from './engine'

export interface ModelPrice { input: number; output: number; cacheRead: number }
export type PriceTable = Record<string, ModelPrice>

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000'

/** The catalogue's JSON (GET /api/estimate/models) as a price table. */
export function parsePrices(data: { models: { model: string; input_per_1m: number; output_per_1m: number; cache_read_per_1m: number }[] }): PriceTable {
  return Object.fromEntries(data.models.map((m) => [m.model, { input: m.input_per_1m, output: m.output_per_1m, cacheRead: m.cache_read_per_1m }]))
}

/** Public per-1M prices from the Cognocient AI catalogue. Sends nothing about the file. */
export async function fetchPrices(base = API_BASE): Promise<PriceTable> {
  const res = await fetch(`${base}/api/estimate/models`)
  if (!res.ok) throw new Error(`price list: HTTP ${res.status}`)
  return parsePrices(await res.json())
}

export const FOCUS_14_COLUMNS = [
  'BillingAccountId', 'BillingAccountName', 'BillingCurrency',
  'BillingPeriodStart', 'BillingPeriodEnd', 'ChargePeriodStart', 'ChargePeriodEnd',
  'ChargeCategory', 'ChargeClass', 'ChargeDescription', 'ChargeFrequency',
  'InvoiceId', 'InvoiceIssuerName', 'ServiceProviderName', 'HostProviderName',
  'ServiceName', 'ServiceCategory', 'ServiceSubcategory',
  'SkuId', 'SkuPriceId', 'SkuMeter', 'SkuPriceDetails',
  'PricingCategory', 'PricingUnit', 'PricingQuantity', 'ListUnitPrice',
  'ListCost', 'ContractedCost', 'BilledCost', 'EffectiveCost',
  'ConsumedQuantity', 'ConsumedUnit', 'Tags',
]

export interface ConvertResult {
  csv: string
  rows: number
  skippedZeroRows: number
  providerTotal: number
  focusTotal: number
  /** Rows whose unit price was confirmed (Anthropic) or derived from a known quantity. */
  exactRows: number
  /** Rows with a quantity and unit price, however the price was found. */
  quantityRows: number
  providerPricedRows: number
  unpricedModels: string[]
  /** Rows left out because a dollar or token cell wasn't a number: usually a changed export format. */
  unreadableRows: number
  /** Export columns the converter doesn't read, by file role. */
  unreadColumns: Partial<Record<'cost' | 'usage', string[]>>
  warnings: string[]
}

/** A dollar or token cell as a number: null when empty, NaN when it isn't a number. */
export function numeric(v: string | null): number | null {
  if (v === null) return null
  const t = v.replace(/[$,\s]/g, '')
  return t === '' || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? NaN : Number(t)
}

/**
 * Columns in an export that the converter neither reads nor knows to be safe
 * to ignore. A provider adding or renaming a column shows up here instead of
 * silently changing quantities or totals.
 */
export function unreadColumns(header: string[], known: readonly string[]): string[] {
  return header.filter((h) => h && !known.includes(h))
}

export function unreadWarning(file: string, cols: string[]): string | null {
  if (!cols.length) return null
  const list = cols.slice(0, 8).join(', ') + (cols.length > 8 ? `, and ${cols.length - 8} more` : '')
  return `The ${file} has column${cols.length === 1 ? '' : 's'} this converter doesn't read: ${list}. The export format may have changed; if ${cols.length === 1 ? 'it holds' : 'any holds'} tokens or dollars, quantities could be off. Please report the column names (ai-bill-to-focus report prints them).`
}

export function unreadableWarning(n: number, example: string): string | null {
  return n ? `${n} row${n === 1 ? ' was' : 's were'} left out because a dollar or token cell wasn't a number (for example ${JSON.stringify(example)}). The columns may have shifted; totals don't include ${n === 1 ? 'it' : 'them'}.` : null
}

export interface Account { id: string; name: string }

/** A parsed CSV with null-aware lookup by column name ("" and "--" are null). */
export function table(text: string) {
  const [header = [], ...body] = parseCsv(text)
  const idx = new Map(header.map((h, i) => [h.trim(), i]))
  const get = (r: string[], c: string) => {
    const v = idx.has(c) ? (r[idx.get(c)!] ?? '').trim() : ''
    return v === '' || v === '--' ? null : v
  }
  return { header: header.map((h) => h.trim()), body, get, has: (c: string) => idx.has(c) }
}

export function headerOf(text: string): string[] {
  return (parseCsv(text.slice(0, 8192))[0] ?? []).map((h) => h.trim())
}

/** Decimal text that a CSV reader types as decimal: always a point, no exponent. */
export function dec(n: number): string {
  if (!Number.isFinite(n)) return ''
  let s = String(n)
  if (/e/i.test(s)) s = n.toFixed(20).replace(/0+$/, '')
  return s.includes('.') ? (s.endsWith('.') ? s + '0' : s) : s + '.0'
}

// Float noise (0.30000000000000004) is cleaned from prices and dollar amounts:
// unit prices to 12 significant digits, dollars to 10 decimal places.
const cleanPrice = (n: number) => Number(n.toPrecision(12))
const cleanUsd = (n: number) => Number(n.toFixed(10))

const csvCell = (v: string | null) => (v === null ? '' : /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

export const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

/** ChargePeriod and its calendar-month BillingPeriod, end-exclusive. */
export function periods(start: Date, end?: Date) {
  const chargeEnd = end && end > start ? end : new Date(start.getTime() + 86_400_000)
  return {
    BillingPeriodStart: iso(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))),
    BillingPeriodEnd: iso(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))),
    ChargePeriodStart: iso(start),
    ChargePeriodEnd: iso(chargeEnd),
  }
}

export const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '')

export interface Meter {
  provider: string            // company, e.g. 'OpenAI'
  service: string             // API product, e.g. 'OpenAI API'
  description: string
  skuId: string
  meter: string
  details: Record<string, string> | null
  consumed: number | null     // ConsumedQuantity
  consumedUnit: string | null
  pricingUnit: string | null
  pricingQty: number | null
  unitPrice: number | null
  listCost: number
  billed: number
}

/** One FOCUS 1.4 row (plus the caller's x_ columns) for a meter. */
export function focusRow(m: Meter, account: Account, period: ReturnType<typeof periods>, extra: Record<string, string | null>): Record<string, string | null> {
  const priced = m.unitPrice !== null && m.pricingQty !== null
  const unitPrice = priced ? cleanPrice(m.unitPrice!) : null
  const pricingQty = priced ? Number(dec(m.pricingQty!)) : null
  // ListCost stays the exact float product of the two columns as written: the
  // validator checks ListUnitPrice x PricingQuantity = ListCost with exact equality.
  const listCost = priced ? unitPrice! * pricingQty! : cleanUsd(m.listCost)
  const billed = dec(cleanUsd(m.billed))
  return {
    BillingAccountId: account.id, BillingAccountName: account.name, BillingCurrency: 'USD',
    ...period,
    ChargeCategory: 'Usage', ChargeClass: null, ChargeDescription: m.description, ChargeFrequency: 'Usage-Based',
    InvoiceId: null, InvoiceIssuerName: m.provider, ServiceProviderName: m.provider, HostProviderName: m.provider,
    ServiceName: m.service, ServiceCategory: 'AI and Machine Learning', ServiceSubcategory: 'Generative AI',
    SkuId: m.skuId, SkuPriceId: priced ? `${m.skuId}@${dec(unitPrice!)}` : null, SkuMeter: m.meter,
    // Both describe a price, so both are null without one (SkuPriceDetails-C-004-C, PricingCategory-C-012-C).
    SkuPriceDetails: m.details && priced ? JSON.stringify(Object.fromEntries(Object.entries(m.details).sort())) : null,
    PricingCategory: priced ? 'Standard' : null,
    PricingUnit: priced ? m.pricingUnit : null, PricingQuantity: priced ? dec(pricingQty!) : null,
    ListUnitPrice: priced ? dec(unitPrice!) : null,
    ListCost: dec(listCost), ContractedCost: billed, BilledCost: billed, EffectiveCost: billed,
    ConsumedQuantity: m.consumed ? dec(m.consumed) : null, ConsumedUnit: m.consumed ? m.consumedUnit : null, Tags: null,
    ...extra,
  }
}

export function writeCsv(columns: string[], rows: Record<string, string | null>[]): string {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c] ?? null)).join(','))].join('\n') + '\n'
}

/** Look a model up in the price table: exact id, then without a date suffix. */
export function priceFor(prices: PriceTable | null, model: string): ModelPrice | null {
  if (!prices) return null
  return prices[model] ?? prices[model.replace(/-\d{4}-\d{2}-\d{2}$|-\d{8}$/, '')] ?? null
}
