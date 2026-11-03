# cost-band

Claude Code 입력창 위에 비용과 대화 기억 공간을 보여주는 밴드, 그리고 "AI를 잘 쓰고 있나" 평가를 한 번에 돌리는 플러그인이에요. 화면과 평가 문구는 한국어예요.

## 기능
- **밴드:** 이번 대화 비용, 방금 답변 비용, 대화 기억 공간(사용/남음)을 한 줄로 보여줘요. `자세히`를 누르면 대화 수, 일한 시간 등이 나와요.
- **정리하고 이어가기:** 현재 맥락을 `~/.claude/handoffs/latest.md`에 저장 → `/clear` → 저장한 내용으로 이어받기를 한 번에 해요.
- **일일 / 주간 / 월간 평가:** 이 컴퓨터의 Claude Code 기록을 읽어서 대화가 너무 길어지는지, 같은 걸 다시 시키는지 등을 짚어줘요. `/cost-band:usage-review day|week|month`로도 실행할 수 있어요.

## 설치
터미널의 Claude Code에서:

```
/plugin install cost-band --marketplace jeonjuseong11/cost-band
```

셸에서:

```
claude plugin install cost-band --marketplace jeonjuseong11/cost-band
```

데스크톱 앱에서는 입력창 옆 `+` → Plugins → Add marketplace에 `jeonjuseong11/cost-band`를 넣고 Add plugin을 누르세요.

## 알아 둘 점
- 사용량 기록은 모두 내 컴퓨터 안(`~/.claude`)에서만 읽고 쓰며, 어디로도 보내지 않아요.
- 비용(달러)은 이 플러그인을 켠 날부터만 정확해요. 그 전 날은 토큰 양으로만 평가해요.
- 웹/폰 앱과 다른 컴퓨터의 사용량은 포함되지 않아요.
- 밴드는 데스크톱 앱과 터미널 화면에서 그려져요. 평가 스킬은 Python 3이 필요해요.
