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
// Reasoning tokens are billed as output and sit inside output_tokens the same
// way, so they are never added on top.
//
// Batch and the flex/priority service tiers price the same model and meter
// differently. When the cost file splits a tier into its own line item, the
// usage file's tokens are split the same way (batch / service_tier columns),
// so each price gets only its own tokens.

import {
  FOCUS_14_COLUMNS, focusRow, headerOf, numeric, periods, priceFor, slug, table, unreadableWarning, unreadColumns, unreadWarning, writeCsv,
  type Account, type ConvertResult, type PriceTable,
} from './convert-common'

const TIME_ONLY = ['start_time', 'end_time', 'start_time_iso', 'end_time_iso']

/** Every column the converter reads or knows is safe to ignore. Anything else is reported. */
export const COST_COLUMNS = [...TIME_ONLY, 'amount_value', 'amount_currency', 'line_item', 'project_id', 'project_name', 'organization_id', 'organization_name']
export const USAGE_COLUMNS = [
  ...TIME_ONLY, 'input_tokens', 'output_tokens', 'input_cached_tokens', 'input_audio_tokens', 'output_audio_tokens',
  'num_model_requests', 'project_id', 'user_id', 'api_key_id', 'model', 'batch', 'service_tier',
  // A breakdown of output_tokens, never added to it.
  'output_reasoning_tokens',
]

export function isOpenAICost(header: string[]) { return header.includes('amount_value') && header.includes('line_item') }
export function isOpenAIUsage(header: string[]) { return header.includes('input_tokens') && header.includes('output_tokens') && header.includes('num_model_requests') }
/** The dashboard exports only the bucket columns when a range has no usage. */
export function isOpenAIEmpty(header: string[]) { return header.length === TIME_ONLY.length && TIME_ONLY.every((h) => header.includes(h)) }

export function exportKind(text: string): 'openai-cost' | 'openai-usage' | 'openai-empty' | null {
  const header = headerOf(text)
  return isOpenAICost(header) ? 'openai-cost' : isOpenAIUsage(header) ? 'openai-usage' : isOpenAIEmpty(header) ? 'openai-empty' : null
}

type Kind = 'input' | 'cached' | 'cache-write' | 'audio-input' | 'audio-output' | 'output' | 'other'
export type Tier = 'standard' | 'batch' | 'flex' | 'priority'

// "(batch)", "batch", "flex tier", "[priority]" anywhere in a line item.
const TIER_WORD = /\s*[([]?\b(batch|flex|priority)\b(\s+(api|tier|processing))?[)\]]?/i
const TIERS: Record<Exclude<Tier, 'standard'>, { label: string; mult: number }> = {
  batch: { label: 'Batch', mult: 0.5 },
  flex: { label: 'Flex', mult: 0.5 },
  priority: { label: 'Priority', mult: 2 },
}

/** A usage row's price tier: the batch flag first, then service_tier. */
export function usageTier(batch: string | null, serviceTier: string | null): Tier {
  if (batch && /^(true|1|yes)$/i.test(batch)) return 'batch'
  const t = serviceTier?.toLowerCase()
  return t === 'flex' || t === 'priority' ? t : 'standard'
}

/** "gpt-4o-2024-08-06, cached input (batch)" -> model + kind + tier. Unknown kinds stay as written. */
export function parseLineItem(lineItem: string): { model: string; kind: Kind; label: string; tier: Tier } {
  const tierMatch = TIER_WORD.exec(lineItem)
  const tier = (tierMatch?.[1].toLowerCase() ?? 'standard') as Tier
  const plain = tierMatch ? lineItem.replace(TIER_WORD, '') : lineItem
  const i = plain.lastIndexOf(',')
  const model = (i === -1 ? plain : plain.slice(0, i)).trim()
  const label = (i === -1 ? '' : plain.slice(i + 1)).trim()
  const l = label.toLowerCase()
  const kind: Kind =
    /cache[ds]?\s*writ/.test(l) ? 'cache-write'
      : /cached|cache read/.test(l) ? 'cached'
        : /audio/.test(l) && /input/.test(l) ? 'audio-input'
          : /audio/.test(l) && /output/.test(l) ? 'audio-output'
            : /\binput\b/.test(l) ? 'input'
              : /\boutput\b/.test(l) ? 'output'
                : 'other'
  return { model, kind, label, tier }
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
  let unreadable = 0, unreadableExample = ''
  const bad = (v: string | null) => { unreadable++; unreadableExample ||= v ?? '' }

  // Completions tokens by day + model (+ project when both files have it),
  // per price tier and summed over tiers ("*").
  const usage = new Map<string, number>()
  const usageTiers = new Map<string, Set<Tier>>()
  const u = usageText ? table(usageText) : null
  const usageByProject = u ? u.has('project_id') && cost.has('project_id') : false
  if (u) {
    for (const r of u.body) {
      const start = bucketStart(u, r)
      const model = u.get(r, 'model')
      if (!start || !model) continue
      const counts: Record<string, number> = {}
      let ok = true
      for (const c of ['input_tokens', 'input_cached_tokens', 'output_tokens', 'input_audio_tokens', 'output_audio_tokens']) {
        const v = numeric(u.get(r, c))
        if (v !== null && !Number.isFinite(v)) { bad(u.get(r, c)); ok = false; break }
        counts[c] = v ?? 0
      }
      if (!ok) continue
      const key = [dayOf(start.toISOString()), baseModel(model), usageByProject ? u.get(r, 'project_id') : ''].join('|')
      const tier = usageTier(u.get(r, 'batch'), u.get(r, 'service_tier'))
      if (!usageTiers.has(key)) usageTiers.set(key, new Set())
      usageTiers.get(key)!.add(tier)
      const add = (kind: Kind, v: number) => {
        for (const t of [tier, '*']) usage.set(`${key}|${t}|${kind}`, (usage.get(`${key}|${t}|${kind}`) ?? 0) + v)
      }
      // OpenAI's input_tokens already includes the cached tokens.
      add('input', Math.max(0, counts.input_tokens - counts.input_cached_tokens))
      add('cached', counts.input_cached_tokens)
      add('output', counts.output_tokens)
      add('audio-input', counts.input_audio_tokens)
      add('audio-output', counts.output_audio_tokens)
    }
    if (!u.body.length) warnings.push('The usage file has no rows, so token quantities are empty.')
  } else {
    warnings.push('No Completions usage export: rows carry OpenAI\'s dollars but no token quantities or unit prices.')
  }

  // Day+model keys whose cost line items split out a tier: there, each line
  // item gets only its own tier's tokens. Elsewhere it gets all of them.
  const keyOf = (r: string[], model: string) => {
    const start = bucketStart(cost, r)
    return start ? [dayOf(start.toISOString()), baseModel(model), usageByProject ? cost.get(r, 'project_id') : ''].join('|') : null
  }
  const tieredCost = new Set<string>()
  for (const r of cost.body) {
    const li = parseLineItem(cost.get(r, 'line_item') ?? '')
    const key = li.tier !== 'standard' ? keyOf(r, li.model) : null
    if (key) tieredCost.add(key)
  }

  const out: Record<string, string | null>[] = []
  let skipped = 0, providerTotal = 0, withQty = 0, withoutQty = 0, dropped = 0
  const unknownKinds = new Set<string>()
  const blended = new Set<string>()

  for (const r of cost.body) {
    const start = bucketStart(cost, r)
    if (!start) continue
    const amount = numeric(cost.get(r, 'amount_value')) ?? 0
    if (!Number.isFinite(amount)) { bad(cost.get(r, 'amount_value')); continue }
    const lineItem = cost.get(r, 'line_item') ?? 'Unspecified'
    providerTotal += amount
    const currency = (cost.get(r, 'amount_currency') ?? 'usd').toUpperCase()
    if (currency !== 'USD') warnings.push(`Row with currency ${currency}: kept as written; BillingCurrency is USD for this file.`)

    const { model, kind, label, tier } = parseLineItem(lineItem)
    const projectId = cost.get(r, 'project_id')
    const key = keyOf(r, model)!
    const tierInfo = tier === 'standard' ? null : TIERS[tier]

    let qty: number | null = null
    let meter: string, skuId: string, details: Record<string, string> | null
    if (kind === 'other') {
      unknownKinds.add(label || lineItem)
      meter = label || lineItem
      skuId = `openai/${slug(model)}${label ? `/${slug(label)}` : ''}${tierInfo ? `/${tier}` : ''}`
      details = null
    } else {
      const m = METERS[kind]
      meter = tierInfo ? `${m.meter} (${tierInfo.label})` : m.meter
      skuId = `openai/${model}/${m.suffix}${tierInfo ? `-${tier}` : ''}`
      details = {
        x_ModelDeveloper: 'OpenAI', x_ModelId: model, x_TokenDirection: m.direction,
        ...(m.cache ? { x_TokenCacheAction: m.cache } : {}), ...(tierInfo ? { x_ServiceTier: tierInfo.label } : {}),
      }
      if (u && kind !== 'cache-write') {
        const split = tieredCost.has(key)
        qty = usage.get(`${key}|${split ? tier : '*'}|${kind}`) ?? null
        if (!split && qty && (usageTiers.get(key)?.size ?? 0) > 1) blended.add(model)
      }
    }

    if (amount === 0 && !qty) { skipped++; continue }

    let pricingQty = qty ? qty / 1_000_000 : null
    let unitPrice = pricingQty ? amount / pricingQty : null
    // A joined quantity that implies a price far from the public one is a bad
    // join (e.g. a line item the usage file splits differently): drop it.
    const pub = kind === 'other' ? null : priceFor(prices, model)
    const base = pub ? (kind === 'cached' ? pub.cacheRead : kind === 'output' || kind === 'audio-output' ? pub.output : pub.input) : null
    const pubRate = base !== null ? base * (tierInfo?.mult ?? 1) : null
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

  const unread = { cost: unreadColumns(cost.header, COST_COLUMNS), ...(u ? { usage: unreadColumns(u.header, USAGE_COLUMNS) } : {}) }
  if (unknownKinds.size) warnings.push(`Line items kept as written, not split by token type: ${[...unknownKinds].slice(0, 6).join(', ')}${unknownKinds.size > 6 ? ', …' : ''}.`)
  if (blended.size) warnings.push(`The usage file mixes Batch or service-tier tokens with standard ones for ${[...blended].slice(0, 4).join(', ')}, but the cost file doesn't split them, so those unit prices blend the two rates. Dollars are unaffected.`)
  if (dropped) warnings.push(`${dropped} row${dropped === 1 ? '' : 's'}: the usage file's token count implied a price far from OpenAI's public one, so the quantity was left out rather than trusted.`)
  if (u && withoutQty && withQty) warnings.push(`${withoutQty} row${withoutQty === 1 ? ' has' : 's have'} no matching token count in the usage file.`)
  for (const w of [unreadableWarning(unreadable, unreadableExample), unreadWarning('cost export', unread.cost), unreadWarning('usage export', unread.usage ?? [])]) if (w) warnings.push(w)

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
    unreadableRows: unreadable,
    unreadColumns: unread,
    warnings: [...new Set(warnings)],
  }
}
