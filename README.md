# Mattermost Manager Plugin (MMP)

Codex와 Claude Code에서 함께 사용하는 로컬 stdio MCP 서버입니다. Mattermost Incoming Webhook, 논리 채널, 참여자 식별 정보, 메시지 컨벤션을 로컬 SQLite에 저장하고 자연어로 관리하거나 메시지를 전송할 수 있습니다.

## 기능

- Mattermost Incoming Webhook 등록·조회·수정·삭제
- 여러 논리 채널 및 DM 대상 등록·조회·수정·삭제
- 전역 사람 정보 CRUD, 이름 부분검색, GitLab 사용자와 Mattermost `@아이디` 매핑
- 전역 사람을 외래키로 연결하는 논리 채널별 참여자 디렉터리
- 저장된 사람에게 Incoming Webhook 채널 오버라이드로 개인 DM 전송
- `{{variable}}` 메시지 컨벤션 CRUD 및 미리보기
- 한 번의 호출로 여러 채널에 메시지 전송
- Codex·Claude Code 공용 자연어 리뷰 메시지·웹훅·채널 관리 스킬
- 리뷰 요청·완료 메시지의 정확한 `@멘션`, 상태 이모지, MR/Jira 한 줄 형식 강제
- `/mmp:auto-review` — GitLab todos로 리뷰 요청(리뷰어 지정·멘션)을 감시해 리뷰 세션을 띄움
- `/mmp:bypass-review` — 리뷰 게시·DM에 사용자 승인을 받을지 (`on` / `off`)
- `/mmp:mr-review` — MR 링크 하나로 브랜치 체크아웃부터 MR 답글·작성자 DM까지

## 요구 환경

- Node.js 22.13 이상 (`node:sqlite` 무플래그 사용)
- npm
- Git
- Codex CLI 또는 Claude Code
- `glab` (MR 리뷰 기능에만 필요. `glab auth login --hostname <호스트>`로 로그인)
- 메시지를 보낼 Mattermost Incoming Webhook URL

Windows, macOS, Linux에서 실행할 수 있습니다. 현재 GitHub 저장소는 공개되어 있으며, 저장소가 비공개로 전환된 경우에만 접근 권한과 GitHub 인증이 필요합니다.

## 설치

```powershell
gh repo clone kdHyeok/MMP
cd MMP
npm ci
npm test
npm run smoke
```

`gh`를 사용하지 않으면 접근 권한이 있는 Git 자격 증명으로 저장소를 복제한 뒤 `npm ci`를 실행하세요.

## Codex와 Claude Code에 등록

| 클라이언트 | 설치 후 표시되는 플러그인 | 포함 기능 | 적용 시점 |
|---|---|---|---|
| Codex | `mmp@personal` | MCP 서버, 공용 자연어 스킬, MMP 아이콘 | 새 Codex 작업 |
| Claude Code | `mmp@mmp-local` | MCP 서버, 동일한 자연어 스킬 | 새 Claude Code 세션 |

### Codex 로컬 플러그인으로 설치

Codex에서는 저장소 전체를 로컬 플러그인 소스로 사용할 수 있습니다. 플러그인 하나로 MCP와 `mattermost-review-message` 스킬이 함께 설치됩니다.

먼저 저장소에서 의존성과 동작을 확인합니다.

```powershell
npm ci
npm test
npm run smoke
```

그다음 이 저장소를 개인 마켓플레이스의 `mmp` 소스로 등록하고 플러그인을 설치합니다. 이 저장소에 포함된 `scripts/install-codex-plugin.ps1`을 실행하면 됩니다.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-codex-plugin.ps1
```

설치 상태는 다음 명령으로 확인합니다.

```powershell
codex plugin list
```

출력에서 `mmp@personal`이 활성화되어 있는지 확인합니다.

설치 또는 업데이트 후에는 새 Codex 작업을 열어야 플러그인의 MCP 도구와 스킬이 적용됩니다. 로컬 SQLite 설정은 `~/.mmp/mattermost.sqlite3`에서 Codex와 Claude가 함께 사용하며, 기존 Windows AppData 데이터는 첫 실행 때 자동 이전됩니다.

### Claude Code 플러그인으로 설치

Claude Code에서도 같은 `mattermost-review-message` 스킬과 MCP 서버를 플러그인 하나로 설치할 수 있습니다. 저장소 루트의 `.claude-plugin` 마켓플레이스를 추가한 뒤 설치합니다.

```powershell
claude plugin marketplace add ./ --scope user
claude plugin install mmp@mmp-local --scope user
claude plugin list
```

출력에서 `mmp@mmp-local`의 `enabled`가 `true`이고 MCP 서버 `mmp`가 표시되는지 확인합니다.

GitHub에서 직접 설치할 다른 사용자는 저장소 접근 권한과 Git 인증 후 아래처럼 등록합니다.

```powershell
claude plugin marketplace add kdHyeok/MMP --scope user
claude plugin install mmp@mmp-local --scope user
```

설치 후 새 Claude Code 세션을 시작합니다. 개발 중인 현재 파일을 설치 없이 시험하려면 저장소의 부모 디렉터리에서 `claude --plugin-dir .\MMP`를 실행할 수 있습니다.

Claude Code는 `claude-mcp.json`의 `${CLAUDE_PLUGIN_ROOT}`를 사용하고, Codex는 `.mcp.json`의 `${PLUGIN_ROOT}`를 사용합니다. 두 클라이언트 모두 같은 서버 코드와 로컬 SQLite 데이터를 사용합니다.

Claude Code에서 리뷰 메시지 스킬을 직접 실행하는 명령은 `/mmp:mattermost-review-message`입니다. 이는 Codex의 `mattermost-review-message`와 같은 스킬이며, 연결되는 MCP 서버는 `plugin:mmp:mmp`로 표시됩니다. 설정이 비어 있다고 나오면 플러그인을 업데이트한 뒤 새 Claude Code 세션을 시작하세요.

### MCP만 직접 등록

아래 방식은 플러그인 스킬 없이 MCP 도구만 직접 등록할 때 사용합니다.

### Windows PowerShell

저장소 루트에서 실행합니다.

```powershell
$repoPath = (Resolve-Path .).Path
$nodePath = (Get-Command node).Source
$serverPath = Join-Path $repoPath 'src\server.js'

codex mcp add mmp -- $nodePath $serverPath
claude mcp add --scope user mmp -- $nodePath $serverPath
```

### macOS 또는 Linux

```bash
codex mcp add mmp -- "$(command -v node)" "$(pwd)/src/server.js"
claude mcp add --scope user mmp -- "$(command -v node)" "$(pwd)/src/server.js"
```

등록 상태를 확인합니다.

```powershell
codex mcp get mmp
claude mcp get mmp
```

등록 후 새 Codex/Claude 작업을 열어야 도구가 표시될 수 있습니다.

## 자연어 스킬만 별도 설치

플러그인을 설치하지 않고도 MCP 도구 이름을 직접 말하지 않은 채 `웹훅 목록 보여줘`, `리뷰 요청 mm에 보내줘`처럼 사용하려면 포함된 스킬을 별도 설치할 수 있습니다. 아래 수동 복사는 Codex용이며, Claude Code는 위 플러그인 설치를 권장합니다.

### Windows PowerShell

```powershell
$skillSource = Join-Path (Resolve-Path .).Path 'skills\mattermost-review-message'
$skillTarget = Join-Path $env:USERPROFILE '.codex\skills\mattermost-review-message'
New-Item -ItemType Directory -Force -Path $skillTarget | Out-Null
Copy-Item -Path (Join-Path $skillSource '*') -Destination $skillTarget -Recurse -Force
```

### macOS 또는 Linux

```bash
mkdir -p ~/.codex/skills
cp -R skills/mattermost-review-message ~/.codex/skills/
```

새 Codex 작업부터 자동으로 적용됩니다. 첫 메시지 전송 시 등록된 채널 목록을 조회해 선택을 요청하고, 선택한 채널은 현재 작업에서만 기본값으로 기억합니다.

## 처음 사용하는 사람을 위한 설정 가이드

MMP를 처음 사용할 때는 아래 순서로 설정합니다.

```text
1. Mattermost에서 Incoming Webhook 발급
2. MMP에 웹훅 등록
3. 메시지를 보낼 논리 채널 등록
4. 본인과 팀원 정보 등록
5. 메시지 컨벤션 등록
6. 미리보기 후 첫 메시지 전송
```

웹훅, 채널, 사람, 컨벤션 설정은 한 번 등록하면 로컬 SQLite에 저장되므로 Codex와 Claude Code가 함께 사용할 수 있습니다. 단, 대화에서 선택한 기본 채널은 현재 Codex 작업 또는 Claude Code 세션에서만 기억합니다.

### 1. Mattermost Incoming Webhook 발급

1. Mattermost에서 메시지를 보낼 팀에 접속합니다.
2. `Product menu → Integrations → Incoming Webhooks`로 이동합니다.
3. `Add Incoming Webhook`을 선택합니다.
4. 웹훅 이름과 설명을 입력하고 기본 수신 채널을 선택합니다.
5. 생성 후 표시되는 `https://<서버>/hooks/<발급키>` URL을 복사합니다.

`Integrations` 또는 `Incoming Webhooks` 메뉴가 보이지 않으면 서버 관리자가 Incoming Webhook 기능이나 사용자 생성 권한을 활성화해야 합니다. 자세한 발급 절차는 [Mattermost Incoming Webhook 공식 문서](https://developers.mattermost.com/integrate/webhooks/incoming/)를 참고하세요.

웹훅 생성 화면에서 채널 잠금을 활성화하면 그 웹훅은 지정된 기본 채널에만 전송할 수 있습니다. 한 웹훅으로 여러 채널이나 DM에 보내려면 Mattermost 서버 정책과 웹훅 설정이 채널 오버라이드를 허용해야 하며, 웹훅 생성자가 대상 채널에 접근할 수 있어야 합니다. 조직 정책상 잠금이 강제되면 채널별로 웹훅을 따로 발급하세요.

> 웹훅 URL은 메시지를 보낼 수 있는 비밀값입니다. README, Git, 이슈, 채팅 로그에 실제 URL을 남기지 말고 노출되면 Mattermost에서 폐기·재발급하세요.

### 2. MMP에 웹훅 등록

Codex 또는 Claude Code의 새 세션에서 자연어로 다음처럼 요청합니다.

```text
웹훅 이름은 "팀-웹훅"이고 URL은
https://mattermost.example.com/hooks/REPLACE_ME 이야. MMP에 등록해줘.
```

등록 후 URL은 다시 출력되지 않고 마지막 경로가 가려진 형태로만 조회됩니다. 다음 요청으로 정상 등록 여부를 확인합니다.

```text
등록된 Mattermost 웹훅 목록 보여줘.
```

이름을 바꾸거나 URL을 재발급한 경우에도 자연어로 수정할 수 있습니다.

```text
"팀-웹훅" 이름을 "프로젝트-웹훅"으로 변경해줘.
"프로젝트-웹훅"의 URL을 새로 발급한 이 URL로 교체해줘: https://mattermost.example.com/hooks/REPLACE_ME
```

### 3. 메시지를 보낼 채널 등록

MMP의 채널은 실제 Mattermost 채널을 생성하는 기능이 아니라, 저장된 웹훅과 Mattermost 목적지를 연결하는 로컬 별칭입니다.

1. Mattermost에서 대상 채널을 엽니다.
2. 브라우저 주소를 복사합니다. 일반적인 주소는 `https://<서버>/<팀>/channels/<채널명>` 형태입니다.
3. 원하는 로컬 별칭, 사용할 웹훅 이름, 복사한 채널 URL을 함께 전달합니다.

```text
"프로젝트-웹훅"을 사용하는 논리 채널을 등록해줘.
이름은 "백엔드-팀"이고 채널 URL은
https://mattermost.example.com/my-team/channels/backend-team 이야.
```

자연어 스킬은 `/channels/` 뒤의 `backend-team`을 Mattermost 채널명으로 저장합니다. Mattermost Webhook API는 화면 표시명 대신 URL에 나타나는 채널명을 사용합니다.

웹훅을 발급할 때 지정한 기본 채널에만 보낼 경우에는 URL을 생략할 수 있습니다.

```text
"프로젝트-웹훅"의 기본 채널을 사용하는 "기본-알림" 채널을 등록해줘.
```

등록 결과는 다음처럼 확인합니다.

```text
등록된 Mattermost 채널 목록 보여줘.
"백엔드-팀" 채널 설정 보여줘.
```

채널 URL 전체가 `mattermost_channel` 값으로 저장되는 것이 아니라 실제 전송에 필요한 마지막 채널명만 저장됩니다. `Couldn't find the channel` 오류가 나면 URL의 `/channels/` 뒤 값, 웹훅 생성자의 채널 접근 권한, 채널 잠금 설정을 확인하세요.

### 4. 본인과 메시지를 보낼 사람 등록

정확한 `@멘션`과 DM 전송을 위해 사람 정보를 등록합니다. 필요한 값은 다음과 같습니다.

- 표시 이름: 대화에서 사람을 찾을 때 사용하는 이름
- Mattermost 사용자명: 프로필에 표시되는 `@username`의 `username` 부분
- GitLab 사용자명: 리뷰 요청자 또는 MR 작성자를 자동으로 연결할 때 사용하는 선택값
- 본인 여부: 현재 사용자를 다른 리뷰 요청자와 구분하기 위한 값

본인은 한 명만 등록할 수 있습니다.

```text
내 이름은 김철수이고 Mattermost 아이디는 chulsoo.kim,
GitLab 아이디는 my-gitlab-id야. 나로 등록해줘.
```

팀원은 다음처럼 등록합니다.

```text
박영희을 사람 목록에 등록해줘.
Mattermost 아이디는 younghee이고 GitLab 아이디는 younghee야.
```

등록한 사람을 특정 논리 채널의 로컬 참여자 목록에도 연결할 수 있습니다.

```text
박영희을 "백엔드-팀" 참여자로 추가해줘.
"백엔드-팀"에 등록된 참여자 목록 보여줘.
```

이 참여자 목록은 MMP의 로컬 디렉터리입니다. Incoming Webhook은 실제 Mattermost 채널 멤버를 조회할 수 없으므로, Mattermost 서버의 가입 상태를 자동으로 가져오거나 변경하지 않습니다.

이름 일부로도 사람을 찾을 수 있습니다.

```text
이름에 "성용"이 들어가는 사람 찾아줘.
```

여러 명이 검색되면 MMP 스킬은 임의로 선택하지 않고 누구인지 다시 묻습니다. 사람 목록은 다음 요청으로 전체 확인할 수 있습니다.

```text
등록된 사람과 GitLab-Mattermost 매핑을 모두 보여줘.
```

### 5. 메시지 컨벤션 등록

컨벤션은 `{{변수명}}`을 포함하는 재사용 가능한 메시지 템플릿입니다. 컨벤션 자체는 전역으로 저장되며 특정 채널에 자동 귀속되지 않습니다. 채널마다 다른 형식을 사용하려면 컨벤션 이름을 나눠 등록하고 전송할 때 원하는 채널과 컨벤션을 함께 지정합니다.

```text
"백엔드-배포완료" 컨벤션을 등록해줘.
템플릿은 "{{mention}} ✅ {{service}} {{version}} 배포 완료"야.
```

리뷰 자연어 기능을 사용하려면 아래 두 예약 컨벤션을 정확히 등록합니다.

```text
"review-request" 컨벤션을 등록해줘.
템플릿은 "{{mention}} :merge_please: !{{mr_number}} | [{{jira_key}}] {{message}}"야.
```

```text
"review-complete" 컨벤션을 등록해줘.
템플릿은 "{{mention}} :review_complete_shake: !{{mr_number}} | [{{jira_key}}] {{message}}"야.
```

예약 리뷰 컨벤션은 서버에서도 형식을 검사합니다. 멘션이 `@`로 시작하지 않거나 MR 번호, Jira 키, 한 줄 메시지가 빠지면 전송이 거부됩니다. 리뷰 DM의 본문 멘션이 선택한 DM 대상과 달라도 전송되지 않습니다.

등록된 컨벤션과 필요한 변수는 다음처럼 확인합니다.

```text
등록된 메시지 컨벤션 목록 보여줘.
"review-request" 컨벤션에 필요한 변수 보여줘.
```

일반 컨벤션은 전송 전에 값을 넣어 미리볼 수 있습니다.

```text
"백엔드-배포완료" 컨벤션을
mention=@channel, service=api, version=v1.2.0으로 미리보기 해줘.
```

### 6. 첫 메시지 미리보기와 전송

현재 세션에서 기본 채널을 아직 선택하지 않았다면 MMP 스킬이 등록된 채널 목록을 조회한 뒤 어느 채널을 사용할지 묻습니다. 한 번 승인한 채널은 해당 세션의 기본 채널이 되며 이후 `mm에 보내줘`라고만 해도 그 채널을 사용합니다.

처음에는 미리보기로 대상과 문구를 확인하는 것을 권장합니다.

```text
"백엔드-배포완료"를 service=api, version=v1.2.0으로
"백엔드-팀"에 보낼 메시지 미리보기 해줘.
```

미리보기가 맞으면 전송을 요청합니다.

```text
방금 미리보기를 "백엔드-팀"에 mm으로 보내줘.
```

다른 채널을 이번 한 번만 사용할 수도 있습니다.

```text
이번에만 "기본-알림" 채널에 mm 보내줘.
```

전송 후 MMP 스킬은 현재 세션의 기본 채널을 바꿀지 물어봅니다.

### 7. 리뷰 요청과 리뷰 완료 보내기

리뷰 메시지는 현재 대화, 브랜치, MR에서 대상자·MR 번호·Jira 키를 확인하고, 등록된 사람 정보로 GitLab 사용자명을 Mattermost 멘션에 연결합니다. 확인되지 않은 값은 추측하지 않고 필요한 값만 다시 묻습니다.

```text
성용이형에게 MR !124 리뷰 요청 mm 미리보기 보여줘.
Jira 키는 PROJ-124야.
```

예상 형식:

```text
@younghee :merge_please: !124 | [PROJ-124] 리뷰 부탁드립니당.
```

채널로 보내려면 다음처럼 요청합니다.

```text
리뷰 요청 mm에 보내줘.
```

개인 DM으로 보내려면 대상을 명시합니다.

```text
박영희에게 DM으로 리뷰 요청 mm 보내줘.
```

리뷰 완료도 같은 방식으로 사용할 수 있습니다.

```text
MR !124 리뷰 완료 mm 미리보기 보여줘.
```

```text
@요청자 :review_complete_shake: !124 | [PROJ-124] 리뷰 완료 했습니다.
```

리뷰 요청·완료는 자유문 `text`로 우회 전송할 수 없습니다. 반드시 예약 컨벤션을 사용하며, 상세 변경 요약이나 검증 내역은 사용자가 별도로 요청한 경우에만 덧붙입니다.

### 8. DM 보내기

DM은 등록된 사람의 Mattermost 사용자명을 목적지로 사용하고, `via_channel_name`에 해당하는 논리 채널의 웹훅 자격을 빌려 전송합니다.

```text
박영희에게 "회의 10분 전에 시작할게요."라고 Mattermost DM 보내줘.
```

처음 사용하는 세션에서는 어떤 논리 채널의 웹훅을 사용할지 묻게 됩니다. 웹훅의 채널 오버라이드가 막혀 있거나 서버 정책상 DM이 허용되지 않으면 Mattermost 오류를 그대로 안내합니다.

### 9. 설정 수정·삭제 예시

```text
"백엔드-팀" 채널 이름을 "특화-팀-BND"로 변경해줘.
박영희의 Mattermost 아이디를 new-younghee로 수정해줘.
"백엔드-배포완료" 컨벤션의 문구를 수정해줘.
사용하지 않는 "기본-알림" 채널을 삭제해줘.
```

연결된 논리 채널이 남아 있는 웹훅은 실수로 삭제되지 않습니다. 먼저 해당 채널을 다른 웹훅으로 옮기거나 삭제해야 합니다.

### 10. 최초 설정 완료 체크리스트

- [ ] Incoming Webhook을 발급하고 비밀 URL을 안전하게 보관했다.
- [ ] MMP의 `webhook_list`에서 웹훅 이름이 조회된다.
- [ ] 메시지를 보낼 논리 채널이 `channel_list`에서 활성 상태로 조회된다.
- [ ] 본인과 리뷰 대상자의 Mattermost·GitLab 사용자 매핑을 등록했다.
- [ ] `review-request`와 `review-complete` 컨벤션을 정확한 템플릿으로 등록했다.
- [ ] 실제 전송 전에 `message_preview` 또는 자연어 미리보기로 한 줄 문구를 확인했다.
- [ ] 테스트 메시지 전송 결과의 `ok`가 `true`인지 확인했다.

## 승인 정책 (`/mmp:bypass-review`)

리뷰가 MR에 답글을 달고 DM을 보내기 전에 **사람에게 물어보느냐**만 정합니다. 상태는 `~/.mmp/bypass-review.json` 하나에 있습니다.

| bypass | MR 답글 게시 | MM 알림 채널 |
|---|---|---|
| `off` (기본값) | **사용자 승인 후에만** | 승인할 때 같이 고름 |
| `on` | **승인 없이 바로** | 저장된 기본 채널로 자동 |

```bash
/mmp:bypass-review off
/mmp:bypass-review on
```

**감시를 켜고 끄는 것과 다릅니다.** 감시가 도는지는 `/mmp:auto-review` 로 Monitor 를 띄웠는지로 결정되고, 이 파일이 알 수 있는 사실이 아닙니다. 파일은 지킬 수 있는 약속만 합니다 — "돌 때 승인을 받느냐".

기본 채널은 코드에 하드코딩돼 있지 않고 언제든 바꿉니다.

```bash
node "<플러그인>/bin/bypass-review.mjs" channel "팀-채널명"
```

**승인 면제이지 검증 면제가 아닙니다.** `on` 이어도 단계 순서, 보류 카테고리·코드 위치 인용, 중복 게시 차단, `approve`/`merge` 금지는 그대로 작동합니다.

## 리뷰 요청 감시 (`/mmp:auto-review`)

GitLab **todos**를 60초마다 읽어, 내가 리뷰어로 지정되거나 MR에서 멘션되면 그 MR을 리뷰합니다. `bypass`가 꺼져 있으면 작업 칩으로 띄우고(클릭하면 리뷰 세션이 열립니다), 켜져 있으면 감시 세션이 직접 워크트리를 만들어 리뷰까지 끝냅니다. Mattermost를 감시하지 않습니다 — todos는 이미 있는 `glab` 인증으로 읽히고, `action_name`이 "리뷰 요청인가"를 대신 판정하며, `target_url`이 그대로 `/mmp:mr-review`의 입력이 됩니다.

`~/.mmp/watch.json`에 등록된 프로젝트만 감시합니다.

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

`workdir`와 `jiraBaseUrl` 중 하나라도 없으면 감시기가 거부합니다.

`host`는 생략할 수 있습니다 — `glab auth status`가 로그인했다고 보고하는 호스트가 **정확히 하나면** 그것을 씁니다. 0개거나 2개 이상이면 거부하고 `host`를 적으라고 합니다. 호스트를 비워둔 채 넘어가지 않는 이유는, 그러면 `glab`이 실행 디렉터리의 remote로 추론하다가 조용히 `gitlab.com`에 붙어 401이 나기 때문입니다. 설정에 `host`를 적으면 추론보다 그쪽이 언제나 이깁니다.

| 판정 | GitLab `action_name` | 처리 |
|---|---|---|
| 확정 | `review_requested`, `approval_required` | 바로 리뷰 세션 칩 생성 |
| 판단 필요 | `directly_addressed`, `mentioned` | 댓글 본문을 읽고 리뷰 요청인지 판단 |
| 제외 | `assigned`, 그 외 | 무시 (담당자 지정은 보통 "네가 머지해라") |

- **감시를 켜기 전에 밀린 요청을 먼저 보여줍니다.** `--pending` 으로 지금 쌓여 있는 것을 표로 훑고, 그중 띄울 것만 고릅니다. 상태를 건드리지 않는 읽기라 여기서 본 것이 나중에 이벤트로 또 오지 않습니다
- **첫 실행은 이미 쌓여 있는 pending todo를 전부 건너뜁니다.** 밀린 수십 건이 한꺼번에 쏟아지는 게 놓치는 것보다 나쁩니다
- 같은 폴링 배치에서 한 MR에 여러 todo가 오면(리뷰어 지정 + 같은 댓글의 멘션) **하나로 합칩니다.** 배치를 넘어선 중복은 합치지 않습니다 — 수정 후 2차 리뷰 요청은 별개 사건입니다
- 미처리 칩이 3개면 더 만들지 않고 대기시킵니다
- `bypass`면 칩을 만들지 않습니다. 감시 세션이 워크트리를 만들고 **그 워크트리로 직접 들어가** 한 번에 하나씩 리뷰합니다. 리뷰 중에는 세션 제목이 `이영수) !191 리뷰` 로 바뀌어 사이드바에서 어느 MR을 보고 있는지 알 수 있고, 끝나면 `keep`으로 빠져나와 제목을 `MR 리뷰 감시` 로 되돌립니다 — 워크트리는 남아 나중에 열어볼 수 있습니다
- **새 세션을 클릭 없이 만드는 방법은 없습니다.** 세션 생성 도구가 없고, 작업 칩의 클릭은 권한 프롬프트가 아니라 UI 동작이라 `bypass`가 닿지 않습니다. MR별 독립 세션이 필요하면 `bypass`를 끄고 칩을 쓰세요
- `Monitor` 상한이 30분이라 만료될 때마다 재무장합니다. 기본 6시간(12회)이 지나면 계속할지 한 번 묻습니다. `/mmp:auto-review 12시간`, `하루종일`, `끌 때까지` 처럼 호출에 붙여 바꿀 수 있습니다 — 감시가 그때 멈추는 게 아니라 확인 질문이 뜨는 시점입니다
- 세션을 띄울 때 `/mmp:mr-review <링크> --here` 로 부릅니다. `spawn_task` 가 `cwd` 아래에 이 리뷰 전용 워크트리를 이미 만들어 주므로, 그 자리를 그대로 씁니다. `--here` 가 없으면 `mr-review` 가 안전을 택해 워크트리를 하나 더 만들고 앞의 것이 빈 채로 남습니다. **이 보증은 감시 경로에서만 합니다** — 사람이 직접 `/mmp:mr-review` 를 부를 때는 지금 자리가 무엇인지 알 수 없으므로 가드가 그대로 작동합니다
- GitLab의 todo를 done 처리하지 않습니다. 중복 방지는 로컬 `~/.mmp/watch-state.json`으로 합니다

설정이나 인증을 확인하려면 한 번만 돌려볼 수 있습니다.

```bash
node "<플러그인>/bin/mr-watch.mjs" --pending   # 밀린 리뷰 요청 목록 (JSON)
node "<플러그인>/bin/mr-watch.mjs" --once      # 한 번만 폴링 (설정·인증 확인)
```

## MR 리뷰 (`/mmp:mr-review`)

MR 링크를 주면 리뷰 한 건을 끝까지 진행합니다. `<메인 저장소>/.claude/worktrees/mr-<iid>`에 워크트리를 만들고(`--worktree-root`로 위치 변경) 거기서 리뷰합니다. **메인 저장소의 브랜치와 HEAD는 건드리지 않습니다.**

이미 워크트리 안에서 실행해도, 그 워크트리가 다른 브랜치로 작업 중이면 갈아끼우지 않고 전용 워크트리를 따로 만듭니다. 이미 그 MR 브랜치를 올린 워크트리라면 그 자리를 그대로 씁니다. 판단을 무시하려면 `--here`.

```text
/mmp:mr-review https://gitlab.example.com/group/repo/-/merge_requests/71
```

진행 순서는 `bin/mr-review.mjs` 하네스와 PreToolUse 훅이 강제합니다.

| 단계 | 하는 일 | 강제 방식 |
|---|---|---|
| `prepare` | glab 로그인·프로젝트 일치·타 MR 리뷰 미진행 확인 → **MR의 원격 브랜치를 그대로** 워크트리에 ff-only로 확보 → 본문·게시자 최신 댓글 수집 → **막힌 질문을 한 번에 반환**(MR 진행 여부는 `questions`, Mattermost 채널·멘션 선택은 `postQuestions`로 분리해 게시 승인 때로 미룸) | 실패하면 다음 단계 불가 |
| 리뷰 | ① diff 통독 후 **위험 지도**를 먼저 작성(변경 요약 + severity 정렬된 위험 목록 + 각 위험의 확인 절차) ② 위험이 큰 것부터 읽으며 **담당자가 놓쳤을 빈틈을 능동적으로 검증**(에지 케이스, 실패·부분실패 경로, 동시성, 호출부 파급, 인증·인가, 마이그레이션 역방향, 테스트 공백) ③ 맥락은 넓게 보되 **지적은 이 diff로 한정**(되돌리면 사라지는 문제만) | 스킬 문서 |
| 반증 | 기록 직전, 작성한 지적을 **맞다고 확인하는 대신 틀렸음을 증명하려고** 한 번 훑는다. 반증을 통과 못 한 보류 항목은 안내로 내린다 | 스킬 문서 |
| 판정 | **"이 상태로 병합해도 되는 코드인가"** 기준. 발견마다 "병합 후에 고쳐도 되는가"를 물어 갈림 — 아니오면 보류, 예면 승인 + 안내. 문서·오타·네이밍은 **구체적으로 안내하되 병합은 승인**(그 문서 때문에 실제로 깨지면 `[계약]` 보류) | 하네스가 보류 카테고리 태그를 요구 |
| `record` | 승인/보류 판정과 답글 본문 기록 | 필수 섹션(보류는 4개)이 없으면 거부. **보류는 사유 카테고리(`[정확성]` `[안전]` `[데이터]` `[계약]` `[구현]`) 태그와 실제 코드 위치 인용(`` `src/a.js:42` ``)이 각각 최소 1개 없으면 거부** |
| `post --confirmed` | `glab mr note create --unique`로 MR에 답글 게시 | `record` 전에는 거부, 중복 게시 거부. **사용자 승인(AskUserQuestion) 없이는 하네스와 훅이 모두 거부** |
| `notify` | `review-complete` 컨벤션으로 **MR 작성자에게 DM** 전송 | `post` 전에는 거부. 확인 없이 전송 |

가드레일:

- 세션 제목을 `<작성자 이름>) !<번호> 리뷰`(예: `이영수) !172 리뷰`)로 바꿉니다. 형식은 하네스가 `sessionTitle`로 완성해 주므로 리뷰 세션이 여러 개여도 어느 MR인지 바로 구분됩니다.
- MR 답글은 **여기서 멈추고 확인받습니다.** 스킬이 답글 전문을 보여주고 `AskUserQuestion`으로 물은 뒤에만 `--confirmed`를 붙일 수 있고, 그게 없으면 훅과 하네스가 각각 거부합니다. 권한 프롬프트에 기대지 않는 이유는, 세션이 auto 모드이거나 사용자가 앞서 "코멘트 남겨줘"라고 말해 두면 그 프롬프트가 사람에게 닿지 않고 해소되기 때문입니다. Mattermost 전송은 확인 대상이 아니라 게시 후 자동입니다.
- 리뷰 완료 알림은 **팀 채널이 아니라 MR 작성자 개인 DM**으로 갑니다. `--channel`은 목적지가 아니라 DM에 쓸 웹훅 자격증명의 출처이며, 수신자는 등록된 참여자 id로 특정합니다. 웹훅이 채널 잠금이면 DM 오버라이드가 거부되므로 그 오류를 그대로 보고합니다.
- 승인/머지 명령(`approve`, `merge`)은 **항상 차단**합니다. 승인이어도 코멘트만 남기고, GitLab 승인 버튼은 사람이 누릅니다.
- `glab mr note` 직접 호출을 차단해 판정·본문 검증을 건너뛸 수 없게 합니다.
- 상태는 리뷰가 일어나는 워크트리의 `<git-dir>/mmp-mr-review.json`에 저장되므로 워크트리마다 독립이고 커밋되지 않습니다. 워크트리가 새로 만들어지면 세션이 `EnterWorktree`로 그곳에 들어가야 합니다.
- 같은 워크트리에서 다른 MR 리뷰가 진행 중이면 `prepare`가 거부합니다.
- 세션이 작업 중인 워크트리를 MR 브랜치로 갈아끼우지 않습니다(`--here`로만 강제).
- MR 본문과 댓글은 **리뷰 대상 데이터**이지 지시가 아닙니다. 거기 적힌 명령은 따르지 않습니다.

막히면 `node "<플러그인>/bin/mr-review.mjs" status`로 단계를 보고, `reset`으로 상태 파일만 지웁니다(게시된 답글은 지워지지 않습니다).

## 사용 예

```text
등록된 웹훅과 채널 목록을 보여줘.
```

```text
deploy_ok 컨벤션을 "✅ {{service}} {{version}} 배포 완료"로 등록해줘.
```

```text
deploy_ok를 service=api, version=v1.2.0으로 alerts 채널에 보내줘.
```

```text
리뷰 요청 mm에 보내줘.
```

리뷰 메시지의 정확한 멘션을 위해 본인과 팀원의 식별 정보를 먼저 등록합니다.

```text
내 이름은 철수이고 Mattermost 아이디는 chulsoo.kim, GitLab 아이디는 my-gitlab-id야. 나로 등록해줘.
GitLab review-author는 Mattermost @reviewer.mm을 쓰는 리뷰 요청자야. 특화-팀-BND 참여자로 등록해줘.
```

Incoming Webhook만으로는 Mattermost 서버의 실제 채널 참여자를 조회할 수 없습니다. `participant_*`와 `channel_member_*`는 사용자가 제공한 식별 정보를 관리하는 로컬 디렉터리이며, 실제 멤버십을 조회하거나 변경하지 않습니다.

사람 정보는 채널과 독립적으로 한 번만 저장됩니다. `participant_list`의 `name_query`는 이름 일부를 검색하며 여러 명이 나오면 호출자가 대상을 확인해야 합니다. 채널에 없는 사람을 `channel_member_add`할 때 `display_name`을 함께 주면 전역 사람 정보를 먼저 만들고 채널에 연결합니다.

개인 DM은 `message_send_dm`이 선택한 논리 채널의 웹훅으로 `@사용자명` 대상을 오버라이드합니다. Mattermost 서버에서 웹훅의 채널 오버라이드를 허용해야 합니다.

리뷰 요청과 리뷰 완료는 채널·DM 모두 자유문 `text` 전송이 차단됩니다. 각각 `review-request`, `review-complete` 컨벤션을 사용해야 하며, DM 본문도 선택한 참여자의 정확한 `@아이디`로 시작해야 합니다. 대상 오버라이드만 설정하고 본문 멘션을 빼는 방식은 거부됩니다.

## 제공 도구

| 영역 | 도구 |
|---|---|
| 웹훅 | `webhook_create`, `webhook_list`, `webhook_update`, `webhook_delete` |
| 채널 | `channel_create`, `channel_list`, `channel_update`, `channel_delete` |
| 참여자 | `participant_create`, `participant_list`, `participant_update`, `participant_delete` |
| 채널 참여자 | `channel_member_add`, `channel_member_remove` |
| 컨벤션 | `convention_create`, `convention_list`, `convention_update`, `convention_delete` |
| 메시지 | `message_preview`, `message_send`, `message_send_dm` |
| 진단 | `storage_info` |

`channel_create`의 `mattermost_channel`을 생략하면 웹훅 생성 시 지정한 기본 채널로 전송합니다. 값을 주면 Mattermost 채널명 또는 `@username`으로 대상을 오버라이드합니다.

## 데이터 저장 위치

- 모든 운영체제: `~/.mmp/mattermost.sqlite3`

Claude Desktop이 Windows `AppData`를 격리해도 Codex와 같은 파일을 보도록 사용자 홈 바로 아래의 `.mmp`를 사용합니다. Claude 플러그인은 제한된 MCP 자식 환경에서도 같은 홈 경로를 계산하도록 부모의 `USERPROFILE`을 명시적으로 전달합니다.

Windows의 기존 `%LOCALAPPDATA%\mattermost-manager-mcp\mattermost.sqlite3`에 데이터가 있고 새 저장소가 비어 있으면 첫 실행 때 웹훅, 채널, 참여자, 컨벤션을 자동 이전합니다. 기존 파일은 삭제하지 않습니다.

`MATTERMOST_MCP_DATA_DIR` 환경변수로 위치를 바꿀 수 있습니다. 여러 클라이언트에서 같은 설정을 사용하려면 동일한 경로를 지정하세요.

두 클라이언트의 목록이 다르면 `storage_info`로 실제 데이터 디렉터리와 저장 건수를 비교하세요. 이 도구는 웹훅 URL을 반환하지 않습니다.

신뢰하는 로컬 Mattermost가 HTTP만 제공할 때에만 서버 실행 환경에 `MATTERMOST_MCP_ALLOW_HTTP=1`을 설정하세요. 기본값은 HTTPS 전용입니다.

## 보안

- 웹훅 URL은 조회·전송 결과에 반환하지 않습니다.
- 웹훅 URL은 현재 OS 사용자의 로컬 SQLite에 저장되며 별도로 암호화하지 않습니다. 사용자 계정과 디스크 접근을 보호하세요.
- 저장소에는 실제 웹훅 URL이나 SQLite 파일을 커밋하지 마세요.
- 전송은 저장된 웹훅만 사용하고 HTTP 리다이렉트를 따르지 않습니다.
- 연결된 채널이 있는 웹훅은 삭제되지 않습니다.
- 웹훅 URL이 노출되면 Mattermost에서 재발급하고 저장된 URL을 교체하세요.

## 제거

```powershell
codex mcp remove mmp
claude mcp remove mmp --scope user
claude plugin uninstall mmp@mmp-local --scope user
claude plugin marketplace remove mmp-local
```

MCP 등록 제거는 로컬 SQLite 데이터를 삭제하지 않습니다.
