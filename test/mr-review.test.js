import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { HOLD_CATEGORIES, citedLocations, collectAuthorNotes, gateDecision, missingSections, mmQuestions, parseMrUrl, sessionTitleFor, syncMrWorktree, usedHoldCategories } from "../bin/mr-review.mjs";

const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
const at = (step, extra = {}) => () => ({ step, iid: 71, project: "group/repo", verdict: "hold", body: "본문", ...extra });
const none = () => null;

test("MR 링크에서 프로젝트와 번호를 뽑는다", () => {
  assert.deepEqual(parseMrUrl("https://gitlab.example.com/group/repo/-/merge_requests/71"), {
    host: "gitlab.example.com", project: "group/repo", iid: 71,
  });
  assert.equal(parseMrUrl("https://gitlab.example.com/group/sub/repo/-/merge_requests/8/").project, "group/sub/repo");
});

test("MR 링크가 아니면 거부한다", () => {
  for (const bad of ["!71", "71", "", "https://gitlab.example.com/group/repo/-/issues/71", "https://gitlab.example.com/group/repo"]) {
    assert.throws(() => parseMrUrl(bad), /MR 링크/);
  }
});

test("세션 제목은 '<작성자 이름>) !<번호> 리뷰' 형식이다", () => {
  assert.equal(sessionTitleFor({ authorName: "박영희", iid: 173 }), "박영희) !173 리뷰");
  assert.equal(sessionTitleFor({ authorName: "이영수", iid: 172 }), "이영수) !172 리뷰");
  // author.name이 비어 있어도 제목이 깨지지 않는다
  assert.equal(sessionTitleFor({ authorName: null, iid: 9 }), "작성자 불명) !9 리뷰");
});

// MM 선택은 리뷰 시작 전이 아니라 게시 승인 때 한 번에 묻는다.
test("Mattermost 질문은 필요한 것만 모아 게시 시점용으로 낸다", () => {
  const ready = mmQuestions({ authorGitlab: "youngsoo.lee", mention: "@lee", channels: ["팀채널"], hasConvention: true });
  assert.deepEqual(ready, [], "다 갖춰져 있으면 물을 게 없다");

  const ids = (args) => mmQuestions(args).map((q) => q.id);
  assert.deepEqual(ids({ authorGitlab: "youngsoo.lee", mention: null, channels: ["a", "b"], hasConvention: true }),
    ["mm_participant", "mm_channel_pick"]);
  assert.deepEqual(ids({ authorGitlab: "youngsoo.lee", mention: "@x", channels: [], hasConvention: false }),
    ["mm_convention", "mm_channel"]);

  // 채널이 여러 개면 선택지를 같이 준다
  const pick = mmQuestions({ mention: "@x", channels: ["팀채널", "나에게"], hasConvention: true })[0];
  assert.deepEqual(pick.options, ["팀채널", "나에게"]);

  // 설정을 아예 못 읽으면 나머지를 물을 근거가 없다
  assert.deepEqual(ids({ storageError: "db locked", mention: null, channels: [] }), ["mm_storage"]);
});

test("보류 본문은 네 섹션이 모두 있어야 통과한다", () => {
  const partial = "## 리뷰 결과: 보류\n### 왜 보류인가\n터집니다.";
  assert.deepEqual(missingSections("hold", partial), ["### 수정이 필요한 부분", "### 확인한 범위"]);

  const full = `## 리뷰 결과: 보류
### 왜 보류인가
빈 배열에서 터집니다.
### 수정이 필요한 부분
1. \`src/a.js:42\` — 길이 검사가 없습니다.
### 확인한 범위
src/a.js`;
  assert.deepEqual(missingSections("hold", full), []);
});

// "병합 후에 고쳐도 되는가"로 갈린다. 분류 안 되는 지적은 병합을 막을 수 없다.
test("보류는 사유 카테고리가 붙어야 성립한다", () => {
  const docOnly = `## 리뷰 결과: 보류
### 왜 보류인가
README 오타가 있습니다.
### 수정이 필요한 부분
1. \`docs/README.md:3\` — 오타
### 확인한 범위
docs/README.md`;
  assert.deepEqual(usedHoldCategories(docOnly), [], "문서 오타만으로는 보류 카테고리가 안 붙는다");

  const real = docOnly.replace("1. `docs/README.md:3` — 오타", "1. `[정확성]` `src/a.js:42` — 빈 배열에서 터짐");
  assert.deepEqual(usedHoldCategories(real), ["[정확성]"]);

  const many = "`[안전]` 인가 누락 / `[데이터]` 마이그레이션 비가역";
  assert.deepEqual(usedHoldCategories(many), ["[안전]", "[데이터]"]);

  // 카테고리 목록 자체가 흔들리면 스킬 문서와 어긋난다
  assert.deepEqual(HOLD_CATEGORIES, ["[정확성]", "[안전]", "[데이터]", "[계약]", "[구현]"]);
});

// 위치를 못 대는 보류는 확인이 아니라 추측이다.
test("보류 항목은 실제 코드 위치를 인용해야 한다", () => {
  assert.deepEqual(citedLocations("`src/auth/session.js:42` 에서 터집니다"), ["src/auth/session.js:42"]);
  assert.deepEqual(citedLocations("`package.json` 의존성 누락"), ["package.json"]);
  assert.deepEqual(citedLocations("여러 곳: `a/b.ts:9` 와 `c.py`"), ["a/b.ts:9", "c.py"]);

  // 위치 없는 일반론은 인용으로 치지 않는다
  assert.deepEqual(citedLocations("빈 배열에서 터질 수 있습니다"), []);
  assert.deepEqual(citedLocations("`npm test` 를 돌려보세요"), [], "명령어는 코드 위치가 아니다");
});

test("승인 본문은 결과와 확인 범위만 요구한다", () => {
  assert.deepEqual(missingSections("approve", "## 리뷰 결과: 승인\n### 확인한 범위\nsrc/a.js"), []);
  assert.deepEqual(missingSections("approve", "## 리뷰 결과: 승인"), ["### 확인한 범위"]);
  assert.throws(() => missingSections("maybe", "x"), /approve 또는 hold/);
});

test("승인과 머지는 상태와 무관하게 막는다", () => {
  for (const command of ["glab mr approve 71", "glab mr merge 71 -R group/repo"]) {
    for (const state of [none, at("prepared"), at("notified")]) {
      assert.equal(gateDecision(bash(command), state)?.permissionDecision, "deny", command);
    }
  }
  // 복합 명령으로 우회하지 못한다
  assert.equal(gateDecision(bash("cd /repo && glab mr approve 71"), none)?.permissionDecision, "deny");
});

// 게이트의 목적은 "리뷰 세션이 하네스를 우회하지 못하게"다. 리뷰 중이 아니면 우회할 하네스가 없다.
// 작성자가 자기 MR에 리뷰 요청 댓글을 다는 것까지 막으면 그건 오탐이고, 실제로 사용자를 막았다.
test("직접 코멘트는 리뷰가 진행 중일 때만 막는다", () => {
  const comments = [
    "glab mr note create 71 -m hi",
    "glab mr note 71 -m hi", // 서브커맨드 없는 기본형도 코멘트를 만든다
    "glab mr note delete 5 71",
  ];
  for (const command of comments) {
    assert.equal(gateDecision(bash(command), at("prepared"))?.permissionDecision, "deny", command);
    assert.equal(gateDecision(bash(command), none), null, `리뷰 중이 아니면 통과: ${command}`);
  }
  // 막을 때는 빠져나갈 길을 알려준다
  assert.match(gateDecision(bash(comments[0]), at("reviewed")).permissionDecisionReason, /reset/);
  // 읽기 전용 조회는 리뷰 중에도 막지 않는다
  assert.equal(gateDecision(bash("glab mr note list 71 -R group/repo -F json"), at("prepared")), null);
});

// 앵커가 없으면 문서를 쓰거나 예시를 출력하는 명령까지 막혀 실사용을 방해한다.
test("명령이 아니라 문자열로 언급된 것은 막지 않는다", () => {
  for (const command of [
    `echo "glab mr approve 71 은 차단됩니다"`,
    `node -e 'console.log("glab mr note create 9")'`,
    `grep -n 'glab mr merge' README.md`,
    `echo "node bin/mr-review.mjs post 로 게시합니다"`,
    `node -e 'console.log("mr-review.mjs post")'`,
  ]) {
    assert.equal(gateDecision(bash(command), at("reviewed")), null, command);
  }
  // 앵커를 넣어도 실제 호출은 여전히 잡힌다
  assert.equal(gateDecision(bash("glab mr approve 71"), none).permissionDecision, "deny");
  assert.equal(gateDecision(bash("cd /repo && glab mr approve 71"), none).permissionDecision, "deny");
  assert.equal(gateDecision(bash("echo start; glab mr note create 9 -m hi"), at("prepared")).permissionDecision, "deny");
});

test("게이트는 순서를 강제한다", () => {
  const post = bash('node "/plugins/mmp/bin/mr-review.mjs" post');
  const confirmed = bash('node "/plugins/mmp/bin/mr-review.mjs" post --confirmed');
  assert.match(gateDecision(post, none).permissionDecisionReason, /prepare/);
  assert.match(gateDecision(post, at("prepared")).permissionDecisionReason, /record/);
  assert.equal(gateDecision(confirmed, at("reviewed")).permissionDecision, "allow");
  assert.equal(gateDecision(confirmed, at("posted")).permissionDecision, "deny", "중복 게시는 막는다");

  const notify = bash("node bin/mr-review.mjs notify --channel team");
  assert.equal(gateDecision(notify, at("reviewed")).permissionDecision, "deny");
  assert.equal(gateDecision(notify, at("posted")).permissionDecision, "allow", "게시 후 DM은 묻지 않고 통과한다");
});

// 권한 프롬프트(ask)는 auto 모드에서 사람에게 닿지 않을 수 있다.
// 그래서 승인 증거가 없으면 ask가 아니라 deny — deny는 세션 모드와 무관하게 확정적이다.
test("사용자 승인 없이 게시하려 하면 확정적으로 deny한다", () => {
  const withoutConfirm = gateDecision(bash("node bin/mr-review.mjs post"), at("reviewed"), () => "on");
  assert.equal(withoutConfirm.permissionDecision, "deny");
  assert.match(withoutConfirm.permissionDecisionReason, /AskUserQuestion/);
});

// bypass 동안은 사용자가 "전부 무승인"을 명시적으로 켠 상태다. 게이트가 막지 않는다.
test("auto-review bypass면 승인 없이도 게시를 통과시킨다", () => {
  const post = bash("node bin/mr-review.mjs post");
  assert.equal(gateDecision(post, at("reviewed"), () => "bypass").permissionDecision, "allow");
  // 순서 위반은 bypass여도 그대로 막는다 — 승인 면제이지 검증 면제가 아니다
  assert.equal(gateDecision(post, at("prepared"), () => "bypass").permissionDecision, "deny");
  assert.equal(gateDecision(post, at("posted"), () => "bypass").permissionDecision, "deny");
});

// 확인은 AskUserQuestion 한 번으로 끝난다. 승인 직후 권한 프롬프트를 또 띄우지 않는다.
test("검증을 통과한 하네스 단계는 자동 승인한다", () => {
  const allowed = (command, state) => gateDecision(bash(`node /p/mr-review.mjs ${command}`), state)?.permissionDecision;
  assert.equal(allowed("post --confirmed", at("reviewed")), "allow");
  assert.equal(allowed("notify --channel team", at("posted")), "allow");
  assert.equal(allowed("prepare https://gitlab.example.com/g/r/-/merge_requests/1", none), "allow", "prepare는 상태 없이도 통과");
  assert.equal(allowed("record hold body.md", at("prepared")), "allow");
  assert.equal(allowed("status", none), "allow");

  // 자동 승인은 우리 하네스라고 확신할 때만. 별칭 경로는 거부만 하고 승인하지 않는다.
  assert.equal(gateDecision(bash('node "$HARNESS" post --confirmed'), at("reviewed")), null);
});

test("셸 변수로 우회해도 리뷰 진행 중이면 게이트가 잡는다", () => {
  const aliased = bash('node "$HARNESS" post --confirmed');
  assert.equal(gateDecision(aliased, at("prepared")).permissionDecision, "deny", "별칭으로도 순서 위반은 잡는다");
  assert.equal(gateDecision(aliased, at("reviewed")), null, "확신 없는 경로는 자동 승인하지 않는다");
  assert.equal(gateDecision(aliased, none), null, "리뷰 중이 아니면 무관한 node 명령에 간섭하지 않는다");
});

test("게이트는 워크플로 밖의 호출에 간섭하지 않는다", () => {
  assert.equal(gateDecision(bash("npm test"), at("prepared")), null);
  assert.equal(gateDecision(bash("glab mr list -R group/repo"), at("prepared")), null);
  assert.equal(gateDecision({ tool_name: "Read", tool_input: { file_path: "a.js" } }, at("reviewed")), null);
  assert.equal(gateDecision({}, none), null);
});

test("게시자 댓글만 시간순으로 모은다", () => {
  const discussions = [
    { notes: [{ author: { username: "gildong" }, created_at: "2026-09-02T00:00:00Z", body: "두번째" }] },
    { notes: [
      { author: { username: "reviewer" }, created_at: "2026-09-03T00:00:00Z", body: "남의 댓글" },
      { author: { username: "gildong" }, created_at: "2026-09-01T00:00:00Z", body: "첫번째" },
      { author: { username: "gildong" }, created_at: "2026-09-04T00:00:00Z", body: "시스템", system: true },
    ] },
  ];
  assert.deepEqual(collectAuthorNotes(discussions, "gildong").map((note) => note.body), ["첫번째", "두번째"]);
  assert.deepEqual(collectAuthorNotes(discussions, null), []);
  assert.deepEqual(collectAuthorNotes(null, "gildong"), []);
});

// 회귀: `glab mr view --comments -F json`은 배열이 아니라 MR 객체를 주고, 댓글은 대문자 Discussions에 있다.
// 배열만 받던 이전 구현은 여기서 항상 []를 돌려줘 "게시자 댓글 없음"으로 잘못 보고했다.
test("MR 객체의 Discussions에서 게시자 댓글을 찾는다", () => {
  const mr = {
    author: { username: "youngsoo.lee", name: "이영수" },
    user_notes_count: 5,
    Discussions: [
      { id: "d1", individual_note: true, notes: [
        { author: { username: "youngsoo.lee" }, system: true, created_at: "2026-09-01T00:00:00Z", body: "assigned to @x" },
      ] },
      { id: "d2", notes: [
        { author: { username: "chulsoo.kim" }, system: false, created_at: "2026-09-02T00:00:00Z", body: "리뷰어 지적" },
      ] },
      { id: "d3", notes: [
        { author: { username: "youngsoo.lee" }, system: false, created_at: "2026-09-04T00:00:00Z", body: "게시자 최신 답변" },
        { author: { username: "youngsoo.lee" }, system: false, created_at: "2026-09-03T00:00:00Z", body: "게시자 먼저 쓴 말" },
      ] },
    ],
  };
  assert.deepEqual(
    collectAuthorNotes(mr, "youngsoo.lee").map((note) => note.body),
    ["게시자 먼저 쓴 말", "게시자 최신 답변"],
    "시스템 노트와 남의 댓글은 빼고, 게시자 댓글만 시간순으로",
  );
  assert.equal(collectAuthorNotes(mr, "chulsoo.kim").length, 1);
  assert.deepEqual(collectAuthorNotes({ author: { username: "youngsoo.lee" } }, "youngsoo.lee"), [], "Discussions가 없으면 빈 배열");
});

test("MR의 원격 브랜치를 워크트리로 가져오고 현재 작업 트리는 건드리지 않는다", () => {
  const root = mkdtempSync(join(tmpdir(), "mmp-worktree-"));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const origin = join(root, "origin.git");
    const author = join(root, "author");
    const clone = join(root, "clone");
    const worktreeRoot = join(root, "wt");

    git(root, "init", "--bare", "-b", "main", origin);
    git(root, "clone", origin, author);
    writeFileSync(join(author, "a.txt"), "base\n");
    git(author, "add", "-A");
    git(author, "commit", "-m", "base");
    git(author, "push", "-u", "origin", "main");
    git(author, "checkout", "-b", "feat/login");
    writeFileSync(join(author, "a.txt"), "mr work\n");
    git(author, "commit", "-am", "mr work");
    git(author, "push", "-u", "origin", "feat/login");

    git(root, "clone", origin, clone);
    const cloneHeadBefore = git(clone, "rev-parse", "HEAD");

    const first = syncMrWorktree({ cwd: clone, remote: "origin", iid: 172, sourceBranch: "feat/login", worktreeRoot });

    assert.equal(first.createdWorktree, true);
    assert.equal(first.forked, false);
    assert.equal(first.branch, "feat/login", "합성 mr-<iid> 브랜치가 아니라 원격 브랜치를 그대로 써야 한다");
    assert.equal(resolve(first.path), resolve(join(worktreeRoot, "mr-172")));
    assert.equal(readFileSync(join(first.path, "a.txt"), "utf8").trim(), "mr work");
    assert.equal(git(clone, "rev-parse", "HEAD"), cloneHeadBefore, "현재 작업 트리의 HEAD는 그대로여야 한다");
    assert.equal(git(clone, "rev-parse", "--abbrev-ref", "HEAD"), "main", "현재 작업 트리의 브랜치도 그대로여야 한다");

    // 저자가 MR에 커밋을 더 밀면 ff-only로 따라간다.
    writeFileSync(join(author, "a.txt"), "mr work v2\n");
    git(author, "commit", "-am", "more");
    git(author, "push");

    const second = syncMrWorktree({ cwd: clone, remote: "origin", iid: 172, sourceBranch: "feat/login", worktreeRoot });
    assert.equal(second.createdWorktree, false, "이미 있는 워크트리는 재사용한다");
    assert.equal(readFileSync(join(second.path, "a.txt"), "utf8").trim(), "mr work v2");

    // 이미 그 MR 브랜치를 올린 워크트리 안이면 새로 만들지 않고 그 자리를 쓴다.
    const inside = syncMrWorktree({ cwd: first.path, remote: "origin", iid: 172, sourceBranch: "feat/login", worktreeRoot });
    assert.equal(inside.createdWorktree, false);
    assert.equal(inside.reusedInPlace, true);
    assert.equal(resolve(inside.path), resolve(first.path));

    // 가드: 다른 브랜치로 작업 중인 워크트리는 갈아끼우지 않고 전용 워크트리를 따로 만든다.
    const task = join(root, "task-wt");
    git(clone, "worktree", "add", "-b", "claude/other-task", task, "main");
    const guarded = syncMrWorktree({ cwd: task, remote: "origin", iid: 172, sourceBranch: "feat/login", worktreeRoot });

    assert.equal(guarded.reusedInPlace, false, "남의 작업 워크트리를 재사용하면 안 된다");
    assert.notEqual(resolve(guarded.path), resolve(task));
    assert.equal(git(task, "rev-parse", "--abbrev-ref", "HEAD"), "claude/other-task", "그 워크트리의 브랜치는 그대로여야 한다");

    // --here 인데 그 브랜치를 이미 다른 워크트리가 쓰고 있으면, git 원문 대신 대안을 알려주고 멈춘다.
    assert.throws(
      () => syncMrWorktree({ cwd: task, remote: "origin", iid: 172, sourceBranch: "feat/login", worktreeRoot, here: true }),
      /이미 워크트리 .* 가 쓰고 있습니다/,
    );
    assert.equal(git(task, "rev-parse", "--abbrev-ref", "HEAD"), "claude/other-task", "실패해도 브랜치는 그대로");

    // 충돌이 없으면 --here 가 그 자리를 그대로 쓴다.
    git(clone, "worktree", "remove", "--force", first.path);
    const forced = syncMrWorktree({ cwd: task, remote: "origin", iid: 172, sourceBranch: "feat/login", worktreeRoot, here: true });
    assert.equal(forced.reusedInPlace, true);
    assert.equal(resolve(forced.path), resolve(task));
    assert.equal(git(task, "rev-parse", "--abbrev-ref", "HEAD"), "feat/login");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
