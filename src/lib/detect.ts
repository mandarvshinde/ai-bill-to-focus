// Which provider export a CSV is, from its header row. Shared by the web
// converter and the CLI.

import { headerOf } from './convert-common'
import { isAnthropicCost, isAnthropicUsage } from './convert-anthropic'
import { isOpenAICost, isOpenAIEmpty, isOpenAIUsage } from './convert-openai'
import { isTogetherCost } from './convert-together'
import type { ConverterId } from './engine'

export type ExportKind = { provider: ConverterId; slot: 'cost' | 'usage' } | 'openai-empty' | null

export function detectExport(text: string): ExportKind {
  const h = headerOf(text)
  if (isAnthropicCost(h)) return { provider: 'anthropic', slot: 'cost' }
  if (isAnthropicUsage(h)) return { provider: 'anthropic', slot: 'usage' }
  if (isOpenAICost(h)) return { provider: 'openai', slot: 'cost' }
  if (isOpenAIUsage(h)) return { provider: 'openai', slot: 'usage' }
  if (isTogetherCost(h)) return { provider: 'together', slot: 'cost' }
  if (isOpenAIEmpty(h)) return 'openai-empty'
  return null
}
