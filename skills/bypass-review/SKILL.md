---
name: bypass-review
description: MR 리뷰 자동화의 승인 정책을 켜고 끈다. "무승인으로 돌려줘", "승인 건너뛰게 해줘", "bypass 켜줘·꺼줘", "지금 승인 받나?", "기본 채널 바꿔줘" 처럼 리뷰 게시·DM에 사용자 확인을 받을지 물어볼 때 쓴다. 감시를 켜고 끄는 것과는 다르다 — 감시는 auto-review 가 담당한다.
---

# 리뷰 승인 정책 (bypass)

현재 클라이언트 실행 안내를 읽는다: Codex는 [codex.md](../references/codex.md), Claude Code는 [claude-code.md](../references/claude-code.md). `<PLUGIN_ROOT>`는 실제 설치 경로로 치환한다.

이 스킬이 정하는 건 **하나**다. 리뷰가 MR에 답글을 달고 DM을 보내기 전에 **사람에게 물어보느냐**.

| bypass | MR 답글 게시 | MM 알림 채널 |
|---|---|---|
| 꺼짐 (기본값) | 현재 클라이언트의 사용자 확인 승인 후에만 | 승인할 때 같이 고름 |
| 켜짐 | 승인 없이 바로 | 저장된 기본 채널로 자동 |

**이 스킬은 감시를 켜고 끄지 않는다.** 감시 설정의 active 상태는 `mr-watch.mjs --status`로 확인하고, 실제 Monitor/자동화가 실행되는지도 현재 클라이언트에서 확인한다. 저장된 active만으로 실제 감시가 돈다고 단정하지 않는다. "감시 꺼줘"는 이 스킬이 아니라 그 Monitor 를 멈추는 일이다.

## 명령

```bash
node "<PLUGIN_ROOT>/bin/bypass-review.mjs" status          # 지금 어떤 상태인지
node "<PLUGIN_ROOT>/bin/bypass-review.mjs" on              # 무승인 진행
node "<PLUGIN_ROOT>/bin/bypass-review.mjs" off             # 승인 받기 (기본값)
node "<PLUGIN_ROOT>/bin/bypass-review.mjs" channel "팀-채널명"
```

출력은 JSON 하나다: `{ bypass, defaultChannel, updatedAt }`.

## 지켜야 할 것

**1. `on` 은 되돌릴 수 없는 행동을 자동화한다. 켤 때 한 번 확인한다.**
MR 답글은 팀에 보이고, DM은 회수되지 않는다. `on` 으로 바꾸기 전에 그 사실과 현재 기본 채널을 말하고 승인을 받는다. `off` 로 돌리는 건 안전한 방향이므로 그냥 실행한다.

**2. 상태를 바꾼 뒤에는 반드시 결과를 보고한다.**
`status` 출력의 `bypass` 와 `defaultChannel` 을 그대로 말한다. "켰습니다"로 끝내지 마라 — 사용자가 확인할 수 있는 건 그 두 값뿐이다.

**3. 감시가 도는지 같이 알려준다.**
모드를 바꿨는데 감시 Monitor/자동화가 이 세션·채팅에 없으면, 바뀐 정책이 당장 아무 데도 적용되지 않는다. 그럴 땐 한 줄 덧붙인다: "지금 이 세션에 감시가 없으니 `/mmp:auto-review` 로 띄우거나, `/mmp:mr-review <MR링크>` 를 직접 쓸 때 적용됩니다."

**4. 승인 면제이지 검증 면제가 아니다.**
`bypass` 여도 하네스는 그대로 돈다 — 단계 순서, 보류 카테고리·코드 위치 인용, 중복 게시 차단, 직접 `glab mr approve`/`merge` 금지. `mr-review.mjs auto-approve`만 승인 판정·병합 차단 사유 없음·미확인 0건·검증 완료·최신 SHA 일치 및 CI 정책 충족 시 허용한다. 일반 MR의 비차단 코드·문서 보완 의견은 승인 대상이며, 댓글에 수정 방향과 “위 항목을 수정한 뒤 직접 병합해 주세요.”를 남긴다. 문서 중심 MR의 중요한 내용 수정은 보류하고 사소한 수정만 승인한다. 분류·증거 형식은 공통 mr-review 스킬을 따른다. CI가 있으면 동일 SHA의 성공이 필요하고, 실제 CI 부재를 확인한 MR만 로컬 필수 검사 전체 통과로 대체한다. Merge는 항상 금지한다. 사용자별 본인 전송 제한도 그대로다. 사용자가 "검사도 끄자"고 하면 그건 이 스킬이 하는 일이 아니라고 말한다.

**5. 기본 채널은 저장된 설정이 우선한다.**
초기값이 하나 박혀 있을 뿐이고 `channel` 로 언제든 바꾼다. 사용자가 다른 팀 채널을 말하면 그 값을 그대로 저장한다.
