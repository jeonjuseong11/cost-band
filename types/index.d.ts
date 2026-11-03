export type Tok = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Flow = { step: 'idle' | 'confirm' | 'saving' | 'resuming' | 'done' | 'failed'; msg?: string }
export type Cost = {
  spent: number
  last: number
  turns: number
  busyMs: number
  tok: Tok
  ctx: number // context tokens after the last main-loop turn
  ctxPct: number
  models: Record<string, number> // turns per model
}

declare module 'claude-code' {
  interface PluginState {
    'cost-band': { cost: Cost | null; isOpen: boolean; flow: Flow }
  }
}
