import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { dataDir } from "../bin/bypass-review.mjs";
import { acquireWatchLock, acknowledge, enqueueTodos, tick, watchActive } from "../bin/mr-watch.mjs";
import { gateCwd } from "../bin/mr-review.mjs";
import { resolveDataDir } from "../src/paths.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = (file, args, env, input) => execFileSync(process.execPath, [join(root, "bin", file), ...args],
  { encoding: "utf8", env: { ...process.env, ...env }, input, stdio: ["pipe", "pipe", "pipe"] });
const json = (text) => JSON.parse(text);

test("Codex 재리뷰 예제는 요청자 DM이 기본이며 self-only를 강제하지 않는다", () => {
  const guide = readFileSync(join(root, "skills", "references", "codex.md"), "utf8");
  assert.ok(guide.includes("--requester <확인한GitLabID>"));
  assert.ok(guide.includes("최신 사용자 지시"));
  assert.ok(!guide.includes("--event-id <새eventId> --self-only"));
});

test("MCP와 승인 정책은 전달된 사용자 프로필과 명시적 데이터 경로를 공유한다", () => {
  const before = { profile: process.env.MATTERMOST_MCP_USERPROFILE, dir: process.env.MATTERMOST_MCP_DATA_DIR };
  try {
    delete process.env.MATTERMOST_MCP_DATA_DIR;
    process.env.MATTERMOST_MCP_USERPROFILE = join(tmpdir(), "공유 사용자");
    assert.equal(dataDir(), resolveDataDir());
    assert.equal(dataDir(), join(tmpdir(), "공유 사용자", ".mmp"));
    process.env.MATTERMOST_MCP_DATA_DIR = join(tmpdir(), "명시적 경로");
    assert.equal(dataDir(), resolveDataDir());
  } finally {
    for (const [key, value] of [["MATTERMOST_MCP_USERPROFILE", before.profile], ["MATTERMOST_MCP_DATA_DIR", before.dir]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("감시 대기 목록은 재조회에 보존되고 ack 후 같은 todo를 재전달하지 않는다", () => {
  const projects = { "g/r": { workdir: root, jiraBaseUrl: "https://jira.example.com" } };
  const todo = { reviewTargetVerified: true, id: 1, target_type: "MergeRequest", action_name: "review_requested", project: { path_with_namespace: "g/r" },
    target: { iid: 7 }, target_url: "https://gitlab.example.com/g/r/-/merge_requests/7", created_at: "2026-10-07T00:00:00Z" };
  let state = enqueueTodos({ since: 1, seen: [] }, [todo], projects);
  assert.equal(state.queue.length, 1);
  state = json(JSON.stringify(state)); // 세션 사이 디스크 왕복
  assert.deepEqual(enqueueTodos(state, [todo], projects).queue, state.queue);
  state = acknowledge(state, "1");
  assert.equal(enqueueTodos(state, [todo], projects).queue.length, 0);
  assert.throws(() => acknowledge(state, "1"), /대기 중인 이벤트/);
  const again = enqueueTodos(state, [{ ...todo, id: 2 }], projects);
  assert.equal(again.queue[0].eventId, "2", "같은 MR의 새 재리뷰 요청은 보존한다");
  const many = Array.from({ length: 510 }, (_, i) => ({ ...todo, id: i + 1, target: { iid: i + 1 } }));
  state = enqueueTodos({ since: 1, seen: [] }, many, projects);
  for (const item of [...state.queue]) state = acknowledge(state, item.eventId);
  assert.equal(enqueueTodos(state, many, projects).queue.length, 0, "500건이 넘어도 제외한 pending 요청을 다시 내보내지 않는다");
});

test("실제 감시 tick은 전달 전에 큐를 저장하고 재실행과 클라이언트 경합에서 상태를 보존한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmp-tick-"));
  const paths = { config: join(dir, "watch.json"), state: join(dir, "watch-state.json"), stateLock: join(dir, "watch-state.lock") };
  try {
    writeFileSync(paths.config, JSON.stringify({ host: "gitlab.example.com", projects: { "g/r": { workdir: root, jiraBaseUrl: "https://jira.example.com" } } }));
    writeFileSync(paths.state, JSON.stringify({ since: 1, seen: [], client: "codex" }));
    const fetch = () => [{ id: 9, target_type: "MergeRequest", action_name: "review_requested", project: { path_with_namespace: "g/r" }, target: { iid: 7 }, target_url: "https://gitlab.example.com/g/r/-/merge_requests/7", created_at: "2026-10-07T00:00:00Z" }];
    const resolveRequest = (todo) => ({ ...todo, reviewTargetVerified: true });
    const first = tick(paths, "codex", fetch, resolveRequest);
    assert.deepEqual(json(readFileSync(paths.state, "utf8")).queue, first.state.queue);
    assert.equal(tick(paths, "codex", fetch, resolveRequest).picked, 0);
    assert.equal(tick(paths, "codex", fetch, resolveRequest).state.queue.length, 1);
    const persisted = readFileSync(paths.state, "utf8");
    assert.throws(() => tick(paths, "codex", () => [{ ...fetch()[0], id: 10, action_name: "mentioned" }],
      () => { throw Error("comment API denied"); }), /comment API denied/);
    assert.equal(readFileSync(paths.state, "utf8"), persisted, "댓글 조회 실패 시 기존 큐와 seen을 그대로 보존한다");
    assert.throws(() => tick(paths, "claude", () => { throw Error("외부 조회하면 안 됨"); }), /codex/);
    assert.equal(json(readFileSync(paths.state, "utf8")).queue.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("감시 잠금은 동시 실행을 거부하고 정상 종료 후 다시 획득한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmp-lock-"));
  const path = join(dir, "watch.lock");
  try {
    const release = acquireWatchLock(path);
    assert.throws(() => acquireWatchLock(path), /실행 중/);
    release();
    acquireWatchLock(path)();
    writeFileSync(path, "{");
    assert.throws(() => acquireWatchLock(path), /불완전/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("감시 CLI는 시작·만료·중지·재개·ack를 저장하고 다른 클라이언트의 활성 감시를 거부한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmp-watch 한글 #-"));
  const env = { MATTERMOST_MCP_DATA_DIR: dir };
  const stateFile = join(dir, "watch-state.json");
  try {
    writeFileSync(join(dir, "watch.json"), JSON.stringify({ host: "gitlab.example.com", projects: { "g/r": { workdir: root, jiraBaseUrl: "https://jira.example.com" } } }));
    const run = (...args) => cli("mr-watch.mjs", args, env);
    const started = json(run("--start", "--client", "codex", "--hours", "2"));
    assert.equal(started.client, "codex");
    assert.equal(started.active, true);
    assert.throws(() => run("--start", "--client", "claude"), /이미 codex/);
    assert.throws(() => run("--start", "--hours", "0"), /양수/);
    const state = json(readFileSync(stateFile, "utf8"));
    assert.equal(watchActive(state, state.expiresAt), false);
    state.queue = [{ eventId: "9", todoIds: [9], mrUrl: "https://gitlab.example.com/g/r/-/merge_requests/7" }];
    writeFileSync(stateFile, JSON.stringify(state));
    assert.equal(json(run("--stop")).queued, 1);
    assert.equal(json(run("--once", "--client", "codex")).type, "watch_stopped", "중지된 감시는 GitLab을 조회하지 않는다");
    assert.equal(json(run("--start", "--client", "claude", "--forever")).queued, 1);
    assert.equal(json(run("--status")).expiresAt, null);
    assert.equal(json(run("--queue")).eventId, "9");
    assert.equal(json(run("--ack", "9")).queued, 0);
    writeFileSync(stateFile, "{깨진 상태");
    assert.throws(() => run("--stop"), /손상/);
    assert.equal(readFileSync(stateFile, "utf8"), "{깨진 상태");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Codex 훅은 실제 작업 경로와 하네스 --cwd에서 상태를 읽고 게시 확인을 강제한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmp-gate 한글 #-"));
  const env = { MATTERMOST_MCP_DATA_DIR: dir };
  try {
    execFileSync("git", ["init", "-b", "main", dir], { stdio: "pipe" });
    writeFileSync(join(dir, ".git", "mmp-mr-review.json"), JSON.stringify({ step: "reviewed", iid: 7 }));
    const command = `node "${join(root, "bin", "mr-review.mjs")}" post --cwd "${dir}"`;
    const input = { cwd: root, tool_name: "Bash", tool_input: { command } };
    assert.equal(gateCwd(input), dir);
    const decision = (payload) => json(cli("mr-review.mjs", ["gate"], env, JSON.stringify(payload))).hookSpecificOutput.permissionDecision;
    assert.equal(decision(input), "deny");
    assert.equal(decision({ ...input, tool_input: { command: `${command} --confirmed` } }), "allow");
    assert.equal(decision({ cwd: dir, tool_name: "PowerShell", tool_input: { command: "glab mr approve 7" } }), "deny");
    assert.equal(json(cli("mr-review.mjs", ["status", "--cwd", dir], env)).step, "reviewed");
    assert.equal(gateCwd({ cwd: root, tool_input: { command: "node bin/mr-review.mjs status", workdir: dir } }), dir);
    assert.equal(gateCwd({ cwd: root, tool_input: { command: `cd "${dir}" && glab mr note create 7` } }), dir);
    writeFileSync(join(dir, ".git", "mmp-mr-review.json"), "{손상");
    assert.equal(decision({ cwd: dir, tool_name: "Bash", tool_input: { command: "glab mr note create 7" } }), "deny");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("세션 CLI는 생성 중 식별자를 보존하고 ack·감시 중지 후에도 병합 추적을 유지한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmp-sessions-"));
  const env = { MATTERMOST_MCP_DATA_DIR: dir };
  const stateFile = join(dir, "watch-state.json");
  const targetFile = join(dir, "target.json");
  const preload = join(dir, "glab-stub.cjs");
  const user = { id: 7, username: "self" };
  const target = { state: "opened", author: { username: "author" }, reviewers: [user] };
  const setTarget = (mr) => writeFileSync(targetFile, JSON.stringify(mr));
  const run = (...args) => json(execFileSync(process.execPath, ["--require", preload, join(root, "bin", "mr-watch.mjs"), ...args],
    { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] }));
  try {
    writeFileSync(join(dir, "watch.json"), JSON.stringify({ host: "gitlab.example.com", projects: { "g/r": { workdir: root, jiraBaseUrl: "https://jira.example.com" } } }));
    writeFileSync(preload, `const cp = require('node:child_process'), fs = require('node:fs');
const exec = cp.execFileSync;
cp.execFileSync = (file, args, options) => {
  if (file !== 'glab') return exec(file, args, options);
  if (args[0] !== 'api') throw new Error('Unexpected glab call');
  if (args[1] === 'user') return JSON.stringify({ id: 7, username: 'self' });
  if (args[1].endsWith('/notes/9')) return JSON.stringify({ id: 9, system: false, author: { username: 'author' }, body: '@self 재리뷰 부탁드립니다' });
  return fs.readFileSync(${JSON.stringify(targetFile)}, 'utf8');
};
require('node:module').syncBuiltinESMExports();`);
    setTarget(target);
    writeFileSync(stateFile, JSON.stringify({ since: 1, seen: [42], stopped: true, queue: [{ eventId: "42", todoIds: [42],
      action: "review_requested", project: "g/r", mrUrl: "https://gitlab.example.com/g/r/-/merge_requests/7" }] }));
    const originalState = readFileSync(stateFile, "utf8");
    setTarget({ ...target, reviewers: [{ id: 8, username: "other" }] });
    assert.equal(run("--queue").reviewRequested, false);
    assert.equal(run("--queue").type, "review_ignored");
    assert.throws(() => run("--session-claim", "42"), /로그인 계정 대상/);
    assert.equal(readFileSync(stateFile, "utf8"), originalState, "제외는 기존 큐·세션을 지우지 않는다");
    setTarget({ state: "opened" });
    assert.throws(() => run("--queue"), /확인/);
    assert.throws(() => run("--session-claim", "42"), /확인/);
    assert.equal(readFileSync(stateFile, "utf8"), originalState, "조회 실패도 큐를 보존한다");
    setTarget(target);
    assert.equal(run("--queue").reviewRequested, true);
    assert.equal(run("--session-claim", "42").threadId, null);
    assert.throws(() => run("--session-claim", "42"), /이미 생성/);
    assert.equal(run("--session-bind", "42", "--client-thread-id", "creating").clientThreadId, "creating");
    assert.equal(run("--session-bind", "42", "--thread-id", "ready", "--host-id", "local").threadId, "ready");
    assert.equal(run("--ack", "42").queued, 0);
    assert.equal(run("--sessions").threadId, "ready");
    assert.equal(run("--status").active, false);
    const state = json(readFileSync(stateFile, "utf8"));
    state.queue = [{ eventId: "43", todoIds: [43], action: "mentioned", project: "g/r", mrUrl: "https://gitlab.example.com/g/r/-/merge_requests/7#note_9" }];
    writeFileSync(stateFile, JSON.stringify(state));
    const reused = run("--session-claim", "43");
    assert.equal(reused.reused, true);
    assert.equal(reused.requestEventId, "43");
    assert.equal(reused.threadId, "ready");
    assert.deepEqual(reused.eventIds, ["42", "43"]);
    assert.equal(run("--session-bind", "43", "--thread-id", "ready", "--worktree-path", dir).worktreePath, dir);
    assert.equal(run("--ack", "43").queued, 0);
    assert.equal(json(readFileSync(stateFile, "utf8")).sessions.length, 1);
    const corruptAlias = json(readFileSync(stateFile, "utf8"));
    corruptAlias.sessions[0].eventIds = [null];
    writeFileSync(stateFile, JSON.stringify(corruptAlias));
    assert.throws(() => run("--sessions"), /손상/);
    state.sessions[0].iid = null;
    writeFileSync(stateFile, JSON.stringify(state));
    assert.throws(() => run("--sessions"), /손상/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const catalog of [".agents/plugins", ".claude-plugin"]) {
test(`Codex 설치본은 marketplace 루트 기준으로 설치된다 (${catalog})`, { skip: process.platform !== "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mmp-package 한글 #-"));
  const market = join(dir, catalog, "marketplace.json");
  const quote = (s) => `'${s.replaceAll("'", "''")}'`;
  const installer = join(root, "scripts", "install-codex-plugin.ps1");
  // 설치 외부 효과는 함수로 대체한다. 실제 설치 스크립트의 복사·manifest 처리를 실행한다.
  const script = `function global:npm { $global:LASTEXITCODE=0 }; function global:codex {
    if ($args[0] -eq 'plugin' -and $args[1] -eq 'marketplace' -and $args[2] -eq 'add' -and $args[3] -ne ${quote(dir)}) { throw 'Wrong marketplace root' }
    $global:LASTEXITCODE=0
  }; & ${quote(installer)} -MarketplacePath ${quote(market)}`;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: "pipe" });
    const entry = json(readFileSync(market, "utf8")).plugins[0];
    const installed = join(dir, entry.source.path);
    assert.equal(entry.source.path, "./plugins/mmp");
    const manifest = json(readFileSync(join(installed, ".codex-plugin", "plugin.json"), "utf8"));
    assert.ok(existsSync(join(installed, manifest.hooks)));
    assert.equal(manifest.version, json(readFileSync(join(installed, "package.json"), "utf8")).version);
    assert.equal(manifest.version, json(readFileSync(join(installed, "package-lock.json"), "utf8")).version);
    for (const file of ["bin/mr-review.mjs", "bin/mr-watch.mjs", "bin/bypass-review.mjs", "src/paths.js", "skills/references/codex.md", "skills/references/claude-code.md"]) {
      assert.ok(existsSync(join(installed, file)), file);
    }
    assert.equal(json(execFileSync(process.execPath, [join(installed, "bin", "bypass-review.mjs"), "status"],
      { encoding: "utf8", env: { ...process.env, MATTERMOST_MCP_DATA_DIR: dir } })).bypass, false);
    const command = json(readFileSync(join(installed, manifest.hooks), "utf8")).hooks.PreToolUse[0].hooks[0].command;
    for (const client of ["codex", "claude"]) {
      const hook = execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
        encoding: "utf8", input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "glab mr approve 7" } }),
        env: { ...process.env, PLUGIN_ROOT: client === "codex" ? installed : "", CLAUDE_PLUGIN_ROOT: client === "claude" ? installed : "", MATTERMOST_MCP_DATA_DIR: dir },
        stdio: ["pipe", "pipe", "pipe"],
      });
      assert.equal(json(hook).hookSpecificOutput.permissionDecision, "deny", client);
    }
    assert.throws(() => execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "pipe" }), /already exists/);
    assert.equal(json(readFileSync(market, "utf8")).plugins.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
}

test("Codex 설치는 해석할 수 없는 catalog 위치와 루트 밖 목적지를 복사 전에 거부한다", { skip: process.platform !== "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mmp-reject-"));
  const quote = (s) => `'${s.replaceAll("'", "''")}'`;
  const installer = join(root, "scripts", "install-codex-plugin.ps1");
  const run = (args) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `& ${quote(installer)} ${args}`], { stdio: "pipe" });
  try {
    assert.throws(() => run(`-MarketplacePath ${quote(join(dir, "marketplace.json"))}`), /MarketplacePath must/);
    assert.throws(() => run(`-MarketplacePath ${quote(join(dir, ".agents", "plugins", "marketplace.json"))} -PluginPath ${quote(join(dir, "..", "mmp"))}`), /inside the marketplace root/);
    assert.equal(existsSync(join(dir, "plugins")), false);
    assert.equal(existsSync(join(dir, ".agents")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
