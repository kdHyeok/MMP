import assert from "node:assert/strict";
import test from "node:test";
import { autoApproveProblems, gateDecision, MANUAL_MERGE_GUIDANCE, verdictProblems } from "../bin/mr-review.mjs";
import { acknowledge, bindSession, claimSession, markSessionArchived, sessionForEvent, sessionStatus } from "../bin/mr-watch.mjs";

const sha = "a".repeat(40);
const review = () => ({ step: "posted", verdict: "approve", preparedSha: sha, reviewedSha: sha,
  body: "## 리뷰 결과: 승인\n추가 수정 사항 없습니다.\n### 확인한 범위\n전체 diff와 필수 검사 확인",
  verification: { sha, findings: [], unverified: [], checks: [{ name: "npm test", status: "passed", evidence: "54 passed" }] } });
const mr = () => ({ state: "opened", sha, diff_refs: { head_sha: sha }, draft: false, has_conflicts: false,
  detailed_merge_status: "mergeable", head_pipeline: { status: "success", sha } });

test("자동 Approve는 승인 가능한 리뷰·bypass·동일 SHA 검증과 CI 성공에만 허용한다", () => {
  assert.deepEqual(autoApproveProblems(review(), "bypass", mr()), []);
  assert.ok(autoApproveProblems(review(), "off", mr()).length);
  for (const change of [
    { step: "reviewed" }, { verdict: "hold" }, { verification: null }, { preparedSha: null }, { reviewedSha: "b".repeat(40) },
    { verification: { ...review().verification, sha: "b".repeat(40) } },
    { verification: { ...review().verification, findings: ["문서 오타"] } },
    { verification: { ...review().verification, unverified: ["브라우저 미확인"] } },
    { verification: { ...review().verification, checks: [] } },
    { verification: { ...review().verification, checks: [{ name: "test", status: "skipped", evidence: "환경 부족" }] } },
    { verification: { ...review().verification, checks: [{ name: "test", status: "passed", evidence: "" }] } },
  ]) assert.ok(autoApproveProblems({ ...review(), ...change }, "bypass", mr()).length, JSON.stringify(change));
  for (const extra of ["\n[낮음] 문서 오타", "\n[확인 필요] 테스트", "\n### 고치면 좋을 것\n오타 수정",
    "\n### 수정이 필요한 부분\n링크 수정", "\n### 확인하지 못한 것\n배포"]) {
    assert.ok(autoApproveProblems({ ...review(), body: review().body + extra }, "bypass", mr()).length);
  }
  for (const change of [{ state: "merged" }, { state: "closed" }, { draft: true }, { work_in_progress: true },
    { has_conflicts: true }, { has_conflicts: undefined }, { sha: "b".repeat(40) }, { diff_refs: null },
    { detailed_merge_status: "checking" }, { detailed_merge_status: "approvals_syncing" }, { detailed_merge_status: undefined },
    { detailed_merge_status: "status_checks_must_pass" }, { detailed_merge_status: "discussions_not_resolved" },
    { head_pipeline: null }, { head_pipeline: { status: "running", sha } },
    { head_pipeline: { status: "failed", sha } }, { head_pipeline: { status: "success", sha: "b".repeat(40) } }]) {
    assert.ok(autoApproveProblems(review(), "bypass", { ...mr(), ...change }).length, JSON.stringify(change));
  }
  assert.ok(autoApproveProblems(null, "bypass", null).length);
});

test("비차단 보완 의견은 문서 유형·댓글·검증 기록과 수동 병합 안내가 일치하면 자동 Approve한다", () => {
  const suggestion = (kind = "general", severity = "medium") => ({ ...review(), title: "fix(api): 응답 정리",
    body: `## 리뷰 결과: 승인\n병합 차단 사유 없음\n### 고치면 좋을 것 (병합은 막지 않음)\n1. [${severity === "medium" ? "중간" : "낮음"}] \`docs/README.md:3\` — 예시 문구 정리\n   - 예시의 변수 이름을 통일해 주세요.\n### 병합 안내\n${MANUAL_MERGE_GUIDANCE}\n### 확인한 범위\n전체 diff와 검사`,
    verification: { ...review().verification, reviewKind: kind,
      findings: [{ severity, blocking: false, summary: "예시 문구 정리" }] } });
  for (const state of [suggestion(), suggestion("general", "low"), suggestion("documentation", "low")]) {
    assert.deepEqual(autoApproveProblems(state, "bypass", mr()), []);
    assert.deepEqual(autoApproveProblems(state, "bypass", { ...mr(), head_pipeline: null }, []), []);
    assert.ok(autoApproveProblems(state, "off", mr()).length);
  }
  assert.deepEqual(autoApproveProblems(suggestion("documentation", "low"), "bypass", { ...mr(), title: "docs(docs): 표현 통일" }), []);
  const state = suggestion();
  const multiple = { ...state, body: state.body.replace("### 병합 안내", "2. [낮음] `src/a.js:5` — 변수 이름 통일\n### 병합 안내"),
    verification: { ...state.verification, findings: [...state.verification.findings, { severity: "low", blocking: false, summary: "변수 이름 통일" }] } };
  assert.deepEqual(autoApproveProblems(multiple, "bypass", mr()), []);
  assert.ok(autoApproveProblems({ ...multiple, verification: { ...multiple.verification,
    findings: [...multiple.verification.findings].reverse() } }, "bypass", mr()).length, "여러 의견도 순서를 대조한다");
  for (const change of [
    { body: state.body.replace(MANUAL_MERGE_GUIDANCE, "병합 가능") },
    { body: state.body.replace("### 병합 안내", "### 다른 제목") },
    { body: state.body.replace("[중간]", "[높음]") },
    { body: state.body.replace("[중간]", "[낮음]") },
    { body: state.body.replace("`docs/README.md:3`", "위치 없음") },
    { body: state.body.replace("예시 문구 정리", "다른 의견") },
    { body: state.body.replace("### 고치면 좋을 것", "### 다른 내용") },
    { body: state.body + "\n[낮음] 기록에서 빠진 의견" },
    { verification: { ...state.verification, reviewKind: undefined } },
    { verification: { ...state.verification, reviewKind: "unknown" } },
    { verification: { ...state.verification, findings: [] } },
    { verification: { ...state.verification, findings: [null] } },
    { verification: { ...state.verification, findings: ["예시 문구 정리"] } },
    ...[{ blocking: true }, { blocking: "false" }, { blocking: undefined }, { severity: "high" }, { summary: "" }]
      .map((finding) => ({ verification: { ...state.verification, findings: [{ ...state.verification.findings[0], ...finding }] } })),
  ]) assert.ok(autoApproveProblems({ ...state, ...change }, "bypass", mr()).length, JSON.stringify(change));
  assert.match(verdictProblems("approve", state.body.replace(MANUAL_MERGE_GUIDANCE, "")).join(), /병합 안내/);
  assert.ok(autoApproveProblems({ ...state, verification: { ...state.verification, unverified: ["미검증"] } }, "bypass", mr()).length);
});

test("문서 중심 MR의 중요한 내용 수정은 기록 단계와 최신 제목 재검사에서 보류한다", () => {
  const body = "## 리뷰 결과: 승인\n### 고치면 좋을 것\n1. [중간] `docs/plan.md:3` — 핵심 일정 정정\n### 병합 안내\n" + MANUAL_MERGE_GUIDANCE + "\n### 확인한 범위\n전체 diff";
  const verification = { ...review().verification, reviewKind: "documentation",
    findings: [{ severity: "medium", blocking: false, summary: "핵심 일정 정정" }] };
  assert.match(verdictProblems("approve", body, verification).join(), /문서 중심/);
  for (const title of ["docs(docs): 일정 정리", "docs: 계획", "Draft: docs(docs): 계획", "DOCS(docs)!: 계획"]) {
    assert.match(verdictProblems("approve", body, null, title).join(), /문서 중심/);
    const state = { ...review(), body, verification: { ...verification, reviewKind: "general" } };
    assert.ok(autoApproveProblems(state, "bypass", { ...mr(), title }).length, "최신 docs 제목을 general 분류로 우회하지 않는다");
  }
  assert.match(verdictProblems("approve", body.replace("[중간]", "[중간] [문서내용]")).join(), /승인할 수 없습니다/);
  assert.match(verdictProblems("approve", body, { ...verification, reviewKind: "general",
    findings: [{ ...verification.findings[0], blocking: true }] }).join(), /차단/);
});

test("게이트는 하네스의 조건부 승인만 허용하고 직접 Approve·API·Merge를 차단한다", () => {
  const input = (command) => ({ tool_name: "Bash", tool_input: { command } });
  const command = "node /plugins/mmp/bin/mr-review.mjs auto-approve";
  assert.equal(gateDecision(input(command), review, () => "bypass").permissionDecision, "allow");
  assert.equal(gateDecision(input(command), review, () => "off").permissionDecision, "deny");
  assert.equal(gateDecision(input(command), () => ({ step: "reviewed" }), () => "bypass").permissionDecision, "deny");
  for (const direct of ["glab mr approve 7", "glab mr merge 7", "glab api projects/g%2Fr/merge_requests/7/approve --method POST",
    "glab api --method PUT projects/1/merge_requests/7/merge"]) {
    assert.equal(gateDecision(input(direct), review, () => "bypass").permissionDecision, "deny");
  }
});

test("CI 없음은 실제 빈 파이프라인 목록과 로컬 필수 검사 전체 통과가 있어야 허용한다", () => {
  const noCi = { ...mr(), head_pipeline: null };
  assert.deepEqual(autoApproveProblems(review(), "bypass", noCi, []), []);
  for (const pipelines of [undefined, null, {}, { message: "forbidden" }, [{ status: "failed", sha }], [{ status: "running", sha }]]) {
    assert.ok(autoApproveProblems(review(), "bypass", noCi, pipelines).length);
  }
  assert.ok(autoApproveProblems(review(), "bypass", { ...noCi, head_pipeline: undefined }, []).length);
  assert.ok(autoApproveProblems({ ...review(), verification: null }, "bypass", noCi, []).length);
  assert.ok(autoApproveProblems({ ...review(), verification: { ...review().verification, checks: [] } }, "bypass", noCi, []).length);
  assert.ok(autoApproveProblems({ ...review(), verification: { ...review().verification,
    checks: [{ name: "test", status: "failed", evidence: "exit 1" }] } }, "bypass", noCi, []).length);
  assert.ok(autoApproveProblems(review(), "off", noCi, []).length);
  for (const status of ["running", "failed", "pending", "skipped", "canceled"]) {
    assert.ok(autoApproveProblems(review(), "bypass", { ...mr(), head_pipeline: { status, sha } }, []).length,
      "존재하는 CI를 로컬 검증으로 우회할 수 없다");
  }
});

test("리뷰 채팅 claim·대기 ID·실제 ID 연결은 중복 생성과 재연결을 방지한다", () => {
  const event = { eventId: "42", todoIds: [42], project: "g/r", mrUrl: "https://gitlab.example.com/g/r/-/merge_requests/7#note_1" };
  const initial = { since: 1, seen: [42], queue: [event] };
  let state = claimSession(initial, "42");
  assert.throws(() => claimSession(state, "42"), /이미 생성 요청/);
  assert.throws(() => claimSession(initial, "other"), /대기 중/);
  assert.throws(() => claimSession({ ...initial, queue: [{ ...event, project: "other" }] }, "42"), /일치/);
  state = bindSession(state, "42", { clientThreadId: "pending", hostId: "local" });
  assert.equal(state.sessions[0].threadId, null);
  assert.equal(sessionStatus(state.sessions[0], () => ({ state: "merged" })).archiveEligible, false);
  state = bindSession(state, "42", { threadId: "actual", hostId: "local" });
  state = JSON.parse(JSON.stringify(state));
  assert.throws(() => bindSession(state, "42", { threadId: "different" }), /다른 세션/);
  assert.throws(() => bindSession(state, "42", { hostId: "local" }), /thread/);
  assert.throws(() => bindSession(state, "42", { threadId: "--host-id" }), /thread/);
  state = acknowledge(state, "42");
  assert.equal(state.queue.length, 0);
  assert.equal(state.sessions[0].threadId, "actual", "ack 후에도 병합 확인용 ID 보존");
  for (const status of ["opened", "closed"]) {
    assert.equal(sessionStatus(state.sessions[0], () => ({ state: status })).archiveEligible, false);
    assert.throws(() => markSessionArchived(state, "42", () => ({ state: status })), /실제 MR 병합/);
  }
  assert.equal(sessionStatus(state.sessions[0], () => ({ state: "merged" })).archiveEligible, true);
  state = markSessionArchived(state, "42", () => ({ state: "merged" }));
  assert.ok(state.sessions[0].archivedAt);
  assert.equal(sessionStatus(state.sessions[0], () => ({ state: "merged" })).archiveEligible, false);
});

test("새 eventId의 재리뷰도 host/project/MR이 같으면 기존 채팅·워크트리에 연결한다", () => {
  const event = (id, url = "https://gitlab.example.com/g/r/-/merge_requests/7") => ({ eventId: id, todoIds: [Number(id)], project: "g/r", mrUrl: url });
  let state = claimSession({ since: 1, seen: [], queue: [event("1")] }, "1");
  state = bindSession(state, "1", { threadId: "old-chat", hostId: "local", worktreePath: process.cwd() });
  state = acknowledge(state, "1");
  state.queue = [event("2", event("1").mrUrl + "#note_123")];
  state = claimSession(JSON.parse(JSON.stringify(state)), "2");
  assert.equal(state.sessions.length, 1);
  assert.deepEqual(sessionForEvent(state, "2").eventIds, ["1", "2"]);
  assert.equal(sessionForEvent(state, "2").threadId, "old-chat");
  assert.equal(sessionForEvent(state, "2").worktreePath, process.cwd());
  assert.throws(() => claimSession(state, "2"), /이미 생성/);
  assert.throws(() => bindSession(state, "2", { threadId: "new-chat" }), /다른 세션/);
  assert.throws(() => bindSession(state, "2", { threadId: "old-chat", worktreePath: "relative/path" }), /절대경로/);
  assert.throws(() => bindSession(state, "2", { threadId: "old-chat", worktreePath: process.cwd() + "/different" }), /같은 절대경로/);
  state = acknowledge(state, "2");
  assert.equal(sessionForEvent(state, "2").threadId, "old-chat");
  assert.ok(sessionForEvent(markSessionArchived(state, "2", () => ({ state: "merged" })), "1").archivedAt);
  for (const url of ["https://other.example.com/g/r/-/merge_requests/7", "https://gitlab.example.com/g/r/-/merge_requests/8"]) {
    assert.equal(claimSession({ ...state, queue: [event("3", url)] }, "3").sessions.length, 2);
  }
  const pending = { ...state, sessions: [{ ...state.sessions[0], threadId: null, clientThreadId: "creating" }], queue: [event("3")] };
  assert.equal(sessionForEvent(claimSession(pending, "3"), "3").clientThreadId, "creating", "생성 중이어도 새로 만들지 않는다");
  const archived = { ...pending, sessions: [{ ...pending.sessions[0], archivedAt: "now" }] };
  assert.throws(() => claimSession(archived, "3"), /보관/);
  const duplicates = { ...state, sessions: [...state.sessions, { ...state.sessions[0], eventId: "old-duplicate", eventIds: undefined, threadId: "duplicate" }], queue: [event("3")] };
  const next = claimSession(duplicates, "3");
  assert.equal(next.sessions.length, 2, "기존 중복 기록은 삭제하지 않는다");
  assert.equal(sessionForEvent(next, "3").threadId, "old-chat", "새 이벤트는 최초 연결 채팅만 재사용");
});
