import { atom, read, update } from 'claude-code'
import type { Register, RenderChildren } from 'claude-code'

import type { Cost, Flow } from '../types'

const cost = atom({ plugin: 'cost-band', key: 'cost' } as const, null)
const flow = atom({ plugin: 'cost-band', key: 'flow' } as const, { step: 'idle' } as Flow)
const evalMenu = atom({ plugin: 'cost-band', key: 'evalMenu' } as const, false)
const isOpen = atom({ plugin: 'cost-band', key: 'isOpen' } as const, false)

const DIR = '~/.claude/handoffs' // one file per handoff, so a second one never overwrites the first
const SAVE = (transcript: string, file: string) =>
  `[handoff-save] 지금 대화를 새 세션이 그대로 이어받을 수 있게 ${file} 에 인수인계 문서로 저장해줘(폴더가 없으면 만들어줘). 요약이 아니라 "맥락 보존"이 목적이니 길어도 괜찮아. 다음을 빠짐없이 담아줘:
1. 사용자가 원래 원한 것과 중간에 바뀐 요구(사용자의 표현을 최대한 그대로, 짧은 인용 포함)
2. 사용자의 선호와 지적(말투, 쉬운 말 원칙, 마음에 안 들어 한 것과 마음에 들어 한 것)
3. 내린 결정과 그 이유, 버린 선택지와 버린 이유
4. 지금 상태: 만든/수정한 파일의 전체 경로, 현재 버전, 동작 확인한 것과 못 한 것
5. 아직 모르는 것, 사용자에게 물어본 뒤 답을 못 받은 질문
6. 남은 할 일(순서대로)과 바로 다음에 할 한 가지
7. 원본 대화 기록 파일: ${transcript || '(경로를 찾지 못함)'}
다 쓰면 "저장 완료"라고만 답해줘.`
const RESUME = (file: string) => `[handoff-resume] ${file} 를 끝까지 읽어줘. 문서에 적힌 원본 대화 기록 파일이 있으면 애매한 부분을 grep으로 확인해서 맥락을 최대한 되살려줘. 그다음 쉬운 한국어로 (1) 사용자가 원하는 것 (2) 어디까지 했는지 (3) 바로 다음에 할 일을 짧게 알려주고, 이전 대화에서 사용자가 정한 원칙과 말투를 그대로 이어가겠다고 확인해줘.`

const EMPTY: Cost = { spent: 0, last: 0, turns: 0, busyMs: 0, tok: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ctx: 0, ctxPct: 0, models: {} }
const CSV_HEADER = 'time,session,agent,model,turn_cost_usd,total_cost_usd,input,output,cache_read,cache_write,context,duration_s'

const fmtTokens = (n: number) => (n < 1000 ? `${n}` : n < 1e6 ? `${+(n / 1e3).toFixed(1)}k` : `${+(n / 1e6).toFixed(1)}M`)
const elapsed = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
// shortcut: the image follows the system theme, not the app's; pass the theme in if they differ.
const STYLE = `.l,.s{fill:#87867f;font:12px ${FONT}}.v{fill:#1f1e1d;font:600 16px ${FONT}}.d{stroke:#1f1e1d;stroke-opacity:.12}.t{fill:#1f1e1d;fill-opacity:.1}.big{fill:#1f1e1d;font:700 22px ${FONT}}.p{fill:#1f1e1d;font:600 12px ${FONT}}.ok{fill:#9b9a92}.m{stroke:#1f1e1d;stroke-opacity:.6;stroke-width:1.5}.success{fill:#2e7d32}.warning{fill:#a86400}.error{fill:#c62828}@media (prefers-color-scheme:dark){.m{stroke:#fff;stroke-opacity:.7}.p{fill:#ecebe6}.big{fill:#ecebe6}.v{fill:#ecebe6}.d{stroke:#fff;stroke-opacity:.14}.t{fill:#fff;fill-opacity:.12}.success{fill:#6abf69}.warning{fill:#e3a03d}.error{fill:#ef6a5a}}`

type Gauge = { label: string; pct: number; tone: 'ok' | 'warning' | 'error'; sub: string; mark?: number }
type Col = { label: string; value: string; sub: string; tone?: 'ok' | 'warning' | 'error'; bar?: number }

// Real 1px dividers and exact columns; text glyphs break in the desktop's proportional font.
const fit = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

// The limit lines sit under the tiles on the same grid. A value past 100 fills the bar in red and says so, never clamping the number.
const metricsSvg = (cols: Col[], width = 720, gauges: Gauge[] = []) => {
  // Spacing: INSET beside the whole drawing, PAD above and below each block, COL beside each divider.
  const INSET = 12
  const PAD = 10
  const COL = 14
  const w = width - 2 * INSET
  const label = PAD + 10 // text baselines inside a tile, 20 apart
  const value = label + 20
  const bar = value + 8
  const sub = bar + 20
  const TILES = sub + 3 + PAD // height of the tile block
  const colW = w / cols.length
  let body = `<line class="d" x1="0" y1="0.5" x2="${w}" y2="0.5"/>`
  cols.forEach((c, i) => {
    const x = i * colW + (i === 0 ? 0 : COL)
    const tone = c.tone && c.tone !== 'ok' ? ` ${c.tone}` : ''
    if (i > 0) body += `<line class="d" x1="${i * colW}" y1="${PAD - 4}" x2="${i * colW}" y2="${sub + 8}"/>`
    body += `<text class="l" x="${x}" y="${label}">${esc(c.label)}</text>`
    body += `<text class="v${tone}" x="${x}" y="${value}">${esc(c.value)}</text>`
    if (c.bar !== undefined) {
      const bw = colW - 2 * COL
      body += `<rect class="t" x="${x}" y="${bar}" width="${bw}" height="4" rx="2"/><rect class="${c.tone ?? 'ok'}" x="${x}" y="${bar}" width="${Math.max(4, (bw * Math.min(c.bar, 100)) / 100)}" height="4" rx="2"/>`
    }
    body += `<text class="s" x="${x}" y="${sub}">${esc(c.sub)}</text>`
  })
  if (gauges.length > 0) body += `<line class="d" x1="0" y1="${TILES + 0.5}" x2="${w}" y2="${TILES + 0.5}"/>`
  // Two limits share a line, one in each half; the second half starts where the third tile's text does.
  gauges.forEach((g, i) => {
    const ox = (i % 2) * (w / 2) + (i % 2 ? COL : 0)
    const y = TILES + PAD + 12 + Math.floor(i / 2) * 28 // text baseline
    const bx = ox + 118
    const gw = 90
    body += `<text class="l" x="${ox}" y="${y}">${esc(g.label)}</text><text class="p${g.tone === 'ok' ? '' : ` ${g.tone}`}" x="${ox + 108}" y="${y}" text-anchor="end">${g.pct}%</text>`
    // Same 4px bar as the memory tile.
    body += `<rect class="t" x="${bx}" y="${y - 5}" width="${gw}" height="4" rx="2"/><rect class="${g.tone}" x="${bx}" y="${y - 5}" width="${Math.max(4, (gw * Math.min(g.pct, 100)) / 100)}" height="4" rx="2"/>`
    if (g.mark !== undefined) body += `<line class="m" x1="${bx + (gw * g.mark) / 100}" y1="${y - 8}" x2="${bx + (gw * g.mark) / 100}" y2="${y + 1}"/>`
    body += `<text class="s" x="${bx + gw + 10}" y="${y}">${esc(fit(g.sub, 13))}</text>`
  })
  // Below the limit lines only 4: the band's own padding follows the image, so a full PAD reads as more than the PAD above.
  const h = gauges.length > 0 ? TILES + PAD + 12 + (Math.ceil(gauges.length / 2) - 1) * 28 + 3 + 4 : TILES
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}"><style>${STYLE}</style><g transform="translate(${INSET},0)">${body}</g></svg>`
}

export const register: Register = on => {
  let started = false // a handoff prompt of ours has been submitted, so the next main turn.complete is its answer

  // Marks our own prompts; a turn that was already running when the button was pressed must not advance the flow.
  on('prompt.submit', ($, e, next) => {
    if (e.text.startsWith('[handoff-')) started = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    const isMain = e.agentId === undefined
    const usage = isMain ? await $.session.usage() : undefined
    const spent = usage?.cost?.usd ?? 0
    // The baseline is the cost the band stored after the previous turn, not a variable: a hot reload empties variables,
    // and the first turn after one would then count the whole session's cost as its own.
    // A total below the baseline means the engine restarted its ledger (/clear).
    const before = (await read($, cost))?.spent ?? 0
    const last = !isMain ? 0 : spent >= before ? spent - before : spent
    const turns = isMain ? await $.session.turns() : 0

    const c = await update($, cost, (c): Cost => {
      const p = c ?? EMPTY
      const tok = {
        input: p.tok.input + (u?.input_tokens ?? 0),
        output: p.tok.output + (u?.output_tokens ?? 0),
        cacheRead: p.tok.cacheRead + (u?.cache_read_input_tokens ?? 0),
        cacheWrite: p.tok.cacheWrite + (u?.cache_creation_input_tokens ?? 0),
      }
      const models = u?.model ? { ...p.models, [u.model]: (p.models[u.model] ?? 0) + 1 } : p.models
      // A subagent's tokens count; its cost is already inside the session cost the main turn reads.
      return !isMain
        ? { ...p, tok, models }
        : { spent, last, turns, busyMs: p.busyMs + e.durationMs, tok, models, ctx: usage?.context.tokens ?? p.ctx, ctxPct: usage?.context.percent ?? p.ctxPct }
    })

    // One row per turn, so the file can be analysed later.
    // shortcut: rewrites the whole file each turn (no append API); fine for thousands of rows, switch if it grows.
    const home = await $.env.get('HOME')
    if (home && u) {
      const file = `${home}/.claude/cost-band-turns.csv`
      const old = await $.fs.exists(file).then(ok => (ok ? $.fs.read(file) : ''), () => '')
      const text = typeof old === 'string' ? old : ''
      const row = [new Date(await $.clock.now()).toISOString(), (await $.session.id()).slice(0, 8), e.agentId ?? '', u.model, last.toFixed(4), spent.toFixed(4), u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, c?.ctx ?? 0, (e.durationMs / 1000).toFixed(1)].join(',')
      await $.fs.write(file, (text === '' ? CSV_HEADER + '\n' : text) + row + '\n').catch(() => undefined)
    }

    if (isMain && started) {
      const f = await read($, flow)
      started = false
      // command.run rejects inside a hook the turn waits on, so the next step starts after it.
      $.clock.after(0, async () => {
        if (f.step === 'saving') {
          try {
            await $.command.run({ command: 'clear' })
          } catch (err) {
            return void update($, flow, (): Flow => ({ step: 'failed', msg: '/clear를 실행하지 못했어요. 저장은 끝났으니 직접 /clear 하세요' }))
          }
          await update($, flow, (): Flow => ({ step: 'resuming', file: f.file }))
          void $.prompt.submit({ text: RESUME(f.file ?? `${DIR}/latest.md`) })
        } else if (f.step === 'resuming') {
          await update($, flow, () => ({ step: 'done' }))
          $.ui.toast('이어받기 완료: 위 요약을 확인하세요')
        }
      })
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const c = await read($, cost)
    if (e.props.hasSurvey || c === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const open = await read($, isOpen)
    const per = (n: number) => (c.turns > 0 ? n / c.turns : 0)
    const { input, output, cacheRead, cacheWrite } = c.tok
    const readTok = input + cacheRead + cacheWrite // everything the AI read this session, reused or new
    const tone = c.ctxPct >= 80 ? 'error' : c.ctxPct >= 60 ? 'warning' : 'ok'
    const total = c.ctxPct > 0 ? Math.round(c.ctx / (c.ctxPct / 100)) : 0
    const left = total > 0 ? `${fmtTokens(Math.max(total - c.ctx, 0))} 남음` : ''
    const hint = c.ctxPct >= 80 ? '곧 가득 차요. 새 대화를 추천해요' : c.ctxPct >= 60 ? '슬슬 길어지고 있어요' : '아직 여유 있어요'
    const toggle = () => update($, isOpen, v => !v)

    // Subscription windows (5-hour, weekly) as the status line has them; empty off a subscription, so the memory hint stays.
    const rl = await $.session.usage().then(x => x.rateLimits, () => [])
    const now = await $.clock.now()
    const until = (iso?: string) => {
      const m = iso ? Math.max(0, Math.round((Date.parse(iso) - now) / 6e4)) : -1
      return m < 0 ? '' : m < 60 ? `${m}분` : m < 1440 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${Math.floor(m / 1440)}일 ${Math.floor((m % 1440) / 60)}시간`
    }
    const NAME: Record<string, string> = { five_hour: '5시간', seven_day: '주간', spend_limit: '지출' }
    const WINDOW: Record<string, number> = { five_hour: 5 * 36e5, seven_day: 7 * 864e5 }
    const col = (t?: 'ok' | 'warning' | 'error') => (t === 'ok' ? undefined : t)
    const limits = rl.map(r => {
      const win = WINDOW[r.kind]
      const elapsed = r.resetsAt && win ? Math.min(1, Math.max(0, 1 - (Date.parse(r.resetsAt) - now) / win)) : undefined
      const projected = elapsed !== undefined && elapsed >= 0.1 ? r.percentUsed / elapsed : 0 // percent at the reset if the pace holds
      const tone: Gauge['tone'] = r.percentUsed >= 100 ? 'error' : r.percentUsed >= 80 || projected >= 100 ? 'warning' : 'ok'
      return { r, tone, mark: elapsed === undefined ? undefined : elapsed * 100 }
    })
    const limitTone: Gauge['tone'] = limits.some(l => l.tone === 'error') ? 'error' : limits.some(l => l.tone === 'warning') ? 'warning' : 'ok'
    // A chip never shrinks, so a narrow row wraps between chips instead of inside one.
    const chip = (key: string, node: RenderChildren) => <Box key={key} flexShrink={0}>{node}</Box>

    // Save a handoff note, /clear, then resume from it; the turn.complete hook above carries it from step to step.
    const f = await read($, flow)
    const set = (step: Flow['step']) => update($, flow, () => ({ step }))
    const go = async () => {
      const id = await $.session.id()
      const d = new Date(await $.clock.now())
      const two = (n: number) => String(n).padStart(2, '0')
      const file = `${DIR}/${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}-${id.slice(0, 8)}.md`
      await update($, flow, (): Flow => ({ step: 'saving', file }))
      const home = (await $.env.get('HOME')) ?? ''
      // The note links the raw transcript so the resumed session can grep what the note left out.
      const found = await $.process.run(['find', `${home}/.claude/projects`, '-name', `${id}.jsonl`]).catch(() => undefined)
      void $.prompt.submit({ text: SAVE(found?.stdout.split('\n')[0] ?? '', file) })
    }
    const handoff =
      f.step === 'confirm' ? (
        <Box gap={1} alignItems="center">
          <Text color="warning">저장하고 대화를 초기화해요. 계속할까요?</Text>
          <Button key="go" variant="primary" label="예" onPress={go} />
          <Button key="no" plain dimColor label="취소" onPress={() => set('idle')} />
        </Box>
      ) : f.step === 'saving' ? (
        <Text color="warning">1/2 인수인계 저장 중…</Text>
      ) : f.step === 'resuming' ? (
        <Text color="warning">2/2 새 대화에서 이어받는 중…</Text>
      ) : (
        <Box gap={1}>
          {f.step === 'done' && <Text color="success">✓ 이어받기 완료</Text>}
          {f.step === 'failed' && <Text color="error">{f.msg}</Text>}
          <Button key="start" onPress={() => set('confirm')}>
            <Text color="warning">정리하고 이어가기</Text>
          </Button>
        </Box>
      )

    const draw = (cols: Col[], gauges: Gauge[] = []) =>
      e.surface === 'desktop' ? (
        (() => { const { Svg } = $.ui.resolve(e); return <Svg source={metricsSvg(cols, 720, gauges)} alt={[...cols.map(k => `${k.label} ${k.value}`), ...gauges.map(g => `${g.label} ${g.pct}%`)].join(', ')} /> })()
      ) : (
        <Box flexDirection="column">
          <Box gap={2}>
            {cols.map(k => (
              <Box key={k.label} flexDirection="column" flexGrow={1}>
                <Text dimColor>{k.label}</Text>
                <Text bold color={col(k.tone)}>{k.value}</Text>
                <Text dimColor>{k.sub}</Text>
              </Box>
            ))}
          </Box>
          {gauges.map(g => <Text key={g.label} color={col(g.tone)}>{`${g.label} ${'▰'.repeat(Math.round(Math.min(g.pct, 100) / 10))}${'▱'.repeat(10 - Math.round(Math.min(g.pct, 100) / 10))} ${g.pct}% · ${g.sub}`}</Text>)}
        </Box>
      )

    // The usage-review skill reads every transcript on this machine and writes the evaluation into the chat.
    // Not awaited: command.run resolves when the whole skill turn ends, far past a press hook's 10s budget.
    const review = (period: 'day' | 'week' | 'month') => {
      // Installed as a plugin the skill is namespaced; a copy in ~/.claude/skills is not.
      $.command.run({ command: 'cost-band:usage-review', args: period })
        .catch(() => $.command.run({ command: 'usage-review', args: period }))
        .catch(() => $.ui.toast('usage-review 스킬을 실행하지 못했어요'))
    }
    // One "평가" button; pressing it opens the day / week / month choice, and choosing one runs the review.
    const menuOpen = await read($, evalMenu)
    const pickReview = (period: 'day' | 'week' | 'month') => {
      void update($, evalMenu, () => false)
      review(period)
    }
    const usageButtons = menuOpen ? (
      <Box gap={1} alignItems="center">
        <Text dimColor>평가:</Text>
        <Button key="day" label="일일" onPress={() => pickReview('day')} />
        <Button key="week" label="주간" onPress={() => pickReview('week')} />
        <Button key="month" label="월간" onPress={() => pickReview('month')} />
        <Button key="cancel" plain dimColor label="취소" onPress={() => update($, evalMenu, () => false)} />
      </Box>
    ) : (
      <Button key="eval" variant="primary" label="평가" onPress={() => update($, evalMenu, () => true)} />
    )

    if (!open) {
      return (
        <Box flexWrap="wrap" alignItems="center" columnGap={2}>
          {chip('cost', <Text bold>{`$${c.spent.toFixed(2)}`}</Text>)}
          {chip('last', <Text dimColor>{`방금 $${c.last.toFixed(2)}`}</Text>)}
          {chip('mem', <Text color={col(tone)}>{`기억 ${c.ctxPct}% 사용 · ${left}`}</Text>)}
          {chip('time', <Text dimColor>{elapsed(c.busyMs)}</Text>)}
          {rl.length > 0 && chip('limit', <Text color={col(limitTone)}>{rl.map(r => `${NAME[r.kind] ?? r.kind} ${r.percentUsed}%`).join(' · ')}</Text>)}
          <Box flexGrow={1} />
          {/* Only a handoff in progress shows here; the buttons live in the opened view. */}
          {f.step !== 'idle' && chip('handoff', handoff)}
          {chip('toggle', <Button key="toggle" plain label="자세히" onPress={toggle} />)}
        </Box>
      )
    }

    const gauges: Gauge[] = limits.map(({ r, tone, mark }) => ({
      label: `${NAME[r.kind] ?? r.kind} 한도`,
      pct: r.percentUsed,
      tone,
      mark,
      sub: `${r.percentUsed >= 100 ? '초과 · ' : ''}${r.resetsAt ? `${until(r.resetsAt)} 후 초기화` : r.percentUsed >= 100 ? '한도를 넘었어요' : ''}`,
    }))
    const cols: Col[] = [
      { label: '이번 대화 비용', value: `$${c.spent.toFixed(2)}`, sub: `방금 $${c.last.toFixed(2)} · 평균 $${per(c.spent).toFixed(2)}` },
      { label: '대화 기억 공간', value: `${c.ctxPct}% 사용`, sub: `${fmtTokens(c.ctx)} 사용 · ${left || hint}`, tone, bar: c.ctxPct },
      { label: '대화 진행', value: `${c.turns}번 · ${elapsed(c.busyMs)}`, sub: `1번 평균 ${elapsed(per(c.busyMs))}` },
      { label: '토큰 사용량', value: fmtTokens(readTok + output), sub: `읽음 ${fmtTokens(readTok)} · 씀 ${fmtTokens(output)}` },
    ]
    // Buttons on one line at the right edge; the tiles and limit lines below share one grid.
    return (
      <Box flexDirection="column" gap={e.surface === 'desktop' ? 1 : 0}>
        <Box alignItems="center" justifyContent="flex-end" columnGap={2}>
          {chip('usage', usageButtons)}
          {chip('handoff', handoff)}
          {chip('toggle', <Button key="toggle" plain dimColor label="접기" onPress={toggle} />)}
        </Box>
        {draw(cols, gauges)}
      </Box>
    )
  })
}
