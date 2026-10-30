// Anthropic Console exports -> FOCUS 1.4 CSV, in the browser.
//
// Inputs: the Cost export (platform.claude.com/cost, one row per day, model,
// key and token type, dollars rounded to the cent) and optionally the Usage
// export (platform.claude.com/usage, token counts). Anthropic counts uncached
// input, cache writes (5 min / 1 hour) and cache reads separately, so each is
// its own meter row and nothing is double counted.
//
// With both files, every token row is priced exactly: tokens x Anthropic's
// public price (cache writes 1.25x / 2x input), checked against the Cost
// export's rounded dollars. Rows that don't reconcile, or have no tokens,
// keep the provider's own dollars. Tested on real Console exports.

import {
  FOCUS_14_COLUMNS, focusRow, headerOf, periods, table, writeCsv,
  type Account, type ConvertResult, type ModelPrice, type PriceTable,
} from './convert-common'

export { fetchPrices } from './convert-common'
export type { ConvertResult, PriceTable } from './convert-common'

const COST_HEADERS = ['usage_date_utc', 'model', 'token_type', 'cost_usd', 'list_price_usd', 'cost_type']
const USAGE_HEADERS = ['usage_date_utc', 'model_version', 'usage_input_tokens_no_cache', 'usage_output_tokens']

export function isAnthropicCost(header: string[]) { return COST_HEADERS.every((h) => header.includes(h)) }
export function isAnthropicUsage(header: string[]) { return USAGE_HEADERS.every((h) => header.includes(h)) }

export function exportKind(text: string): 'anthropic-cost' | 'anthropic-usage' | null {
  const header = headerOf(text)
  return isAnthropicCost(header) ? 'anthropic-cost' : isAnthropicUsage(header) ? 'anthropic-usage' : null
}

// token_type -> meter. Price is base rate x multiplier (Anthropic's published cache pricing).
const TOKEN_METERS: Record<string, { meter: string; suffix: string; direction: string; cache?: string; usageCol: string; rate: keyof ModelPrice; mult: number }> = {
  input_no_cache:       { meter: 'Input Tokens', suffix: 'input', direction: 'Input', cache: 'Uncached', usageCol: 'usage_input_tokens_no_cache', rate: 'input', mult: 1 },
  input_cache_read:     { meter: 'Cache Read Input Tokens', suffix: 'cache-read', direction: 'Input', cache: 'Read', usageCol: 'usage_input_tokens_cache_read', rate: 'cacheRead', mult: 1 },
  input_cache_write_5m: { meter: 'Cache Write Input Tokens (5 min)', suffix: 'cache-write-5m', direction: 'Input', cache: 'Write', usageCol: 'usage_input_tokens_cache_write_5m', rate: 'input', mult: 1.25 },
  input_cache_write_1h: { meter: 'Cache Write Input Tokens (1 hour)', suffix: 'cache-write-1h', direction: 'Input', cache: 'Write', usageCol: 'usage_input_tokens_cache_write_1h', rate: 'input', mult: 2 },
  output:               { meter: 'Output Tokens', suffix: 'output', direction: 'Output', usageCol: 'usage_output_tokens', rate: 'output', mult: 1 },
}
const NON_TOKEN: Record<string, string> = { web_search: 'Web Search', code_execution: 'Code Execution', session_runtime: 'Session Runtime' }

const EXTRA_COLUMNS = ['x_PriceSource', 'x_Workspace', 'x_ApiKeyName', 'x_ApiKeyId', 'x_ContextWindow', 'x_InferenceGeo', 'x_Speed']

// "Claude Sonnet 4.6" -> claude-sonnet-4-6; "claude-haiku-4-5-20251001" -> claude-haiku-4-5
const idFromDisplay = (name: string) => name.trim().toLowerCase().replace(/[\s.]+/g, '-')
const baseId = (id: string) => id.trim().replace(/-\d{8}$/, '')

export function convertAnthropic(costText: string, usageText: string | null, prices: PriceTable | null, account: Account): ConvertResult {
  const cost = table(costText)
  const warnings: string[] = []

  // Usage tokens by day, model, workspace, key, context window and speed.
  const usage = new Map<string, number>()
  if (usageText) {
    const u = table(usageText)
    for (const r of u.body) {
      const model = u.get(r, 'model_version')
      const date = u.get(r, 'usage_date_utc')
      if (!model || !date) continue
      const base = [date, baseId(model), u.get(r, 'workspace'), u.get(r, 'api_key'), u.get(r, 'context_window'), u.get(r, 'speed')].join('|')
      for (const [tt, m] of Object.entries(TOKEN_METERS)) usage.set(`${base}|${tt}`, (usage.get(`${base}|${tt}`) ?? 0) + Number(u.get(r, m.usageCol) ?? 0))
      usage.set(`${base}|web_search`, (usage.get(`${base}|web_search`) ?? 0) + Number(u.get(r, 'web_search_count') ?? 0))
    }
  } else {
    warnings.push('No Usage export: rows have no token quantities or unit prices, and costs are rounded to the cent. Add the Usage export for exact, quantity-level FOCUS rows.')
  }

  // Sum identical cost rows (the export repeats some non-token lines).
  type Agg = { r: string[]; cost: number; list: number | null }
  const groups = new Map<string, Agg>()
  for (const r of cost.body) {
    if (!cost.get(r, 'usage_date_utc')) continue
    const key = ['usage_date_utc', 'model', 'workspace', 'api_key', 'api_key_id', 'context_window', 'token_type', 'cost_type', 'inference_geo', 'speed', 'usage_type'].map((c) => cost.get(r, c)).join('|')
    const g = groups.get(key) ?? { r, cost: 0, list: null }
    g.cost += Number(cost.get(r, 'cost_usd') ?? 0)
    const lp = cost.get(r, 'list_price_usd')
    if (lp !== null) g.list = (g.list ?? 0) + Number(lp)
    groups.set(key, g)
  }

  const out: Record<string, string | null>[] = []
  let skipped = 0, providerTotal = 0, focusTotal = 0, exact = 0, providerPriced = 0
  const unpriced = new Set<string>()

  for (const { r, cost: costUsd, list } of groups.values()) {
    providerTotal += costUsd
    const date = cost.get(r, 'usage_date_utc')!
    const costType = cost.get(r, 'cost_type') ?? 'token'
    const tokenType = cost.get(r, 'token_type')
    const display = cost.get(r, 'model')
    const listUsd = list ?? costUsd
    const usageKey = [date, display ? idFromDisplay(display) : '', cost.get(r, 'workspace'), cost.get(r, 'api_key'), cost.get(r, 'context_window'), cost.get(r, 'speed')].join('|')

    let meter: string, skuId: string, details: Record<string, string> | null, consumedUnit: string | null, pricingUnit: string | null
    let qty: number | null = null, rate: number | null = null
    if (costType === 'token' && tokenType && TOKEN_METERS[tokenType] && display) {
      const m = TOKEN_METERS[tokenType]
      const modelId = idFromDisplay(display)
      meter = m.meter
      skuId = `anthropic/${modelId}/${m.suffix}`
      details = { x_ModelDeveloper: 'Anthropic', x_ModelId: modelId, x_TokenDirection: m.direction, ...(m.cache ? { x_TokenCacheAction: m.cache } : {}) }
      consumedUnit = 'Tokens'
      pricingUnit = '1000000 Tokens'
      qty = usageText ? (usage.get(`${usageKey}|${tokenType}`) ?? 0) : null
      const p = prices?.[modelId]
      if (p) rate = p[m.rate] * m.mult
      else if (prices) unpriced.add(display)
    } else {
      meter = NON_TOKEN[costType] ?? costType
      skuId = `anthropic/${costType.replace(/_/g, '-')}`
      details = null
      consumedUnit = costType === 'web_search' ? 'Searches' : null
      pricingUnit = consumedUnit
      if (costType === 'web_search' && usageText) qty = usage.get(`${usageKey}|web_search`) ?? 0
    }

    if (costUsd === 0 && listUsd === 0 && !qty) { skipped++; continue }

    // Price: exact when tokens x public price rounds to the provider's dollars.
    let unitPrice: number | null = null, pricingQty: number | null = null, listCost: number, billed: number, source: string
    if (qty && pricingUnit) pricingQty = pricingUnit === '1000000 Tokens' ? qty / 1_000_000 : qty
    if (pricingQty && rate !== null && Math.abs(Math.round(rate * pricingQty * 100) / 100 - listUsd) < 0.0051) {
      unitPrice = rate
      listCost = unitPrice * pricingQty
      // Discounts show as cost below list; carry the provider's ratio.
      billed = listUsd > 0 && costUsd !== listUsd ? listCost * (costUsd / listUsd) : listCost
      source = 'public-price'
      exact++
    } else if (pricingQty) {
      unitPrice = listUsd / pricingQty
      listCost = unitPrice * pricingQty
      billed = costUsd
      source = 'provider-rounded'
      providerPriced++
    } else {
      listCost = listUsd
      billed = costUsd
      source = 'provider-rounded'
      providerPriced++
    }
    focusTotal += billed

    out.push(focusRow(
      {
        provider: 'Anthropic', service: 'Claude API', description: display ? `${meter} - ${display}` : meter,
        skuId, meter, details, consumed: qty, consumedUnit, pricingUnit, pricingQty, unitPrice, listCost, billed,
      },
      account,
      periods(new Date(`${date}T00:00:00Z`)),
      {
        x_PriceSource: source, x_Workspace: cost.get(r, 'workspace'), x_ApiKeyName: cost.get(r, 'api_key'), x_ApiKeyId: cost.get(r, 'api_key_id'),
        x_ContextWindow: cost.get(r, 'context_window'), x_InferenceGeo: cost.get(r, 'inference_geo'), x_Speed: cost.get(r, 'speed'),
      },
    ))
  }

  if (unpriced.size) warnings.push(`No public price for ${[...unpriced].join(', ')}: those rows keep Anthropic's rounded dollars.`)
  if (usageText && providerPriced > 0 && exact > 0) warnings.push(`${providerPriced} row${providerPriced === 1 ? '' : 's'} kept Anthropic's rounded dollars (no matching usage, no public price, or a non-token charge).`)

  return {
    csv: writeCsv([...FOCUS_14_COLUMNS, ...EXTRA_COLUMNS], out),
    rows: out.length,
    skippedZeroRows: skipped,
    providerTotal,
    focusTotal,
    exactRows: exact,
    providerPricedRows: providerPriced,
    unpricedModels: [...unpriced],
    warnings,
  }
}
