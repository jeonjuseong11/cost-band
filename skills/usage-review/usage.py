#!/usr/bin/env python3
"""Aggregate Claude Code usage on this machine from session transcripts. Prints JSON."""
import csv, glob, json, os
from collections import defaultdict
from datetime import datetime, timedelta

home = os.path.expanduser('~/.claude')
import re
FIX = re.compile(r'별로|다시|아니|말고|그게 아니|틀렸|안 ?돼|안 ?되|이상|못생|왜 |잘못|not |wrong|no,|undo|revert', re.I)
seen = {}  # one API response can span several transcript lines: keep the last per id
prompts = []  # (session, timestamp, text) typed by the person, not tool results or automatic notices
errors = defaultdict(int)  # tool calls that failed, per session
for path in glob.glob(f'{home}/projects/**/*.jsonl', recursive=True):
    for line in open(path, errors='ignore'):
        if '"usage"' not in line and '"type":"user"' not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get('type') == 'user' and not d.get('isSidechain') and d.get('timestamp'):
            c = (d.get('message') or {}).get('content')
            if isinstance(c, list):
                errors[d.get('sessionId')] += sum(1 for b in c if isinstance(b, dict) and b.get('is_error'))
                c = ' '.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text') if not any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c) else ''
            if isinstance(c, str) and c.strip() and not c.lstrip().startswith('<'):
                prompts.append((d.get('sessionId'), d['timestamp'], c.strip()))
            continue
        m = d.get('message') or {}
        u = m.get('usage')
        if d.get('type') != 'assistant' or not u or not d.get('timestamp'):
            continue
        seen[m.get('id') or d.get('requestId') or d['uuid']] = (d, m, u)

def day(ts):  # local date of an ISO UTC timestamp
    return datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone().date()

days = defaultdict(lambda: defaultdict(float))
ses = defaultdict(lambda: {'turns': 0, 'max_ctx': 0, 'last': None, 'project': '?', 'prompts': 0, 'fixes': 0, 'short': 0, 'chars': 0})
sessions, models, projects = defaultdict(set), defaultdict(lambda: defaultdict(float)), defaultdict(lambda: defaultdict(float))
for d, m, u in seen.values():
    k = day(d['timestamp'])
    t = days[k]
    t['turns'] += 1
    t['input'] += u.get('input_tokens', 0)
    t['output'] += u.get('output_tokens', 0)
    t['cache_read'] += u.get('cache_read_input_tokens', 0)
    t['cache_write'] += u.get('cache_creation_input_tokens', 0)
    sessions[k].add(d.get('sessionId'))
    x = ses[d.get('sessionId')]
    x['turns'] += 1
    x['max_ctx'] = max(x['max_ctx'], u.get('input_tokens', 0) + u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0))
    x['last'] = max(x['last'] or k, k)
    x['project'] = os.path.basename(d.get('cwd', '?')) or '?'
    models[k][m.get('model', '?')] += 1
    projects[k][os.path.basename(d.get('cwd', '?')) or '?'] += 1

for sid, ts, text in prompts:
    x = ses[sid]
    x['prompts'] += 1
    x['chars'] += len(text)
    x['short'] += len(text) <= 3
    x['fixes'] += bool(FIX.search(text))

cost = defaultdict(float)  # exact dollars, only for days the cost-band mod was running
csv_path = f'{home}/cost-band-turns.csv'
if os.path.exists(csv_path):
    for r in csv.DictReader(open(csv_path)):
        if not r['agent']:
            cost[day(r['time'])] += float(r['turn_cost_usd'] or 0)

today = datetime.now().astimezone().date()
def period(span, offset):
    start = today - timedelta(days=span * (offset + 1) - 1)
    rng = [start + timedelta(days=i) for i in range(span)]
    agg = defaultdict(float)
    for k in rng:
        for f, v in days.get(k, {}).items():
            agg[f] += v
    s, mo, pr = set(), defaultdict(float), defaultdict(float)
    for k in rng:
        s |= sessions.get(k, set())
        for n, v in models.get(k, {}).items(): mo[n] += v
        for n, v in projects.get(k, {}).items(): pr[n] += v
    out = dict(agg, sessions=len(s), active_days=sum(1 for k in rng if k in days), cost_usd=round(sum(cost.get(k, 0) for k in rng), 2), cost_days=sum(1 for k in rng if k in cost))
    out['models'] = dict(mo)
    out['top_projects'] = dict(sorted(pr.items(), key=lambda x: -x[1])[:5])
    mine = [v for v in ses.values() if v['last'] in rng]
    n = sum(v['prompts'] for v in mine)
    out['habits'] = {
        'prompts': n,
        'avg_prompt_chars': round(sum(v['chars'] for v in mine) / n) if n else 0,
        'very_short_prompts': sum(v['short'] for v in mine),
        'redo_or_correction_prompts': sum(v['fixes'] for v in mine),
        'tool_errors': sum(errors.get(k, 0) for k, v in ses.items() if v in mine),
        'longest_sessions': sorted(({'project': v['project'], 'turns': v['turns'], 'max_context_tokens': v['max_ctx'], 'prompts': v['prompts'], 'corrections': v['fixes']} for v in mine), key=lambda v: -v['turns'])[:4],
    }
    out['range'] = f'{rng[0]}..{rng[-1]}'
    return out

print(json.dumps({
    'today': today.isoformat(),
    'first_record': min(days).isoformat() if days else None,
    'day': {'now': period(1, 0), 'before': period(1, 1)},
    'week': {'now': period(7, 0), 'before': period(7, 1)},
    'month': {'now': period(30, 0), 'before': period(30, 1)},
    'daily_last_14': {str(today - timedelta(days=i)): dict(days[today - timedelta(days=i)]) for i in range(14) if (today - timedelta(days=i)) in days},
}, ensure_ascii=False, indent=1))
