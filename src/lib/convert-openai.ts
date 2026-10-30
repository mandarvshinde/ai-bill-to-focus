// OpenAI Usage-page exports -> FOCUS 1.4 CSV, in the browser.
//
// Built from OpenAI's documentation (Costs and Usage APIs, which the
// dashboard exports flatten) and a FinOps vendor's published import columns,
// NOT yet from a real export with usage in it. So it reads columns by name
// and leaves anything it doesn't understand in the row instead of guessing.
//
// Inputs: the Cost export (Usage -> Export -> Cost data, grouped by line
// item, 1-day interval) and optionally the Completions activity export for
// token counts. BilledCost is always OpenAI's own amount_value; token counts
// only fill ConsumedQuantity and derive the unit price, so a mismatched join
// can never change a dollar figure. OpenAI counts cached input INSIDE
// input_tokens, so uncached input = input_tokens - input_cached_tokens.

import {
  FOCUS_14_COLUMNS, focusRow, headerOf, periods, priceFor, slug, table, writeCsv,
  type Account, type ConvertResult, type PriceTable,
} from './convert-common'

const TIME_ONLY = ['start_time', 'end_time', 'start_time_iso', 'end_time_iso']

export function isOpenAICost(header: string[]) { return header.includes('amount_value') && header.includes('line_item') }
export function isOpenAIUsage(header: string[]) { return header.includes('input_tokens') && header.includes('output_tokens') && header.includes('num_model_requests') }
/** The dashboard exports only the bucket columns when a range has no usage. */
export function isOpenAIEmpty(header: string[]) { return header.length === TIME_ONLY.length && TIME_ONLY.every((h) => header.includes(h)) }

export function exportKind(text: string): 'openai-cost' | 'openai-usage' | 'openai-empty' | null {
  const header = headerOf(text)
  return isOpenAICost(header) ? 'openai-cost' : isOpenAIUsage(header) ? 'openai-usage' : isOpenAIEmpty(header) ? 'openai-empty' : null
}

type Kind = 'input' | 'cached' | 'cache-write' | 'audio-input' | 'audio-output' | 'output' | 'other'

/** "gpt-4o-2024-08-06, cached input" -> model + kind. Unknown kinds stay as written. */
export function parseLineItem(lineItem: string): { model: string; kind: Kind; label: string } {
  const i = lineItem.lastIndexOf(',')
  const model = (i === -1 ? lineItem : lineItem.slice(0, i)).trim()
  const label = (i === -1 ? '' : lineItem.slice(i + 1)).trim()
  const l = label.toLowerCase()
  const kind: Kind =
    /cache[ds]?\s*writ/.test(l) ? 'cache-write'
      : /cached|cache read/.test(l) ? 'cached'
        : /audio/.test(l) && /input/.test(l) ? 'audio-input'
          : /audio/.test(l) && /output/.test(l) ? 'audio-output'
            : /\binput\b/.test(l) ? 'input'
              : /\boutput\b/.test(l) ? 'output'
                : 'other'
  return { model, kind, label }
}

const METERS: Record<Exclude<Kind, 'other'>, { meter: string; suffix: string; direction: string; cache?: string }> = {
  input:          { meter: 'Input Tokens', suffix: 'input', direction: 'Input', cache: 'Uncached' },
  cached:         { meter: 'Cache Read Input Tokens', suffix: 'cache-read', direction: 'Input', cache: 'Read' },
  'cache-write':  { meter: 'Cache Write Input Tokens', suffix: 'cache-write', direction: 'Input', cache: 'Write' },
  'audio-input':  { meter: 'Audio Input Tokens', suffix: 'audio-input', direction: 'Input' },
  'audio-output': { meter: 'Audio Output Tokens', suffix: 'audio-output', direction: 'Output' },
  output:         { meter: 'Output Tokens', suffix: 'output', direction: 'Output' },
}

const EXTRA_COLUMNS = ['x_PriceSource', 'x_LineItem', 'x_ProjectId', 'x_ProjectName']

const dayOf = (iso: string) => iso.slice(0, 10)
const baseModel = (m: string) => m.replace(/-\d{4}-\d{2}-\d{2}$/, '')

function bucketStart(t: ReturnType<typeof table>, r: string[]): Date | null {
  const isoText = t.get(r, 'start_time_iso')
  if (isoText) { const d = new Date(isoText); if (!Number.isNaN(d.getTime())) return d }
  const secs = Number(t.get(r, 'start_time'))
  return Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000) : null
}
function bucketEnd(t: ReturnType<typeof table>, r: string[]): Date | undefined {
  const isoText = t.get(r, 'end_time_iso')
  if (isoText) { const d = new Date(isoText); if (!Number.isNaN(d.getTime())) return d }
  const secs = Number(t.get(r, 'end_time'))
  return Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000) : undefined
}

export function convertOpenAI(costText: string, usageText: string | null, prices: PriceTable | null, fallback: Account): ConvertResult {
  const cost = table(costText)
  const warnings: string[] = []

  // Completions tokens by day + model (+ project when both files have it).
  const usage = new Map<string, number>()
  const usageByProject = usageText ? table(usageText).has('project_id') && cost.has('project_id') : false
  if (usageText) {
    const u = table(usageText)
    for (const r of u.body) {
      const start = bucketStart(u, r)
      const model = u.get(r, 'model')
      if (!start || !model) continue
      const key = [dayOf(start.toISOString()), baseModel(model), usageByProject ? u.get(r, 'project_id') : ''].join('|')
      const n = (c: string) => Number(u.get(r, c) ?? 0)
      const add = (kind: Kind, v: number) => usage.set(`${key}|${kind}`, (usage.get(`${key}|${kind}`) ?? 0) + v)
      // OpenAI's input_tokens already includes the cached tokens.
      add('input', Math.max(0, n('input_tokens') - n('input_cached_tokens')))
      add('cached', n('input_cached_tokens'))
      add('output', n('output_tokens'))
      add('audio-input', n('input_audio_tokens'))
      add('audio-output', n('output_audio_tokens'))
    }
    if (!u.body.length) warnings.push('The usage file has no rows, so token quantities are empty.')
  } else {
    warnings.push('No Completions usage export: rows carry OpenAI\'s dollars but no token quantities or unit prices.')
  }

  const out: Record<string, string | null>[] = []
  let skipped = 0, providerTotal = 0, withQty = 0, withoutQty = 0, dropped = 0
  const unknownKinds = new Set<string>()

  for (const r of cost.body) {
    const start = bucketStart(cost, r)
    if (!start) continue
    const amount = Number(cost.get(r, 'amount_value') ?? 0)
    const lineItem = cost.get(r, 'line_item') ?? 'Unspecified'
    providerTotal += amount
    const currency = (cost.get(r, 'amount_currency') ?? 'usd').toUpperCase()
    if (currency !== 'USD') warnings.push(`Row with currency ${currency}: kept as written; BillingCurrency is USD for this file.`)

    const { model, kind, label } = parseLineItem(lineItem)
    const projectId = cost.get(r, 'project_id')
    const key = [dayOf(start.toISOString()), baseModel(model), usageByProject ? projectId : ''].join('|')

    let qty: number | null = null
    let meter: string, skuId: string, details: Record<string, string> | null
    if (kind === 'other') {
      unknownKinds.add(label || lineItem)
      meter = label || lineItem
      skuId = `openai/${slug(model)}${label ? `/${slug(label)}` : ''}`
      details = null
    } else {
      const m = METERS[kind]
      meter = m.meter
      skuId = `openai/${model}/${m.suffix}`
      details = { x_ModelDeveloper: 'OpenAI', x_ModelId: model, x_TokenDirection: m.direction, ...(m.cache ? { x_TokenCacheAction: m.cache } : {}) }
      if (usageText && kind !== 'cache-write') qty = usage.get(`${key}|${kind}`) ?? null
    }

    if (amount === 0 && !qty) { skipped++; continue }

    let pricingQty = qty ? qty / 1_000_000 : null
    let unitPrice = pricingQty ? amount / pricingQty : null
    // A joined quantity that implies a price far from the public one is a bad
    // join (e.g. a line item the usage file splits differently): drop it.
    const pub = kind === 'other' ? null : priceFor(prices, model)
    const pubRate = pub ? (kind === 'cached' ? pub.cacheRead : kind === 'output' || kind === 'audio-output' ? pub.output : pub.input) : null
    if (unitPrice !== null && pubRate && pubRate > 0 && (unitPrice > pubRate * 3 || unitPrice < pubRate / 3)) {
      dropped++
      qty = null; pricingQty = null; unitPrice = null
    }
    if (qty) withQty++
    else withoutQty++

    out.push(focusRow(
      {
        provider: 'OpenAI', service: 'OpenAI API', description: kind === 'other' && !label ? lineItem : `${meter} - ${model}`,
        skuId, meter, details, consumed: qty, consumedUnit: 'Tokens', pricingUnit: '1000000 Tokens', pricingQty, unitPrice,
        listCost: unitPrice !== null && pricingQty !== null ? unitPrice * pricingQty : amount, billed: amount,
      },
      { id: cost.get(r, 'organization_id') ?? fallback.id, name: cost.get(r, 'organization_name') ?? fallback.name },
      periods(start, bucketEnd(cost, r)),
      { x_PriceSource: 'provider', x_LineItem: lineItem, x_ProjectId: projectId, x_ProjectName: cost.get(r, 'project_name') },
    ))
  }

  if (unknownKinds.size) warnings.push(`Line items kept as written, not split by token type: ${[...unknownKinds].slice(0, 6).join(', ')}${unknownKinds.size > 6 ? ', …' : ''}.`)
  if (dropped) warnings.push(`${dropped} row${dropped === 1 ? '' : 's'}: the usage file's token count implied a price far from OpenAI's public one, so the quantity was left out rather than trusted.`)
  if (usageText && withoutQty && withQty) warnings.push(`${withoutQty} row${withoutQty === 1 ? ' has' : 's have'} no matching token count in the usage file.`)

  return {
    csv: writeCsv([...FOCUS_14_COLUMNS, ...EXTRA_COLUMNS], out),
    rows: out.length,
    skippedZeroRows: skipped,
    providerTotal,
    focusTotal: providerTotal,
    exactRows: withQty,
    quantityRows: withQty,
    providerPricedRows: withoutQty,
    unpricedModels: [],
    warnings: [...new Set(warnings)],
  }
}
