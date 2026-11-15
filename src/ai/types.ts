export type ProviderName = 'openai' | 'anthropic' | 'mock'

export interface AiSettings {
  enabled: boolean; provider: ProviderName; models: { openai: string | null; anthropic: string | null }
  temperature: number | null; max_output_tokens: number; history_messages: number
  monthly_limit_usd: number | null; block_on_limit: boolean; fallback_provider: 'openai' | 'anthropic' | null; auto_fallback: boolean
}
export interface UsageSummary { month: string; requests: number; input_tokens: number; output_tokens: number; cost_usd: number | null; cost_known: boolean; limit_usd: number | null; limit_reached: boolean }
export interface AiStatus {
  enabled: boolean; provider: ProviderName; model: string | null; needs_model: boolean
  providers: Record<string, { configured: boolean; default_model?: string | null }>
  fallback_provider: string | null; auto_fallback: boolean; usage: UsageSummary
  limits: { max_history_cap: number; max_output_tokens_cap: number; rate_limit_per_min: number }
}
export interface ModelList { provider: string; models: { id: string; display_name: string | null }[]; source: 'live' | 'configured'; error: string | null }

/** Vom Backend validierte Aktionsvorschläge (Struktur/Katalog); die Engine im Frontend prüft danach fachlich. */
export type Proposal =
  | { type: 'swap_meal'; date: string; meal_id: string; recipe_id: string; reason?: string }
  | { type: 'add_meal'; date: string; slot: 'fruehstueck' | 'mittag' | 'abend' | 'snack'; recipe_id: string; portion_factor?: number; reason?: string }
  | { type: 'remove_meal'; date: string; meal_id: string; reason?: string }
  | { type: 'set_portion'; date: string; meal_id: string; portion_factor: number; reason?: string }
  | { type: 'create_recipe'; name: string; slots: string[]; ingredients: { food_name: string; grams: number }[]; steps?: string[]; reason?: string }
  | { type: 'exclude_food'; food_name: string; reason?: string }
  | { type: 'add_shopping_item'; name: string; amount?: string; reason?: string }

export interface ChatEvents {
  meta?: (m: { provider: string; model: string; fallback_used: boolean }) => void
  delta?: (text: string) => void
  actions?: (a: { proposals: Proposal[]; rejected: { type: string; reason: string }[] }) => void
  usage?: (u: { input_tokens: number; output_tokens: number; cost_usd: number | null; cost_known: boolean }) => void
  error?: (e: { code: string; message: string; retryable: boolean }) => void
}
export interface NutritionContextPayload { [k: string]: unknown }
export interface ChatRequestBody {
  messages: { role: 'user' | 'assistant'; content: string }[]
  context: NutritionContextPayload | null
  provider?: ProviderName; model?: string; temperature?: number; max_output_tokens?: number; tools_enabled?: boolean
}
