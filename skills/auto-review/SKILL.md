---
name: auto-review
description: GitLab에서 나에게 온 MR 리뷰 요청을 감시하고 리뷰를 진행한다. "리뷰 요청 감시 시작해줘", "자동 리뷰 켜줘", "밀린 리뷰 요청 뭐 있어?", "8시간만 감시해줘", "감시 멈춰줘"에 사용한다. Codex Desktop 로컬 환경과 Claude Code에서 공통 감시기를 사용한다. 기본 감시는 6시간이며 게시 확인 정책은 bypass-review가 정한다.
---

# MR 리뷰 요청 감시

GitLab todos로 리뷰 요청을 감지한다. Mattermost를 감시하지 않는다. 시작 전에 현재 클라이언트의 실행 안내를 읽는다: Codex는 [codex.md](../references/codex.md), Claude Code는 [claude-code.md](../references/claude-code.md).

`<PLUGIN_ROOT>`는 실행 안내에 따라 설치된 플러그인의 절대경로로 치환한다. 데이터는 MCP·감시·bypass 모두 같은 `resolveDataDir()` 규칙(기본 `~/.mmp`)으로 읽는다.

## 0. 설정 확인

데이터 디렉터리의 `watch.json`에 감시할 프로젝트를 등록한다. 값이 없으면 사용자에게 묻는다. 경로나 Jira 정보를 추측하지 않는다.

```json
{
  "projects": {
    "group/sub/repo": {
      "workdir": "C:/work/repo",
      "jiraBaseUrl": "https://jira.example.com/browse"
    }
  }
}
```

`host`가 없으면 로그인한 호스트가 정확히 하나일 때만 추론한다. 등록한 프로젝트에 workdir와 jiraBaseUrl이 모두 있어야 한다.

## 1. 밀린 요청과 현재 정책

```bash
node "<PLUGIN_ROOT>/bin/mr-watch.mjs" --pending
node "<PLUGIN_ROOT>/bin/mr-watch.mjs" --status
node "<PLUGIN_ROOT>/bin/bypass-review.mjs" status
```

밀린 요청을 요청자·MR·제목·시각·확정 여부 표로 보여준다. 사용자가 선택한 것만 리뷰한다. 기존 백로그를 임의로 전부 시작하지 않는다.

감시 시작을 보고할 때 프로젝트, 시간, 현재 bypass, 실제 확인 주기를 말한다. bypass가 켜져 있으면 MR 답글과 작성자 DM을 확인 없이 보낸다는 점을 명시한다. 감시 시작만으로 bypass를 변경하지 않는다.

## 2. 감시 실행

현재 클라이언트의 실행 안내로 시작한다. Claude는 Monitor, Codex는 현재 채팅의 반복 자동화를 사용한다. 시작/중지/만료 시각은 상태 파일에 저장하며, 동일 데이터 디렉터리에서 두 클라이언트가 동시에 감시하지 않는다.

```bash
node "<PLUGIN_ROOT>/bin/mr-watch.mjs" --start --client <claude|codex> --hours 6
node "<PLUGIN_ROOT>/bin/mr-watch.mjs" --once --client <claude|codex>
node "<PLUGIN_ROOT>/bin/mr-watch.mjs" --queue
```

기본은 6시간이다. 사용자가 지정한 시간을 그대로 적용하고, 끌 때까지 요청했으면 `--start`에 `--forever`를 쓴다. 재무장/반복 실행 시 시작 명령을 다시 호출해 종료 시각을 연장하지 않는다.

## 3. 이벤트 처리

감시기는 감지한 요청을 디스크에 먼저 저장하고 ack 전까지 재전달한다.

| 필드 | 의미 |
|---|---|
| eventId | 대기 목록의 식별자. 중복 실행 방지와 ack에 사용 |
| certain | true면 GitLab 리뷰어 지정/승인 요청, false면 검증한 댓글 요청 |
| reviewRequested | true인 이벤트만 자동 리뷰 가능. false/review_ignored는 새 리뷰를 시작하지 않음 |
| mrUrl | 공통 mr-review 스킬에 넘길 MR 링크 |
| body | 멘션이 리뷰 부탁인지 판단할 본문 |
| workdir | 해당 프로젝트의 로컬 클론 |
| mode | 출력 시점의 bypass 정책. 리뷰/게시 시 다시 확인 |

- certain=true면 리뷰 요청으로 처리한다.
- certain=false면 실제 `#note_ID` 댓글을 조회해 MR 작성자의 명시적 리뷰 요청인지 감시기가 검증한다. 단순 멘션·확인 부탁·질문·리뷰 결과·감사·인용·시스템 댓글·다른 리뷰어의 댓글은 자동 리뷰하지 않는다. `reviewRequested=true`여도 요청 맥락을 다시 확인하고, 애매하면 실행하지 않는다. todo.body나 MR 제목을 댓글로 추정하지 않는다.
- `type=review_ignored` 또는 `reviewRequested=false`면 리뷰·채팅 생성·기존 채팅 깨우기·게시·DM을 하지 않는다. 자동 처리 범위의 이벤트만 제외 ack한다. 사용자가 선택한 진행 중 리뷰나 제외해 보존 중인 백로그를 일괄 ack하지 않는다. 댓글 조회 실패는 요청으로 추정하거나 제외 ack하지 않고 오류를 보고한다.
- watch_error는 오류를 보고하고 원인을 해결한다. 실패한 요청을 ack하지 않는다.
- watch_stopped는 종료/만료다. 해당 감시 실행을 끝내고 반복 자동화가 있다면 중지한다.
- 같은 eventId가 다시 오면 하네스 상태와 이미 표시한 요청을 확인한다. 작업 칩·리뷰·답글을 중복 생성하지 않는다.

## 4. 리뷰와 처리 확인

매 요청마다 현재 bypass를 다시 읽는다. Codex에서 독립 채팅 생성을 승인받은 감시는 **MR 최초 요청에만** 감시 채팅과 별도의 워크트리·채팅을 만든다. 재리뷰는 eventId가 달라도 GitLab 호스트·프로젝트·MR 번호가 같은 기존 채팅·워크트리를 재사용한다. 이전 회차가 실행 중/확인 대기이면 큐에서 기다리고 새 채팅을 만들지 않는다. bypass가 꺼져 있으면 리뷰 채팅에서 게시·DM 확인을 받는다. 독립 생성 승인이 없거나 Claude인 경우 현재 클라이언트 실행 안내를 따른다.

Codex의 생성 의도·채팅 ID는 `--session-claim` / `--session-bind`로 저장한다. 큐를 ack해도 세션 목록은 남고, 감시 채팅은 `--sessions --check`로 실제 병합을 확인해 **리뷰 채팅만** 보관한다. 생성 결과 불명확·실패 시 같은 이벤트로 채팅을 중복 생성하지 않는다. 사용자별 MM·DM 수신 제한은 새 채팅에도 반드시 전달한다.

완료 DM의 기본 수신자는 실제 리뷰 요청자다. 이벤트의 검증된 authorUsername 또는 신뢰된 대화에서 확인해 prepare --requester에 전달한다. 요청자가 알려져 있는데 매핑이 없으면 묻고, 본인이나 MR 작성자로 대체하지 않는다. 별도 요청자 정보가 전혀 없을 때만 MR 작성자를 사용하고 이유를 밝힌다. 과거 “나에게만” 테스트 제한을 영구 기본값으로 복사하지 않고 최신 사용자 지시를 따른다. 기존 저장된 제한 변경은 mr-review의 사용자 확인 규칙을 지키며 완료 DM은 재전송하지 않는다.

`--session-claim`은 같은 MR이 있으면 새 세션 레코드 대신 기존 레코드의 `eventIds`에 새 요청을 연결하고 `reused=true`를 반환한다. 이때 create_thread/create_worktree를 호출하지 않는다. 생성 중·ID 미연결·워크트리 누락이어도 새로 만들어 대체하지 않는다. 기존 중복 기록은 보존하며 새 이벤트는 최초 연결 채팅으로 모은다. 기존 이벤트에 이미 연결된 다른 채팅을 임의로 재연결하지 않는다.

[mr-review](../mr-review/SKILL.md)의 판정·게시·DM 규칙을 그대로 따른다. 재전달이면 기존 상태에서 재개한다. `prepare`를 다시 호출해 reviewed/posted 상태를 덮어쓰지 않는다. 진행 중인 다른 MR을 덮어쓰지 않는다.

새 리뷰 채팅에도 판정 정책을 전달한다: 문서 중심 MR은 중요한 내용 수정이면 보류, 사소한 수정만 승인한다. 일반 MR의 비차단 코드·문서 보완은 승인하고 댓글에 수정 방향과 “위 항목을 수정한 뒤 직접 병합해 주세요.”를 남긴다. bypass ON·미확인 0건·필수 검사 통과 등 공통 게이트를 모두 만족하면 보완 의견이 있어도 하네스 `auto-approve`를 실행한다. Merge는 항상 수동이다.

요청의 eventId를 리뷰 세션에 전달하고, 완료 후 다음을 실행한다.

```bash
node "<PLUGIN_ROOT>/bin/mr-watch.mjs" --ack <eventId>
```

리뷰·DM이 완료됐거나 사용자가 명시적으로 제외했을 때만 ack한다. 요청 표시만으로 ack하지 않는다. 끝난 MR 번호·판정·워크트리 경로를 보고한다.

## 감시 종료와 복구

`--stop`으로 종료 상태를 저장하고 현재 클라이언트의 Monitor/자동화를 중지한다. 대기 목록은 남아 있으며 `--queue`로 확인한다. `--start`로 재개하면 대기 목록을 이어받는다.

프로세스가 강제 종료돼 잠금이 남으면 오류에 표시된 PID가 종료됐는지 확인하고 해당 잠금 파일만 제거한다. `watch-state.json`이나 대기 목록을 지워 복구하지 않는다. 손상된 상태 파일은 조용히 초기화하지 않고 복구가 필요하다고 보고한다.

GitLab todo를 done 처리하지 않는다. 설정되지 않은 프로젝트를 추가하거나 담당자 지정(assigned)을 리뷰 요청으로 처리하지 않는다. bypass 설정을 바꾸는 일은 감시 종료와 별개다.
