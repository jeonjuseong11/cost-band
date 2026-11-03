import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Cost, Flow } from '../types'

const cost = atom({ plugin: 'cost-band', key: 'cost' } as const, null)
const flow = atom({ plugin: 'cost-band', key: 'flow' } as const, { step: 'idle' } as Flow)
const isOpen = atom({ plugin: 'cost-band', key: 'isOpen' } as const, false)

const FILE = '~/.claude/handoffs/latest.md'
const SAVE = (transcript: string) =>
  `[handoff-save] 지금 대화를 새 세션이 그대로 이어받을 수 있게 ${FILE} 에 인수인계 문서로 저장해줘. 요약이 아니라 "맥락 보존"이 목적이니 길어도 괜찮아. 다음을 빠짐없이 담아줘:
1. 사용자가 원래 원한 것과 중간에 바뀐 요구(사용자의 표현을 최대한 그대로, 짧은 인용 포함)
2. 사용자의 선호와 지적(말투, 쉬운 말 원칙, 마음에 안 들어 한 것과 마음에 들어 한 것)
3. 내린 결정과 그 이유, 버린 선택지와 버린 이유
4. 지금 상태: 만든/수정한 파일의 전체 경로, 현재 버전, 동작 확인한 것과 못 한 것
5. 아직 모르는 것, 사용자에게 물어본 뒤 답을 못 받은 질문
6. 남은 할 일(순서대로)과 바로 다음에 할 한 가지
7. 원본 대화 기록 파일: ${transcript || '(경로를 찾지 못함)'}
다 쓰면 "저장 완료"라고만 답해줘.`
const RESUME = `[handoff-resume] ${FILE} 를 끝까지 읽어줘. 문서에 적힌 원본 대화 기록 파일이 있으면 애매한 부분을 grep으로 확인해서 맥락을 최대한 되살려줘. 그다음 쉬운 한국어로 (1) 사용자가 원하는 것 (2) 어디까지 했는지 (3) 바로 다음에 할 일을 짧게 알려주고, 이전 대화에서 사용자가 정한 원칙과 말투를 그대로 이어가겠다고 확인해줘.`

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
const STYLE = `.l,.s{fill:#87867f;font:12px ${FONT}}.v{fill:#1f1e1d;font:600 16px ${FONT}}.d{stroke:#1f1e1d;stroke-opacity:.12}.t{fill:#1f1e1d;fill-opacity:.1}.success{fill:#2e7d32}.warning{fill:#a86400}.error{fill:#c62828}@media (prefers-color-scheme:dark){.v{fill:#ecebe6}.d{stroke:#fff;stroke-opacity:.14}.t{fill:#fff;fill-opacity:.12}.success{fill:#6abf69}.warning{fill:#e3a03d}.error{fill:#ef6a5a}}`

type Col = { label: string; value: string; sub: string; tone?: 'success' | 'warning' | 'error'; bar?: number }

// Real 1px dividers and exact columns; text glyphs break in the desktop's proportional font.
const metricsSvg = (cols: Col[], width = 720) => {
  const colW = width / cols.length
  let body = `<line class="d" x1="0" y1="0.5" x2="${width}" y2="0.5"/>`
  cols.forEach((c, i) => {
    const x = i * colW + (i === 0 ? 0 : 14)
    const tone = c.tone ? ` ${c.tone}` : ''
    if (i > 0) body += `<line class="d" x1="${i * colW}" y1="14" x2="${i * colW}" y2="70"/>`
    body += `<text class="l" x="${x}" y="24">${esc(c.label)}</text>`
    body += `<text class="v${tone}" x="${x}" y="44">${esc(c.value)}</text>`
    if (c.bar !== undefined) {
      const w = colW - 32
      body += `<rect class="t" x="${x}" y="51" width="${w}" height="4" rx="2"/><rect class="${c.tone ?? 'success'}" x="${x}" y="51" width="${Math.max(4, (w * Math.min(c.bar, 100)) / 100)}" height="4" rx="2"/>`
    }
    body += `<text class="s" x="${x}" y="71">${esc(c.sub)}</text>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="76" viewBox="0 0 ${width} 76"><style>${STYLE}</style>${body}</svg>`
}

export const register: Register = on => {
  let before = 0 // session cost at the end of the previous turn
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
    // A total below the baseline means the engine restarted its ledger (/clear).
    const last = !isMain ? 0 : spent >= before ? spent - before : spent
    if (isMain) before = spent
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
      const row = [new Date(await $.clock.now()).toISOString(), (await $.session.id()).slice(0, 8), e.agentId ?? '', u.model, last.toFixed(4), spent.toFixed(4), u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, c.ctx, (e.durationMs / 1000).toFixed(1)].join(',')
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
            return void update($, flow, () => ({ step: 'failed', msg: '/clear를 실행하지 못했어요. 저장은 끝났으니 직접 /clear 하세요' }))
          }
          await update($, flow, () => ({ step: 'resuming' }))
          void $.prompt.submit({ text: RESUME })
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
    const { input, cacheRead, cacheWrite } = c.tok
    const inAll = input + cacheRead + cacheWrite
    const hit = inAll > 0 ? Math.round((cacheRead / inAll) * 100) : 0
    const tone = c.ctxPct >= 80 ? 'error' : c.ctxPct >= 60 ? 'warning' : 'success'
    const total = c.ctxPct > 0 ? Math.round(c.ctx / (c.ctxPct / 100)) : 0
    const left = total > 0 ? `${fmtTokens(Math.max(total - c.ctx, 0))} 남음` : ''
    const hint = c.ctxPct >= 80 ? '곧 가득 차요. 새 대화를 추천해요' : c.ctxPct >= 60 ? '슬슬 길어지고 있어요' : '아직 여유 있어요'
    const toggle = () => update($, isOpen, v => !v)

    // Save a handoff note, /clear, then resume from it; the turn.complete hook above carries it from step to step.
    const f = await read($, flow)
    const set = (step: Flow['step']) => update($, flow, () => ({ step }))
    const go = async () => {
      await set('saving')
      const id = await $.session.id()
      const home = (await $.env.get('HOME')) ?? ''
      // The note links the raw transcript so the resumed session can grep what the note left out.
      const found = await $.process.run(['find', `${home}/.claude/projects`, '-name', `${id}.jsonl`]).catch(() => undefined)
      void $.prompt.submit({ text: SAVE(found?.stdout.split('\n')[0] ?? '') })
    }
    const handoff =
      f.step === 'confirm' ? (
        <Box gap={1} alignItems="center">
          <Text color="warning">저장하고 대화를 초기화해요. 계속할까요?</Text>
          <Button key="go" plain label="예" onPress={go} />
          <Button key="no" plain label="취소" onPress={() => set('idle')} />
        </Box>
      ) : f.step === 'saving' ? (
        <Text color="warning">1/2 인수인계 저장 중…</Text>
      ) : f.step === 'resuming' ? (
        <Text color="warning">2/2 새 대화에서 이어받는 중…</Text>
      ) : (
        <Box gap={1}>
          {f.step === 'done' && <Text color="success">✓ 이어받기 완료</Text>}
          {f.step === 'failed' && <Text color="error">{f.msg}</Text>}
          <Button key="start" plain label="정리하고 이어가기" onPress={() => set('confirm')} />
        </Box>
      )

    const draw = (cols: Col[]) =>
      e.surface === 'desktop' ? (
        (() => { const { Svg } = $.ui.resolve(e); return <Svg source={metricsSvg(cols)} alt={cols.map(k => `${k.label} ${k.value}`).join(', ')} /> })()
      ) : (
        <Box gap={2}>
          {cols.map(k => (
            <Box key={k.label} flexDirection="column" flexGrow={1}>
              <Text dimColor>{k.label}</Text>
              <Text bold color={k.tone}>{k.value}</Text>
              <Text dimColor>{k.sub}</Text>
            </Box>
          ))}
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
    const usageButtons = (
      <Box gap={1}>
        <Button key="day" plain label="일일 평가" onPress={() => review('day')} />
        <Button key="week" plain label="주간 평가" onPress={() => review('week')} />
        <Button key="month" plain label="월간 평가" onPress={() => review('month')} />
      </Box>
    )

    if (!open) {
      return (
        <Box alignItems="center" gap={2}>
          <Text bold>{`$${c.spent.toFixed(2)}`}</Text>
          <Text dimColor>{`방금 $${c.last.toFixed(2)}`}</Text>
          <Text color={tone}>{`기억 ${c.ctxPct}% 사용 · ${left}`}</Text>
          <Text dimColor>{elapsed(c.busyMs)}</Text>
          <Box flexGrow={1} />
          {usageButtons}
          {handoff}
          <Button key="toggle" plain label="자세히" onPress={toggle} />
        </Box>
      )
    }

    const cols: Col[] = [
      { label: '이번 대화 비용', value: `$${c.spent.toFixed(2)}`, sub: `방금 $${c.last.toFixed(2)} · 평균 $${per(c.spent).toFixed(2)}` },
      { label: '대화 기억 공간', value: `${c.ctxPct}% 사용`, sub: `${fmtTokens(c.ctx)} 사용 · ${left || hint}`, tone, bar: c.ctxPct },
      { label: '주고받은 횟수', value: `${c.turns}번`, sub: `1번 평균 ${elapsed(per(c.busyMs))}` },
      { label: 'AI가 일한 시간', value: elapsed(c.busyMs), sub: '' },
    ]
    return (
      <Box flexDirection="column" gap={e.surface === 'desktop' ? 1 : 0}>
        <Box alignItems="center">
          <Text color={tone}>{hint}</Text>
          <Box flexGrow={1} />
          {usageButtons}
          {handoff}
          <Button key="toggle" plain label="접기" onPress={toggle} />
        </Box>
        {draw(cols)}
      </Box>
    )
  })
}
