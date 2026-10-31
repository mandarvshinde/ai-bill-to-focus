// Together AI cost-analytics CSV -> FOCUS 1.4 CSV, in the browser.
//
// Built from Together's documentation, which names the export's columns
// (Date, Line Item, Dimensions, Quantity, Unit Price (USD), Amount (USD)) but
// not what Line Item and Dimensions contain or which unit Quantity is in.
// So BilledCost is Together's own Amount, Quantity x Unit Price becomes
// ListCost, and the unit is the neutral "Units" until a real export shows
// more. Not yet tested on a real export.

import {
  FOCUS_14_COLUMNS, focusRow, headerOf, numeric, periods, slug, table, unreadableWarning, unreadColumns, unreadWarning, writeCsv,
  type Account, type ConvertResult,
} from './convert-common'

const HEADERS = ['Date', 'Line Item', 'Quantity', 'Unit Price (USD)', 'Amount (USD)']
/** Every column the converter reads. Anything else is reported. */
export const COST_COLUMNS = [...HEADERS, 'Dimensions']

export function isTogetherCost(header: string[]) { return HEADERS.every((h) => header.includes(h)) }

export function exportKind(text: string): 'together-cost' | null {
  return isTogetherCost(headerOf(text)) ? 'together-cost' : null
}

const EXTRA_COLUMNS = ['x_PriceSource', 'x_LineItem', 'x_Dimensions']

/** Dates are UTC per Together's docs; the format isn't documented, so take any parseable one. */
function utcDay(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v)
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  const t = Date.parse(`${v} UTC`)
  if (Number.isNaN(t)) return null
  const d = new Date(t)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

export function convertTogether(text: string, account: Account): ConvertResult {
  const t = table(text)
  const out: Record<string, string | null>[] = []
  let skipped = 0, total = 0, withQty = 0, withoutQty = 0, badDates = 0, unreadable = 0, unreadableExample = ''

  for (const r of t.body) {
    const dateText = t.get(r, 'Date')
    const day = dateText ? utcDay(dateText) : null
    if (!day) { if (r.some((c) => c.trim())) badDates++; continue }
    const amount = numeric(t.get(r, 'Amount (USD)')) ?? 0
    const qty = numeric(t.get(r, 'Quantity'))
    const price = numeric(t.get(r, 'Unit Price (USD)'))
    const broken = (['Amount (USD)', 'Quantity', 'Unit Price (USD)'] as const).find((c, i) => { const n = [amount, qty, price][i]; return n !== null && !Number.isFinite(n) })
    if (broken) { unreadable++; unreadableExample ||= t.get(r, broken) ?? ''; continue }
    const lineItem = t.get(r, 'Line Item') ?? 'Unspecified'
    const dims = t.get(r, 'Dimensions')
    total += amount
    if (!amount && !qty) { skipped++; continue }

    const priced = qty !== null && qty > 0 && price !== null
    if (priced) withQty++
    else withoutQty++
    const meter = dims ? `${lineItem} - ${dims}` : lineItem
    out.push(focusRow(
      {
        provider: 'Together AI', service: 'Together AI API', description: meter,
        skuId: `together/${slug(lineItem)}${dims ? `/${slug(dims)}` : ''}`, meter, details: null,
        consumed: priced ? qty : null, consumedUnit: 'Units', pricingUnit: 'Units',
        pricingQty: priced ? qty : null, unitPrice: priced ? price : null,
        listCost: priced ? price! * qty! : amount, billed: amount,
      },
      account,
      periods(day),
      { x_PriceSource: 'provider', x_LineItem: lineItem, x_Dimensions: dims },
    ))
  }

  const warnings = ['Together\'s docs don\'t say which unit Quantity is in, so it is written as "Units". If your file shows tokens or millions of tokens, tell us and we\'ll map it properly.']
  if (badDates) warnings.push(`${badDates} row${badDates === 1 ? '' : 's'} had a Date we couldn't read and were left out.`)
  const unread = { cost: unreadColumns(t.header, COST_COLUMNS) }
  for (const w of [unreadableWarning(unreadable, unreadableExample), unreadWarning('export', unread.cost)]) if (w) warnings.push(w)

  return {
    csv: writeCsv([...FOCUS_14_COLUMNS, ...EXTRA_COLUMNS], out),
    rows: out.length,
    skippedZeroRows: skipped,
    providerTotal: total,
    focusTotal: total,
    exactRows: withQty,
    quantityRows: withQty,
    providerPricedRows: withoutQty,
    unpricedModels: [],
    unreadableRows: unreadable,
    unreadColumns: unread,
    warnings,
  }
}
