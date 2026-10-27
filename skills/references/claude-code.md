# Claude Code 실행

공통 SKILL.md의 리뷰 기준과 하네스를 그대로 사용한다. 이 문서는 실행 수단만 정한다.

- `<PLUGIN_ROOT>`는 설치된 플러그인의 절대경로다. Claude의 `CLAUDE_PLUGIN_ROOT` 또는 현재 스킬 위치로 확인한다.
- 사용자에게 게시 전문과 리뷰 요청자 DM 대상·논리 채널을 보여주고 `AskUserQuestion`으로 확인한다. 응답을 받은 뒤 `post --confirmed`를 실행한다. bypass가 켜져 있으면 공통 정책대로 진행한다. 요청자 GitLab ID를 확인해 prepare --requester로 전달하고 과거 본인 전송 제한은 최신 사용자 지시와 공통 확인 규칙에 따라 처리한다.
- 제목은 `get_session({session_id:"self"})`로 기억하고 `set_session_title`로 변경/복원한다. 이 도구가 없으면 MR 번호와 작업 경로를 대화에 표시한다.
- `prepare` 출력 `reusedInPlace`가 false면 `EnterWorktree({path:worktreePath})`로 들어간다. 실패하면 반환된 절대경로와 하네스의 `--cwd`를 사용하고 이동 실패를 알린다.
- 인라인 리뷰가 끝나면 `ExitWorktree({action:"keep"})`로 나온다. 워크트리는 자동 삭제하지 않는다.
- 셸 한 줄의 `cd`가 다음 호출에 유지된다고 가정하지 않는다. 하네스에는 `--cwd "<worktreePath>"`를 붙이고, 코드 조회와 테스트는 해당 경로에서 실행한다.

## 감시

`mr-watch.mjs --start --client claude --hours <시간>`으로 시작/종료 시각을 저장한다(기본 6시간). 사용자가 끌 때까지 요청했으면 `--forever`를 쓴다.

```
Monitor({
  command: 'node "<PLUGIN_ROOT>/bin/mr-watch.mjs" --client claude',
  timeout_ms: 1800000,
  description: "GitLab MR 리뷰 요청"
})
```

- `Monitor`가 만료되면 `--status`를 읽고 active일 때만 재무장한다. 재무장할 때 `--start`를 다시 호출하지 않는다. 저장된 종료 시각은 대화 압축으로 초기화되지 않는다. 만료만으로 매번 알리지 않는다.
- 이벤트에는 `eventId`가 있다. 같은 이벤트가 다시 출력돼도 대기 중인 작업을 중복 생성하지 않는다. 리뷰 완료·명시적 제외·사용자가 수락한 작업 인계가 끝났을 때 `--ack <eventId>`한다. 작업 칩을 표시하기만 하고 ack하지 않는다.
- bypass 꺼짐: 기존 `spawn_task`가 제공되면 작업 칩을 만들고, 클릭해 열린 리뷰 전용 워크트리에서 `prepare --here`로 시작한다. 칩은 최대 3개이며 대기 이벤트 식별자를 리뷰 세션에 전달한다. 도구가 없으면 현재 세션에 대기 요청을 표시한다.
- bypass 켜짐: 이 세션에서 `prepare` 후 반환된 워크트리로 들어가 한 건씩 공통 리뷰 절차를 수행한다. 감시 자리에는 `--here`를 붙이지 않는다.
- 감시로 시작한 `prepare`에는 `--event-id <eventId>`를 붙인다. 재전달 이벤트는 하네스 `status`의 eventId가 같은지 먼저 확인한다. 같은 이벤트에서 `posted`면 notify, `reviewed`면 게시 정책부터 재개하고 `notified`면 ack한다. 새 재리뷰 이벤트는 같은 MR의 기존 세션·워크트리에서 `prepare --rereview --here --event-id <새eventId>`로 새 회차를 시작한다. 이전 리뷰가 진행 중이면 먼저 끝내고 새 작업 칩/워크트리로 우회하지 않는다. 일반 멘션은 실제 MR 작성자의 명시적인 요청을 검증한 `reviewRequested=true`만 처리하며 리뷰 결과·질문·감사 댓글은 리뷰하지 않는다.
- 멈출 때 `mr-watch.mjs --stop`을 먼저 실행하고 `TaskStop`으로 Monitor를 중지한다. 제목을 복원한다. 진행 중인 리뷰까지 멈추라는 지시가 있으면 상태와 워크트리 경로를 보고하고 사용자 작업을 보존한다.
