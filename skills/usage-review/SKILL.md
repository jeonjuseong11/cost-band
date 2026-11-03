---
name: usage-review
description: Evaluate how well the person uses AI on this computer, for the day, week or month, in plain Korean. Use when they ask for a usage review, AI 사용 평가, 일일/주간/월간 평가, or press the cost-band review buttons. Argument day, week or month (default all three).
---

# Usage review

The question is "am I using AI well?", not "how much did I spend". Cost is one clue.

1. Run `python3 <base directory of this skill>/usage.py` (the base directory is stated when this skill loads). It reads every session transcript on this machine and prints JSON: for day, week (7 days) and month (30 days), `now` and the `before` period, each with totals and `habits`, plus the last 14 days.
2. Write the review for `$ARGUMENTS` (none: day, week and month, each short). Plain Korean, no jargon: "AI가 읽은 양", not "input tokens".

For each period:
- **총평**: one grade-like line (잘 쓰고 있어요 / 보통 / 손볼 곳이 있어요) with the single biggest reason.
- **잘한 점**: 1-2, from the data.
- **고치면 좋은 점**: 1-3, most important first, each with the number behind it and one concrete action. Judge from `habits`:
  - 대화 길이: a session with `max_context_tokens` above ~300k or hundreds of `prompts` should have been split; say how (새 대화 + 인수인계).
  - 다시 시킨 비율: `redo_or_correction_prompts` ÷ `prompts`. Above ~20% means requests were too vague or the first answer was off: suggest stating the goal, the format and an example up front. Name the session with the most corrections.
  - 요청의 구체성: `avg_prompt_chars` and `very_short_prompts` (a lone "ㄹ" is a stray key press).
  - 도구 실패: `tool_errors` high means permission or path problems worth fixing once.
  - 모델 선택: share of the pricier model for simple work; cache reuse is normally near 100% and says nothing.
- **비용**: `cost_usd` only if `cost_days` > 0, else skip it.
- Compare with `before`; if it is empty, say it cannot be compared yet. Do not invent a budget.

Be honest about limits, in one line at the end:
- Corrections are counted by words like 아니/다시/별로, so it over- and under-counts; treat it as a hint.
- A session is placed on the day of its last message, so one long multi-day session counts entirely on that day.
- `cost_usd` is exact only on days the cost-band mod ran. Only this computer's Claude Code sessions count. Records start at `first_record`.
