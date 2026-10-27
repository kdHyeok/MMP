import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { MattermostService } from "../src/core.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("격리된 MR CLI 흐름: inspect → 관리 워크트리 → record → 확인 게시 → 작성자 DM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mmp-flow 한글 #-"));
  const author = join(dir, "author");
  const clone = join(dir, "clone");
  const managed = join(dir, "managed");
  const origin = join(dir, "group", "repo.git");
  const dataDir = join(dir, "data");
  const notesFile = join(dir, "notes.jsonl");
  const preload = join(dir, "glab-stub.cjs");
  const mrFile = join(dir, "mr.json");
  const approvalFile = join(dir, "approval.json");
  const approvalLog = join(dir, "approvals.jsonl");
  let received;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { received = JSON.parse(body); res.end("ok"); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    mkdirSync(dirname(origin), { recursive: true });
    git(dir, "init", "--bare", "-b", "main", origin);
    git(dir, "clone", origin.replaceAll("\\", "/"), author);
    writeFileSync(join(author, "a.js"), "export const value = 1;\n");
    git(author, "add", "a.js"); git(author, "commit", "-m", "base"); git(author, "push", "origin", "main");
    git(author, "checkout", "-b", "feat/review");
    writeFileSync(join(author, "a.js"), "export const value = 2;\n");
    git(author, "commit", "-am", "change"); git(author, "push", "origin", "feat/review");
    const head = git(author, "rev-parse", "HEAD");
    const remoteMr = { source_branch: "feat/review", target_branch: "main", state: "opened", author: { username: "author", name: "작성자" },
      title: "test", Discussions: [], sha: head, diff_refs: { head_sha: head }, has_conflicts: false,
      detailed_merge_status: "mergeable", head_pipeline: { sha: head, status: "success" } };
    writeFileSync(mrFile, JSON.stringify(remoteMr));
    git(dir, "clone", origin.replaceAll("\\", "/"), clone);
    const originalHead = git(clone, "rev-parse", "HEAD");
    git(clone, "worktree", "add", "--detach", managed, "main");

    // glab만 대체한다. git/하네스/SQLite/로컬 HTTP 전송은 실제로 실행한다.
    writeFileSync(preload, `const cp = require('node:child_process');
const fs = require('node:fs');
const exec = cp.execFileSync, spawn = cp.spawnSync;
cp.execFileSync = (file, args, options) => {
  if (file !== 'glab') return exec(file, args, options);
  if (args[1] === 'view') return fs.readFileSync(process.env.MMP_TEST_MR, 'utf8');
  if (args[1] === 'note') { fs.appendFileSync(process.env.MMP_TEST_NOTES, JSON.stringify({ args, host: options.env.GITLAB_HOST }) + '\\n'); return 'posted'; }
  if (args[0] === 'api') {
    const approved = fs.existsSync(process.env.MMP_TEST_APPROVAL);
    if (args[1].includes('/pipelines?')) return JSON.stringify(JSON.parse(fs.readFileSync(process.env.MMP_TEST_MR, 'utf8')).pipelines);
    if (args[1].endsWith('/approvals')) return JSON.stringify({ user_has_approved: approved, user_can_approve: true });
    if (args[1].endsWith('/approve')) {
      const sha = JSON.parse(fs.readFileSync(process.env.MMP_TEST_MR, 'utf8')).sha;
      if (!args.includes('sha=' + sha) || !args.includes('POST')) throw new Error('409 SHA mismatch');
      fs.appendFileSync(process.env.MMP_TEST_APPROVAL_LOG, JSON.stringify(args) + '\\n');
      fs.writeFileSync(process.env.MMP_TEST_APPROVAL, '{}');
      return JSON.stringify({ user_has_approved: true });
    }
    return fs.readFileSync(process.env.MMP_TEST_MR, 'utf8');
  }
  throw new Error('unexpected glab call');
};
cp.spawnSync = (file, args, options) => file === 'glab' ? { stdout: '', stderr: 'Logged in to gitlab.example.com', status: 0 } : spawn(file, args, options);
require('node:module').syncBuiltinESMExports();
`);
    const service = new MattermostService({ dataDir, allowHttp: true });
    try {
      service.createWebhook({ name: "local", webhookUrl: `http://127.0.0.1:${server.address().port}/hooks/test-only` });
      service.createChannel({ name: "test", webhookName: "local" });
      service.createParticipant({ displayName: "작성자", mattermostUsername: "author.mm", gitlabUsername: "author" });
      service.createParticipant({ displayName: "본인", mattermostUsername: "self.mm", gitlabUsername: "self", isSelf: true });
      service.createParticipant({ displayName: "요청자", mattermostUsername: "requester.mm", gitlabUsername: "requester" });
      service.createConvention({ name: "review-complete", template: "{{mention}} :review_complete_shake: !{{mr_number}} | [{{jira_key}}] {{message}}" });
    } finally { service.close(); }
    const env = { ...process.env, MATTERMOST_MCP_DATA_DIR: dataDir, MATTERMOST_MCP_ALLOW_HTTP: "1", MMP_TEST_NOTES: notesFile,
      MMP_TEST_MR: mrFile, MMP_TEST_APPROVAL: approvalFile, MMP_TEST_APPROVAL_LOG: approvalLog };
    const base = ["--require", preload, join(root, "bin", "mr-review.mjs")];
    const options = { env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 };
    const run = (...args) => JSON.parse(execFileSync(process.execPath, [...base, ...args], options));
    const mr = "https://gitlab.example.com/group/repo/-/merge_requests/7";
    assert.equal(run("prepare", mr, "--inspect", "--cwd", clone).sourceBranch, "feat/review");
    assert.equal(existsSync(join(clone, ".claude")), false);
    const state = run("prepare", mr, "--here", "--keep-branch", "--event-id", "42", "--cwd", managed);
    assert.equal(state.eventId, "42");
    assert.equal(git(managed, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
    assert.equal(git(clone, "rev-parse", "HEAD"), originalHead);
    assert.throws(() => run("prepare", mr, "--here", "--keep-branch", "--cwd", managed), /재개/);
    const body = join(dir, "body.md");
    writeFileSync(body, "## 리뷰 결과: 승인\n### 확인한 범위\na.js\n");
    run("record", "approve", body, "--cwd", managed);
    assert.throws(() => run("post", "--cwd", managed), /사용자 승인/);
    assert.equal(existsSync(notesFile), false);
    assert.throws(() => run("notify", "--channel", "test", "--jira", "TEST-7", "--cwd", managed), /먼저 게시/);
    assert.equal(run("post", "--confirmed", "--cwd", managed).step, "posted");
    const note = JSON.parse(readFileSync(notesFile, "utf8").trim());
    assert.equal(note.host, "gitlab.example.com");
    assert.ok(note.args.includes("--unique"));
    assert.throws(() => run("post", "--confirmed", "--cwd", managed), /필요한 단계/);
    const result = await promisify(execFile)(process.execPath, [...base, "notify", "--channel", "test", "--jira", "TEST-7", "--cwd", managed], options);
    assert.equal(JSON.parse(result.stdout).ok, true);
    assert.equal(received.channel, "@author.mm");
    assert.ok(received.text.includes("!7"));
    assert.equal(run("status", "--cwd", managed).step, "notified");
    assert.throws(() => run("prepare", mr, "--here", "--keep-branch", "--event-id", "42", "--cwd", managed), /이미 완료/);

    // 새 이벤트는 새 검증 기록으로만 자동 승인하며, 실제 외부 서버에는 접근하지 않는다.
    assert.throws(() => run("prepare", mr, "--here", "--keep-branch", "--event-id", "43", "--cwd", managed), /--rereview/);
    const next = run("prepare", mr, "--rereview", "--here", "--keep-branch", "--event-id", "43", "--self-only", "--cwd", managed);
    assert.equal(next.history.length, 1);
    assert.equal(next.history[0].eventId, "42");
    assert.equal(next.preparedSha, head);
    assert.equal(next.notificationRecipient.mention, "@self.mm");
    const verification = join(dir, "verification.json");
    const evidence = { sha: head, reviewKind: "documentation",
      findings: [{ severity: "medium", blocking: false, summary: "예시 문구 통일" }], unverified: [],
      checks: [{ name: "isolated test", status: "passed", evidence: "exit 0" }] };
    const suggestedBody = "## 리뷰 결과: 승인\n### 고치면 좋을 것 (병합은 막지 않음)\n1. [중간] `a.js:1` — 예시 문구 통일\n   - 예시의 변수 이름을 통일해 주세요.\n### 병합 안내\n위 항목을 수정한 뒤 직접 병합해 주세요.\n### 확인한 범위\na.js\n";
    writeFileSync(body, suggestedBody);
    writeFileSync(verification, JSON.stringify(evidence));
    assert.throws(() => run("record", "approve", body, "--verification", verification, "--cwd", managed), /문서 중심/);
    assert.equal(run("status", "--cwd", managed).step, "prepared");
    writeFileSync(verification, JSON.stringify({ ...evidence, reviewKind: "general" }));
    writeFileSync(body, suggestedBody.replace("위 항목을 수정한 뒤 직접 병합해 주세요.", ""));
    assert.throws(() => run("record", "approve", body, "--verification", verification, "--cwd", managed), /병합 안내/);
    writeFileSync(body, suggestedBody);
    run("record", "approve", body, "--verification", verification, "--cwd", managed);
    assert.throws(() => run("auto-approve", "--cwd", managed), /게시/);
    run("post", "--confirmed", "--cwd", managed);
    assert.throws(() => run("auto-approve", "--cwd", managed), /bypass/);
    const bypassBase = [join(root, "bin", "bypass-review.mjs")];
    execFileSync(process.execPath, [...bypassBase, "on"], options);
    writeFileSync(mrFile, JSON.stringify({ ...remoteMr, title: "docs(docs): 핵심 내용 정리" }));
    assert.throws(() => run("auto-approve", "--cwd", managed), /승인 가능한 리뷰/);
    assert.equal(existsSync(approvalLog), false);
    writeFileSync(mrFile, JSON.stringify({ ...remoteMr, sha: "b".repeat(40) }));
    assert.throws(() => run("auto-approve", "--cwd", managed), /커밋/);
    writeFileSync(mrFile, JSON.stringify({ ...remoteMr, head_pipeline: { sha: head, status: "running" } }));
    assert.throws(() => run("auto-approve", "--cwd", managed), /파이프라인/);
    writeFileSync(mrFile, JSON.stringify({ ...remoteMr, head_pipeline: null, pipelines: [{ status: "failed", sha: head }] }));
    assert.throws(() => run("auto-approve", "--cwd", managed), /CI/);
    writeFileSync(mrFile, JSON.stringify({ ...remoteMr, head_pipeline: null, pipelines: [] }));
    const approved = run("auto-approve", "--cwd", managed).approval;
    assert.equal(approved.sha, head);
    assert.equal(approved.validation, "local-no-ci");
    run("auto-approve", "--cwd", managed);
    assert.equal(readFileSync(approvalLog, "utf8").trim().split(/\r?\n/).length, 1, "재실행해도 POST는 한 번");
    const postedArgs = JSON.parse(readFileSync(approvalLog, "utf8").trim());
    assert.ok(postedArgs.includes(`sha=${head}`));
    assert.ok(postedArgs.includes("gitlab.example.com"));
    assert.ok(JSON.parse(readFileSync(notesFile, "utf8").trim().split(/\r?\n/)[1]).args.includes(suggestedBody.trim()), "승인 POST 전에 수정 후 직접 병합 안내가 게시됨");
    assert.throws(() => run("notify", "--channel", "test", "--jira", "TEST-7", "--participant-id", "1", "--cwd", managed), /본인 전송 제한/);
    await promisify(execFile)(process.execPath, [...base, "notify", "--channel", "test", "--jira", "TEST-7", "--cwd", managed], options);
    assert.equal(received.channel, "@self.mm", "MR 작성자가 아니라 등록된 본인에게만 전송");
    assert.equal(run("status", "--cwd", managed).step, "notified");
    // 같은 MR의 rebase/force-push도 기존 관리 워크트리에서 이력을 남기고 재리뷰한다.
    git(author, "checkout", "main");
    git(author, "checkout", "-B", "feat/review");
    writeFileSync(join(author, "a.js"), "export const value = 3;\n");
    git(author, "commit", "-am", "replace review head");
    git(author, "push", "--force", "origin", "feat/review");
    const newHead = git(author, "rev-parse", "HEAD");
    writeFileSync(mrFile, JSON.stringify({ ...remoteMr, sha: newHead, diff_refs: { head_sha: newHead } }));
    const again = ["prepare", mr, "--rereview", "--here", "--keep-branch", "--event-id", "44", "--cwd", managed];
    assert.throws(() => run(...again, "--requester", "requester"), /사용자 확인/, "기존 본인 제한 해제는 명시적 확인이 필요하다");
    assert.throws(() => run(...again, "--requester", "@requester"), /사용자명/);
    assert.throws(() => run(...again, "--requester", "requester", "--self-only"), /함께 지정/);
    const reviewedContent = readFileSync(join(managed, "a.js"));
    writeFileSync(join(managed, "a.js"), "local changes must survive\n");
    assert.throws(() => run(...again), /커밋되지 않은 변경/);
    assert.equal(readFileSync(join(managed, "a.js"), "utf8"), "local changes must survive\n");
    writeFileSync(join(managed, "a.js"), reviewedContent);
    assert.equal(git(managed, "status", "--porcelain"), "");
    git(managed, "commit", "--allow-empty", "-m", "local work");
    const localHead = git(managed, "rev-parse", "HEAD");
    assert.throws(() => run(...again), /HEAD가 바뀌었습니다/);
    assert.equal(git(managed, "rev-parse", "HEAD"), localHead);
    git(managed, "checkout", "--detach", head);
    const rereview = run(...again);
    assert.equal(rereview.worktreePath, managed);
    assert.equal(rereview.createdWorktree, false);
    assert.equal(rereview.preparedSha, newHead);
    assert.equal(rereview.step, "prepared");
    assert.equal(rereview.body, null);
    assert.equal(rereview.approval, undefined);
    assert.equal(rereview.notificationSelfOnly, true, "self-only는 다음 회차에 옵션을 빼도 유지된다");
    assert.deepEqual(rereview.history.map((round) => round.eventId), ["42", "43"]);
    assert.equal(rereview.history[1].approval.sha, head);
    assert.equal(git(clone, "rev-parse", "HEAD"), originalHead);
    assert.equal(git(clone, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 2, "기존 clone/managed 외 새 워크트리를 만들지 않는다");
    assert.throws(() => run(...again), /재개/);
    run("record", "approve", body, "--cwd", managed);
    run("post", "--cwd", managed);
    const notify = ["notify", "--channel", "test", "--jira", "TEST-7", "--cwd", managed];
    assert.throws(() => run(...notify, "--requester", "requester"), /사용자 확인/);
    assert.throws(() => run(...notify, "--requester", "missing", "--confirmed"), /요청자의 정확한 Mattermost 매핑/);
    assert.throws(() => run(...notify, "--requester", "requester", "--confirmed", "--participant-id", "1"), /요청자와 다른 수신자/);
    assert.equal(run("status", "--cwd", managed).step, "posted", "실패하면 전송/상태 변경이 없다");
    await promisify(execFile)(process.execPath, [...base, ...notify, "--requester", "requester", "--confirmed"], options);
    assert.equal(received.channel, "@requester.mm", "작성자/본인과 다른 실제 요청자에게 전달한다");
    assert.equal(run("status", "--cwd", managed).notificationSelfOnly, false);
    assert.equal(run("status", "--cwd", managed).notificationRequester, "requester");
    assert.throws(() => run(...notify, "--requester", "requester", "--confirmed"), /먼저 게시/, "완료된 DM은 수신 정책 변경으로 재전송하지 않는다");
    const requested = run("prepare", mr, "--rereview", "--here", "--keep-branch", "--event-id", "45", "--requester", "requester", "--cwd", managed);
    assert.equal(requested.notificationSelfOnly, false);
    assert.equal(requested.notificationRecipient.mention, "@requester.mm");
    assert.equal(requested.notificationRequester, "requester");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
