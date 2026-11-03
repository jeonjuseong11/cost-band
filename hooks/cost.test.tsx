import { expect, test } from 'claude-code/testing'

// Each turn the engine reports the session's running cost; the band must show the difference, and survive a /clear.
const turn = (n: number) => ({
  answer: 'ok',
  durationMs: 1000,
  isAborted: false,
  turnId: `t${n}`,
  reason: 'answer' as const,
  usage: { model: 'claude-sonnet-5-5', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
})

const BAND = { plugin: 'cost-band', component: 'AbovePrompt', surface: 'desktop', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const

test('last is the cost since the previous turn, and a reset ledger counts from zero', async ($, on) => {
  let spent = 1
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 100, window: 1000, percent: 10 }, rateLimits: [], cost: { usd: spent } } }))
  on('session.turns', () => ({ value: 1 }))
  on('session.id', () => ({ value: 'abcdef123456' }))
  on('env.get', () => ({ value: undefined })) // no HOME: the CSV log is skipped
  on('clock.now', () => ({ value: 0 }))
  on('turn.complete', () => ({ text: 'ok' })) // the engine's own end of the chain

  const last = async () => {
    const ui = await $.ui.mount(BAND)
    const text = (await ui.find({ type: 'Text', text: /방금/ }))?.text
    await ui.unmount()
    return text
  }

  await $.turn.complete(turn(1))
  expect(await last()).toBe('방금 $1.00')

  spent = 1.25
  await $.turn.complete(turn(2))
  expect(await last()).toBe('방금 $0.25')

  spent = 0.1 // /clear: the ledger starts over, so the total itself is the turn's cost
  await $.turn.complete(turn(3))
  expect(await last()).toBe('방금 $0.10')
})

test('subscription limits show next to the cost, an exceeded one as it is, and none off a subscription', async ($, on) => {
  let rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[] = [
    { kind: 'five_hour', percentUsed: 42 },
    { kind: 'seven_day', percentUsed: 112 },
  ]
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 100, window: 1000, percent: 10 }, rateLimits, cost: { usd: 1 } } }))
  on('session.turns', () => ({ value: 1 }))
  on('session.id', () => ({ value: 'abcdef123456' }))
  on('env.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('turn.complete', () => ({ text: 'ok' }))
  await $.turn.complete(turn(1))

  const limits = async () => {
    const ui = await $.ui.mount(BAND)
    const text = (await ui.find({ type: 'Text', text: /한도|5시간|주간/ }))?.text
    await ui.unmount()
    return text
  }

  expect(await limits()).toBe('5시간 42% · 주간 112%')

  rateLimits = []
  expect(await limits()).toBeUndefined()
})
