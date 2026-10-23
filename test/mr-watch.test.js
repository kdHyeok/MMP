import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAYBE_ACTIONS, REVIEW_ACTIONS, isExplicitReviewRequest, loadConfig, loggedInHosts, reviewEvent, selectTodos, verifyCommentRequest } from "../bin/mr-watch.mjs";

const PROJECTS = { "g/repo": { workdir: "C:/work/repo", jiraBaseUrl: "https://jira.example.com/browse" } };

function todo(overrides = {}) {
  return {
    id: 1,
    action_name: "review_requested",
    target_type: "MergeRequest",
    target: { iid: 185, title: "제목" },
    target_url: "https://gitlab.example.com/g/repo/-/merge_requests/185",
    author: { username: "youngsoo.lee", name: "이영수" },
    project: { path_with_namespace: "g/repo" },
    created_at: "2026-09-22T10:00:00.000Z",
    body: "본문",
    ...overrides,
  };
}

const pick = (todos, options = {}) => selectTodos(todos, { projects: PROJECTS, seen: new Set(), since: 0, ...options });

test("리뷰어 지정은 판정 없이 확정으로 흘린다", () => {
  const [one] = pick([todo()]);
  assert.equal(one.certain, true);
  assert.equal(one.iid, 185);
  assert.equal(one.mrUrl, "https://gitlab.example.com/g/repo/-/merge_requests/185");
  assert.equal(one.authorName, "이영수");
  // 설정에서 따라온 값이 그대로 실려야 스킬이 세션을 띄울 수 있다
  assert.equal(one.workdir, "C:/work/repo");
  assert.equal(one.jiraBaseUrl, "https://jira.example.com/browse");

  assert.equal(pick([todo({ action_name: "approval_required" })])[0].certain, true);
});

test("멘션은 실제 작성자의 명시적인 리뷰 요청 검증이 있어야 넘긴다", () => {
  for (const action of MAYBE_ACTIONS) {
    assert.deepEqual(pick([todo({ action_name: action, body: "리뷰 부탁드립니다" })]), [], "todo 본문만 믿지 않는다");
    const [one] = pick([todo({ action_name: action, body: "리뷰 부탁드립니다", reviewRequestVerified: true })]);
    assert.equal(one.certain, false, action);
  }
});

test("일반 질문·리뷰 완료·감사·부정·인용은 자동 리뷰 요청이 아니다", () => {
  for (const body of ["수정 반영했습니다. 재 리뷰 요청드립니다!", "@user 리뷰 부탁드립니다.", "다시 리뷰해주세요", "리뷰 좀 해주실 수 있나요?",
    "@user please review again", "Could you re-review this MR?", "Requesting another review"]) assert.equal(isExplicitReviewRequest(body), true, body);
  for (const body of ["@user 확인 부탁드립니다", "리뷰 완료했습니다. 이 부분을 수정하고 직접 병합해 주세요.", "리뷰 감사합니다", "리뷰 요청 감사합니다",
    "재리뷰 요청 처리 완료", "리뷰 부탁드렸습니다", "리뷰 요청이 아닙니다", "리뷰하지 마세요", "리뷰 필요 없습니다", "리뷰해주실 필요 없습니다", "Don't review this",
    "> 리뷰 부탁드립니다\n검토 결과를 공유합니다.", '"리뷰 부탁드립니다"라는 문구입니다.', "```\n리뷰 부탁드립니다\n```", "```\n리뷰 부탁드립니다", "`please review`",
    "## 리뷰 결과: 승인\n확인한 요청: 리뷰 부탁드립니다", ""]) {
    assert.equal(isExplicitReviewRequest(body), false, body);
  }
});

test("실제 댓글 ID·MR 작성자·시스템 여부·열린 MR까지 대조하며 legacy 큐도 재검사한다", () => {
  const raw = todo({ action_name: "mentioned", target_url: "https://gitlab.example.com/g/repo/-/merge_requests/185#note_9" });
  const note = { id: 9, system: false, body: "수정했습니다. 재리뷰 요청드립니다", author: { username: "author" } };
  const mr = { state: "opened", author: { username: "author" } };
  const verified = verifyCommentRequest(raw, note, mr);
  assert.equal(pick([verified])[0].requestNoteId, "9");
  assert.equal(pick([raw], { resolveComment: (todo) => verifyCommentRequest(todo, note, mr) })[0].body, note.body);
  for (const changed of [{ ...note, id: 8 }, { ...note, system: true }, { ...note, author: { username: "reviewer" } },
    { ...note, body: "리뷰 완료했습니다. 병합하세요." }, { ...note, body: "확인 부탁드립니다" }]) assert.equal(verifyCommentRequest(raw, changed, mr), null);
  assert.equal(verifyCommentRequest(raw, note, { ...mr, state: "merged" }), null);
  assert.equal(verifyCommentRequest(raw, note, { state: "opened" }), null);
  assert.equal(verifyCommentRequest({ ...raw, target_url: raw.target_url.split("#")[0] }, note, mr), null);
  const event = { action: "mentioned", eventId: "old", mrUrl: raw.target_url, project: "g/repo", body: "리뷰 부탁드립니다" };
  assert.equal(reviewEvent(event, "gitlab.example.com", () => null).type, "review_ignored");
  assert.equal(reviewEvent(event, "gitlab.example.com", () => verified).reviewRequested, true);
  assert.throws(() => reviewEvent(event, "gitlab.example.com", () => { throw Error("API denied"); }), /API denied/, "조회 실패를 요청/제외로 확정하지 않는다");
});

test("리뷰 요청이 아닌 todo는 흘리지 않는다", () => {
  assert.deepEqual(pick([todo({ action_name: "assigned" })]), [], "담당자 지정은 리뷰 요청이 아니다");
  assert.deepEqual(pick([todo({ action_name: "build_failed" })]), []);
  assert.deepEqual(pick([todo({ target_type: "Issue" })]), [], "MR이 아닌 대상은 제외");
});

test("설정되지 않은 프로젝트는 건드리지 않는다", () => {
  assert.deepEqual(pick([todo({ project: { path_with_namespace: "other/repo" } })]), []);
});

test("이미 처리한 todo와 감시 시작 이전 백로그는 재생하지 않는다", () => {
  assert.deepEqual(pick([todo({ id: 7 })], { seen: new Set([7]) }), []);

  const since = Date.parse("2026-09-22T12:00:00.000Z");
  assert.deepEqual(pick([todo({ created_at: "2026-09-22T11:00:00.000Z" })], { since }), [], "시작 전 todo는 무시");
  assert.equal(pick([todo({ created_at: "2026-09-22T13:00:00.000Z" })], { since }).length, 1);
});

test("여러 건은 오래된 순으로 정렬해 내보낸다", () => {
  const mr = (iid, rest) => todo({ target: { iid }, ...rest });
  const picked = pick([
    mr(2, { id: 2, created_at: "2026-09-22T12:00:00.000Z" }),
    mr(1, { id: 1, created_at: "2026-09-22T10:00:00.000Z" }),
    mr(3, { id: 3, created_at: "2026-09-22T11:00:00.000Z" }),
  ]);
  assert.deepEqual(picked.map((item) => item.todoId), [1, 3, 2]);
});

// 실제 데이터에서 한 MR에 리뷰어 지정과 멘션이 같이 오는 일이 흔하다. 칩이 두 개 뜨면 낭비다.
test("같은 배치의 한 MR은 하나로 합치고, 확정 액션을 남긴다", () => {
  const picked = pick([
    todo({ id: 10, action_name: "directly_addressed", body: "리뷰 부탁드립니다", reviewRequestVerified: true, created_at: "2026-09-22T10:00:00.000Z" }),
    todo({ id: 11, action_name: "review_requested", created_at: "2026-09-22T10:00:05.000Z" }),
  ]);
  assert.equal(picked.length, 1, "한 MR은 한 건으로");
  assert.equal(picked[0].certain, true, "확정 액션이 남아야 판단 단계를 건너뛴다");
  assert.deepEqual(picked[0].todoIds, [10, 11], "합쳐진 todo id를 전부 들고 가야 다음 폴링에 다시 안 올라온다");

  // 다른 MR은 합치지 않는다
  assert.equal(pick([todo({ id: 20, target: { iid: 1 } }), todo({ id: 21, target: { iid: 2 } })]).length, 2);
});

test("멘션 URL의 note 조각이 있어도 MR 링크로 파싱된다", async () => {
  const { parseMrUrl } = await import("../bin/mr-review.mjs");
  const [one] = pick([todo({
    action_name: "mentioned",
    body: "리뷰 부탁드립니다", reviewRequestVerified: true,
    target_url: "https://gitlab.example.com/g/repo/-/merge_requests/104#note_2840009",
  })]);
  assert.deepEqual(parseMrUrl(one.mrUrl), { host: "gitlab.example.com", project: "g/repo", iid: 104 });
});

test("확정 액션 목록이 흔들리면 스킬 문서와 어긋난다", () => {
  assert.deepEqual([...REVIEW_ACTIONS], ["review_requested", "approval_required"]);
  assert.deepEqual([...MAYBE_ACTIONS], ["directly_addressed", "mentioned"]);
});

// 호스트를 코드에 박지 않는다(이 저장소는 공개다). glab 이 실제로 로그인한 곳에서 가져온다.
test("로그인한 호스트를 auth status 출력에서 뽑는다", () => {
  const status = [
    "gitlab.com",
    "  x gitlab.com: API call failed: 401",
    "  ! No token found (checked config file, keyring, and environment variables).",
    "git.example.com",
    "  ✓ Logged in to git.example.com as someone (keyring)",
  ].join("\n");
  assert.deepEqual(loggedInHosts(status), ["git.example.com"], "401만 난 호스트는 로그인이 아니다");
  assert.deepEqual(loggedInHosts(""), []);
  assert.deepEqual(loggedInHosts("Logged in to a.example.com as x\nLogged in to b.example.com as y"),
    ["a.example.com", "b.example.com"]);
});

test("설정에 host가 없으면 로그인한 호스트 하나를 쓰고, 애매하면 거부한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmp-watch-"));
  const path = join(dir, "watch.json");
  const write = (config) => writeFileSync(path, JSON.stringify({ projects: { "g/repo": { workdir: dir, jiraBaseUrl: "https://j" } }, ...config }));

  write({});
  assert.equal(loadConfig(path, () => ["git.example.com"]).host, "git.example.com");

  // 설정이 언제나 이긴다 — 추론은 비어 있을 때만 한다
  write({ host: "설정이-이긴다.example.com" });
  assert.equal(loadConfig(path, () => ["git.example.com"]).host, "설정이-이긴다.example.com");

  // 틀린 추측은 조용한 401이 되므로, 확신이 없으면 멈춘다
  write({});
  assert.throws(() => loadConfig(path, () => []), /로그인/);
  assert.throws(() => loadConfig(path, () => ["a.example.com", "b.example.com"]), /여러 호스트/);
});
