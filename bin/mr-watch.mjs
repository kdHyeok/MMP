#!/usr/bin/env node
// GitLab todos 감시기. 내가 리뷰어로 지정되거나 MR에서 멘션되면 한 줄씩 stdout에 뱉는다.
//
// Mattermost를 보지 않는 이유: GitLab todos는 이미 있는 glab 인증으로 읽히고(새 토큰 0개),
// action_name 필드가 "리뷰 요청인가"를 대신 판정해 주며, target_url이 그대로 /mmp:mr-review 의 입력이 된다.
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { effectiveMode, readState as readBypassState } from "./bypass-review.mjs";
import { resolveDataDir } from "../src/paths.js";

const POLL_MS = 60_000;

// 리뷰 요청이 확실한 것. 판정 없이 바로 리뷰 세션을 띄워도 된다.
export const REVIEW_ACTIONS = new Set(["review_requested", "approval_required"]);
// MR에서 나를 부른 것. 리뷰 요청인지 단순 질문인지는 body를 보고 판단해야 한다.
export const MAYBE_ACTIONS = new Set(["directly_addressed", "mentioned"]);
// assigned 는 보통 "네가 머지해라"지 "리뷰해라"가 아니라서 뺀다.

export class WatchError extends Error {}

// shortcut: 명시적인 한/영 요청만 자동 처리한다. 다른 표현은 사용자가 직접 리뷰를 시작한다.
export function isExplicitReviewRequest(body) {
  const text = String(body ?? "").replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, "")
    .replace(/^\s*>.*$/gm, "").replace(/`[^`\n]*`|"[^"\n]*"|“[^”\n]*”/g, "");
  if (/^\s*(?:#{1,6}\s*)?리뷰\s*(?:결과|완료)/m.test(text)
    || /리뷰[^\n.!?]{0,30}(?:아닙|하지\s*마|불필요|필요\s*없)|(?:do\s+not|don'?t|no\s+need\s+to)\s+(?:re[- ]?)?review/i.test(text)) return false;
  return /(?:재\s*)?리뷰(?:를|도)?\s*(?:다시\s*)?(?:좀\s*)?(?:요청\s*(?:드립니다|합니다|드려요|해요)|부탁\s*(?:드립니다|합니다|드려요|해요)|해\s*(?:주세요|줘|주실|주시겠|줄))|(?:please|could\s+you|can\s+you|would\s+you)\s+(?:re[- ]?)?review\b|\brequesting\s+(?:a\s+|another\s+)?review\b/i.test(text);
}

export function verifyCommentRequest(todo, note, mr) {
  const id = String(todo.target_url ?? "").match(/#note_(\d+)$/)?.[1];
  if (!id || String(note?.id) !== id || note.system !== false || mr?.state !== "opened"
    || !mr.author?.username || note.author?.username !== mr.author.username || !isExplicitReviewRequest(note.body)) return null;
  return { ...todo, body: note.body, author: note.author, reviewRequestVerified: true, requestNoteId: id };
}

function fetchCommentRequest(todo, host) {
  const url = new URL(todo.target_url);
  const match = url.pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)\/?$/);
  const noteId = url.hash.match(/^#note_(\d+)$/)?.[1];
  if (!match || url.host !== host || match[1] !== todo.project?.path_with_namespace || !noteId) return null;
  const endpoint = `projects/${encodeURIComponent(match[1])}/merge_requests/${match[2]}`;
  const get = (path) => JSON.parse(execFileSync("glab", ["api", path, "--hostname", host], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const mr = get(endpoint);
  const note = get(`${endpoint}/notes/${noteId}`);
  if (!mr?.state || !note?.id || mr.message || note.message) throw new WatchError("리뷰 요청의 실제 MR·댓글을 확인하지 못했습니다.");
  return verifyCommentRequest(todo, note, mr);
}

function readJson(path, fallback) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}

// glab 이 실제로 로그인한 호스트를 읽는다. 호스트명을 코드에 박지 않는 이유는 이 저장소가 공개라서다.
// glab auth status 는 다른 호스트가 401이어도 exit 0이고 전부 stderr로 쓴다 — 종료코드가 아니라 출력으로 판정한다.
export function loggedInHosts(authStatus) {
  return [...String(authStatus).matchAll(/Logged in to (\S+)/g)].map((m) => m[1]);
}

function detectHosts() {
  const out = spawnSync("glab", ["auth", "status"], { encoding: "utf8" });
  return loggedInHosts(`${out.stdout ?? ""} ${out.stderr ?? ""}`);
}

// 설정의 host 가 항상 이긴다. 없을 때만 추론하고, 후보가 정확히 하나일 때만 쓴다 —
// 여러 곳에 로그인돼 있으면 어느 쪽을 볼지 우리가 알 수 없고, 틀린 추측은 조용한 401이 된다.
function resolveHost(config, hosts) {
  if (config.host) return config.host;
  const found = hosts();
  if (found.length === 1) return found[0];
  if (found.length === 0) {
    throw new WatchError("glab 이 어느 GitLab 에도 로그인돼 있지 않습니다. `glab auth login --hostname <호스트>` 먼저 실행하거나, 감시 설정에 \"host\" 를 적으세요.");
  }
  throw new WatchError(`glab 이 여러 호스트에 로그인돼 있습니다(${found.join(", ")}). 감시 설정에 \"host\" 로 하나를 지정하세요.`);
}

export function loadConfig(path, hosts = detectHosts) {
  const config = readJson(path, null);
  if (!config) {
    throw new WatchError(`감시 설정이 없습니다: ${path}\n`
      + '{"host":"gitlab.example.com","projects":{"group/repo":{"workdir":"C:/work/repo","jiraBaseUrl":"https://jira.example.com/browse"}}} 형태로 만드세요.');
  }
  // 호스트를 반드시 정한다. 비워두면 glab 이 현재 디렉터리의 remote 로 추론하는데,
  // 감시기는 어디서 돌지 모르므로 조용히 gitlab.com 에 붙어 401이 난다.
  const host = resolveHost(config, hosts);
  const projects = config.projects ?? {};
  for (const [name, entry] of Object.entries(projects)) {
    // 설정 게이트: 작업 폴더와 지라 base URL이 둘 다 있어야 그 프로젝트를 감시한다.
    if (!entry?.workdir || !entry?.jiraBaseUrl) {
      throw new WatchError(`프로젝트 '${name}' 설정에 workdir 와 jiraBaseUrl 이 모두 필요합니다.`);
    }
    if (!existsSync(entry.workdir)) throw new WatchError(`프로젝트 '${name}'의 workdir 가 없습니다: ${entry.workdir}`);
  }
  if (Object.keys(projects).length === 0) throw new WatchError("감시할 프로젝트가 하나도 설정되지 않았습니다.");
  return { host, projects };
}

// 어떤 todo를 리뷰 작업으로 흘려보낼지 고른다. 멘션은 실제 댓글 조회 결과를 주입한다.
export function selectTodos(todos, { projects, seen, since, resolveComment }) {
  const picked = [];
  for (let todo of Array.isArray(todos) ? todos : []) {
    if (todo?.target_type !== "MergeRequest") continue;
    const action = todo.action_name;
    const certain = REVIEW_ACTIONS.has(action);
    if (!certain && !MAYBE_ACTIONS.has(action)) continue;

    const project = todo.project?.path_with_namespace;
    if (!project || !projects[project]) continue; // 설정되지 않은 프로젝트는 건드리지 않는다
    if (seen.has(todo.id)) continue;
    // 감시 시작 이전에 쌓여 있던 todo는 재생하지 않는다. 부팅 때 수십 건이 쏟아지는 게 놓치는 것보다 나쁘다.
    if (since && !(Date.parse(todo.created_at) > since)) continue;
    if (!certain) {
      todo = resolveComment ? resolveComment(todo) : todo;
      if (!todo?.reviewRequestVerified || !isExplicitReviewRequest(todo.body)) continue;
    }

    picked.push({
      todoId: todo.id,
      action,
      certain,
      project,
      iid: todo.target?.iid ?? null,
      mrUrl: todo.target_url,
      title: todo.target?.title ?? null,
      authorName: todo.author?.name ?? null,
      authorUsername: todo.author?.username ?? null,
      createdAt: todo.created_at,
      body: todo.body ?? "",
      requestNoteId: todo.requestNoteId ?? null,
      workdir: projects[project].workdir,
      jiraBaseUrl: projects[project].jiraBaseUrl,
    });
  }
  picked.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  // 같은 폴링 배치에서 한 MR에 여러 todo가 오는 일이 흔하다(리뷰어 지정 + 같은 댓글의 멘션).
  // 한 MR당 하나로 합친다. 확정 액션이 있으면 그것을 남겨 판단 단계를 건너뛴다.
  // 배치를 넘어선 중복은 합치지 않는다 — 수정 후 2차 리뷰 요청은 별개 사건이다.
  const byMr = new Map();
  for (const item of picked) {
    const key = `${item.project}#${item.iid}`;
    const kept = byMr.get(key);
    if (!kept) {
      byMr.set(key, { ...item, todoIds: [item.todoId] });
      continue;
    }
    // 확정 액션이 나중에 오면 그쪽으로 교체한다. 처리한 todo id는 전부 들고 간다.
    const todoIds = [...kept.todoIds, item.todoId];
    byMr.set(key, kept.certain || !item.certain ? { ...kept, todoIds } : { ...item, todoIds });
  }
  return [...byMr.values()];
}

function fetchTodos(host) {
  let out;
  try {
    out = execFileSync("glab", ["api", "todos?state=pending&per_page=100", "--paginate"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GITLAB_HOST: host },
    });
  } catch (error) {
    throw new WatchError(`glab api 호출 실패: ${String(error?.stderr ?? error?.message).trim().slice(0, 300)}`);
  }
  let todos;
  try { todos = JSON.parse(out); } catch {
    throw new WatchError("glab이 todos에 대해 JSON을 반환하지 않았습니다.");
  }
  if (!Array.isArray(todos)) throw new WatchError("glab의 todos 응답은 배열이어야 합니다.");
  return todos;
}

function emit(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export function acquireWatchLock(path) {
  let fd;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = readJson(path, null)?.pid;
    if (!Number.isInteger(owner) || owner <= 0) throw new WatchError("감시 잠금이 불완전합니다. 다른 실행이 끝난 뒤 잠금 파일을 확인하세요.");
    let alive = true;
    try { process.kill(owner, 0); } catch (probe) { if (probe.code === "ESRCH") alive = false; }
    if (alive) throw new WatchError(`다른 감시 작업이 실행 중입니다(pid ${owner}).`);
    // 자동 삭제는 동시에 잠금을 복구하는 두 실행이 새 잠금을 지울 수 있다.
    throw new WatchError(`종료된 감시의 잠금이 남았습니다(pid ${owner}). 실행이 없는지 확인한 뒤 이 파일만 제거하세요: ${path}`);
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  return () => { closeSync(fd); unlinkSync(path); };
}

function saveState(path, state) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function readWatchState(path) {
  const state = readJson(path, null);
  if (existsSync(path) && (!state || !Array.isArray(state.seen) || !Number.isFinite(state.since)
    || (state.sessions !== undefined && (!Array.isArray(state.sessions)
      || state.sessions.some((item) => !item || typeof item.eventId !== "string" || typeof item.mrUrl !== "string"
        || typeof item.host !== "string" || typeof item.project !== "string" || !Number.isInteger(item.iid) || item.iid <= 0
        || (item.eventIds !== undefined && (!Array.isArray(item.eventIds) || !item.eventIds.includes(item.eventId)
          || item.eventIds.some((id) => typeof id !== "string" || !id))))))
    || (state.expiresAt != null && !Number.isFinite(state.expiresAt))
    || (state.queue !== undefined && (!Array.isArray(state.queue)
      || state.queue.some((item) => !item || typeof item.eventId !== "string" || !Array.isArray(item.todoIds)))))) {
    throw new WatchError("감시 상태 파일이 손상됐습니다. 기존 파일을 확인한 뒤 복구하세요.");
  }
  return state;
}

function withState(paths, update) {
  const release = acquireWatchLock(paths.stateLock);
  try {
    const state = readWatchState(paths.state);
    const next = update(state);
    saveState(paths.state, next);
    return next;
  } finally { release(); }
}

export function watchActive(state, now = Date.now()) {
  return Boolean(state && !state.stopped && (!state.expiresAt || now < state.expiresAt));
}

export function enqueueTodos(state, todos, projects, resolveComment) {
  const queue = state.queue ?? [];
  // pending에 남은 제외/처리 이벤트는 수에 상관없이 기억한다. GitLab에서 사라진 것만 정리한다.
  const pendingIds = new Set(todos.map((todo) => todo.id));
  const seen = new Set([...state.seen.filter((id) => pendingIds.has(id)), ...queue.flatMap((item) => item.todoIds)]);
  const picked = selectTodos(todos, { projects, seen, since: state.since, resolveComment });
  for (const item of picked) for (const id of item.todoIds) seen.add(id);
  return { ...state, seen: [...seen],
    queue: [...queue, ...picked.map((item) => ({ ...item, eventId: String(item.todoId) }))] };
}

export function acknowledge(state, id) {
  if (!state || !(state.queue ?? []).some((item) => item.eventId === id)) {
    throw new WatchError(`대기 중인 이벤트가 없습니다: ${id}`);
  }
  return { ...state, queue: state.queue.filter((item) => item.eventId !== id) };
}

// 큐 ack와 별개로 세션을 보존한다. MR 병합은 리뷰 완료보다 늦게 일어날 수 있다.
export function sessionForEvent(state, id) {
  return state?.sessions?.find((item) => item.eventId === id || item.eventIds?.includes(id));
}

export function claimSession(state, id) {
  const event = state?.queue?.find((item) => item.eventId === id);
  if (!event) throw new WatchError(`대기 중인 이벤트가 없습니다: ${id}`);
  if (sessionForEvent(state, id)) throw new WatchError("이미 생성 요청한 세션입니다. --sessions로 확인하고 기존 세션을 연결하세요. 중복 생성하지 않습니다.");
  const url = new URL(event.mrUrl);
  const match = url.pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)\/?$/);
  if (!match || !["https:", "http:"].includes(url.protocol) || match[1] !== event.project) throw new WatchError("리뷰 이벤트의 MR 링크·프로젝트가 일치하지 않습니다.");
  const sameMr = (state.sessions ?? []).filter((item) => item.host === url.host && item.project === event.project && item.iid === Number(match[2]));
  // 이전 버전의 중복 기록은 지우지 않는다. 새 이벤트는 최초 연결 채팅으로만 모은다.
  const existing = sameMr.find((item) => !item.archivedAt && item.threadId) ?? sameMr.find((item) => !item.archivedAt);
  if (existing) return { ...state, sessions: state.sessions.map((item) => item !== existing ? item : {
    ...item, eventIds: [...(item.eventIds ?? [item.eventId]), id] }) };
  if (sameMr.length) throw new WatchError("이미 보관된 MR 세션입니다. 기존 세션 복원을 확인하세요. 새 세션을 만들지 않습니다.");
  return { ...state, sessions: [...(state.sessions ?? []), { eventId: id, mrUrl: event.mrUrl, host: url.host,
    project: event.project, iid: Number(match[2]), claimedAt: new Date().toISOString(),
    threadId: null, clientThreadId: null, hostId: null, archivedAt: null }] };
}

export function bindSession(state, id, { threadId, clientThreadId, hostId, worktreePath }) {
  const session = sessionForEvent(state, id);
  if (!session) throw new WatchError("먼저 --session-claim으로 생성 의도를 저장하세요.");
  if ((!threadId && !clientThreadId) || [threadId, clientThreadId, hostId].some((value) => value !== undefined && (typeof value !== "string" || !value.trim() || value.startsWith("--")))) {
    throw new WatchError("도구가 반환한 --thread-id 또는 --client-thread-id가 필요합니다.");
  }
  if ((session.threadId && threadId && session.threadId !== threadId)
    || (session.clientThreadId && clientThreadId && session.clientThreadId !== clientThreadId)
    || (session.hostId && hostId && session.hostId !== hostId)) throw new WatchError("이미 연결된 세션을 다른 세션으로 바꿀 수 없습니다.");
  if (worktreePath !== undefined && (typeof worktreePath !== "string" || !isAbsolute(worktreePath)
    || (session.worktreePath && resolve(session.worktreePath) !== resolve(worktreePath)))) throw new WatchError("기존 워크트리와 같은 절대경로만 연결할 수 있습니다.");
  return { ...state, sessions: state.sessions.map((item) => item !== session ? item : { ...item,
    threadId: threadId ?? item.threadId, clientThreadId: clientThreadId ?? item.clientThreadId,
    hostId: hostId ?? item.hostId, ...(worktreePath ? { worktreePath } : {}) }) };
}

function fetchSessionMr(session) {
  const out = execFileSync("glab", ["api", `projects/${encodeURIComponent(session.project)}/merge_requests/${session.iid}`,
    "--hostname", session.host], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const mr = JSON.parse(out);
  if (!["opened", "closed", "merged", "locked"].includes(mr?.state)) throw new WatchError("GitLab MR 상태를 확인하지 못했습니다.");
  return mr;
}

export function sessionStatus(session, fetch = fetchSessionMr) {
  const mr = fetch(session);
  return { ...session, mrState: mr.state, archiveEligible: mr.state === "merged" && Boolean(session.threadId) && !session.archivedAt };
}

export function markSessionArchived(state, id, fetch = fetchSessionMr) {
  const session = sessionForEvent(state, id);
  if (!session || !sessionStatus(session, fetch).archiveEligible) throw new WatchError("실제 MR 병합과 연결된 채팅이 확인된 세션만 보관 기록할 수 있습니다.");
  return { ...state, sessions: state.sessions.map((item) => item !== session ? item : { ...item, archivedAt: new Date().toISOString() }) };
}

export function reviewEvent(item, host, fetch = fetchCommentRequest) {
  if (REVIEW_ACTIONS.has(item.action)) return { ...item, reviewRequested: true };
  const todo = MAYBE_ACTIONS.has(item.action) ? fetch({ target_url: item.mrUrl,
    project: { path_with_namespace: item.project } }, host) : null;
  return { ...item, body: todo?.body ?? item.body, reviewRequested: Boolean(todo?.reviewRequestVerified),
    ...(todo ? { requestNoteId: todo.requestNoteId } : { type: "review_ignored", reason: "MR 작성자의 명시적 리뷰 요청 댓글이 아닙니다." }) };
}

export function tick(paths, client, fetch = fetchTodos, resolveComment = fetchCommentRequest) {
  const before = readWatchState(paths.state);
  if (before?.client && before.client !== client) throw new WatchError(`감시는 ${before.client}에서 시작했습니다. 먼저 중지하고 ${client}에서 다시 시작하세요.`);
  if (before && !watchActive(before)) return { state: before, picked: 0, pending: 0 };
  const { host, projects } = loadConfig(paths.config);
  const todos = fetch(host);
  let picked = 0;
  const state = withState(paths, (old) => {
    const previous = { since: Date.now(), seen: [], queue: [], ...old, client: old?.client ?? client };
    if (previous.client && previous.client !== client) throw new WatchError(`감시는 ${previous.client}에서 시작했습니다. 먼저 중지하고 ${client}에서 다시 시작하세요.`);
    if (!watchActive(previous)) return previous;
    const next = enqueueTodos(previous, todos, projects, (todo) => resolveComment(todo, host));
    picked = next.queue.length - (previous.queue?.length ?? 0);
    return next;
  });
  // 디스크에 먼저 저장한다. 세션이 중단돼도 ack 전까지 다음 실행에서 다시 받는다.
  return { state, picked, pending: todos.length };
}

// 감시 시작 전에 이미 쌓여 있는 리뷰 요청을 보여준다.
// 상태를 건드리지 않으므로, 여기서 본 것이 나중에 이벤트로 또 오지는 않는다(since가 그것을 막는다).
function listPending(paths) {
  const { host, projects } = loadConfig(paths.config);
  return selectTodos(fetchTodos(host), { projects, seen: new Set(), since: 0, resolveComment: (todo) => fetchCommentRequest(todo, host) })
    .map(({ iid, project, mrUrl, title, authorName, action, certain, createdAt, requestNoteId }) =>
      ({ iid, project, mrUrl, title, authorName, action, certain, createdAt, requestNoteId, reviewRequested: true }));
}

async function main(argv) {
  const dir = resolveDataDir();
  mkdirSync(dir, { recursive: true });
  const paths = { dir, config: join(dir, "watch.json"), state: join(dir, "watch-state.json"),
    stateLock: join(dir, "watch-state.lock"), runLock: join(dir, "watch-run.lock") };
  const value = (flag) => argv[argv.indexOf(flag) + 1];
  const client = argv.includes("--client") ? value("--client") : "claude";
  if (!["claude", "codex"].includes(client)) throw new WatchError("--client는 claude 또는 codex여야 합니다.");

  if (argv.includes("--pending")) {
    process.stdout.write(`${JSON.stringify(listPending(paths), null, 2)}\n`);
    return;
  }

  if (argv.includes("--status")) {
    const state = readWatchState(paths.state);
    return emit({ active: watchActive(state), client: state?.client ?? null,
      expiresAt: state?.expiresAt ?? null, queued: state?.queue?.length ?? 0 });
  }
  if (argv.includes("--queue")) {
    const items = readWatchState(paths.state)?.queue ?? [];
    const host = items.some((item) => MAYBE_ACTIONS.has(item.action)) ? loadConfig(paths.config).host : null;
    for (const item of items) emit({ ...reviewEvent(item, host), mode: effectiveMode(readBypassState()) });
    return;
  }
  if (argv.includes("--sessions")) {
    for (const session of readWatchState(paths.state)?.sessions ?? []) {
      if (!argv.includes("--check") || session.archivedAt) { emit(session); continue; }
      try { emit(sessionStatus(session)); }
      catch (error) { emit({ ...session, archiveEligible: false, error: String(error.message).slice(0, 300) }); }
    }
    return;
  }
  for (const action of ["--session-claim", "--session-bind", "--session-archived"]) {
    if (!argv.includes(action)) continue;
    const id = value(action);
    if (!id || id.startsWith("--")) throw new WatchError(`${action}에는 eventId가 필요합니다.`);
    const optional = (flag) => argv.includes(flag) ? value(flag) : undefined;
    const state = withState(paths, (old) => action === "--session-claim" ? claimSession(old, id)
      : action === "--session-archived" ? markSessionArchived(old, id)
        : bindSession(old, id, { threadId: optional("--thread-id"), clientThreadId: optional("--client-thread-id"), hostId: optional("--host-id"), worktreePath: optional("--worktree-path") }));
    const session = sessionForEvent(state, id);
    return emit({ ...session, requestEventId: id, reused: session.eventId !== id });
  }
  if (argv.includes("--ack")) {
    const state = withState(paths, (old) => acknowledge(old, value("--ack")));
    return emit({ acknowledged: value("--ack"), queued: state.queue.length });
  }
  if (argv.includes("--stop")) {
    const state = withState(paths, (old) => ({ since: Date.now(), seen: [], ...old, stopped: true }));
    return emit({ stopped: true, queued: state.queue?.length ?? 0 });
  }
  if (argv.includes("--start")) {
    const hours = argv.includes("--hours") ? Number(value("--hours")) : 6;
    if (!Number.isFinite(hours) || hours <= 0) throw new WatchError("--hours에는 양수를 지정하세요.");
    loadConfig(paths.config);
    const state = withState(paths, (old) => {
      if (watchActive(old) && old.client && old.client !== client) throw new WatchError(`이미 ${old.client} 감시가 활성화돼 있습니다. 먼저 중지하세요.`);
      return { since: Date.now(), seen: [], queue: [], ...old, client, stopped: false,
        expiresAt: argv.includes("--forever") ? null : Date.now() + hours * 3_600_000 };
    });
    return emit({ active: true, client, expiresAt: state.expiresAt, queued: state.queue.length });
  }

  const release = acquireWatchLock(paths.runLock);
  try {
    const once = argv.includes("--once");
    for (;;) {
      const before = readWatchState(paths.state);
      if (before && !watchActive(before)) { emit({ type: "watch_stopped", queued: before.queue?.length ?? 0 }); return; }
      try {
        const { state, picked, pending } = tick(paths, client);
        const host = (state.queue ?? []).some((item) => MAYBE_ACTIONS.has(item.action)) ? loadConfig(paths.config).host : null;
        for (const item of state.queue ?? []) emit({ ...reviewEvent(item, host), mode: effectiveMode(readBypassState()) });
        process.stderr.write(`[${new Date().toISOString()}] pending=${pending} 신규=${picked}\n`);
      } catch (error) {
        if (!(error instanceof WatchError)) throw error;
        emit({ type: "watch_error", message: error.message, at: new Date().toISOString() });
        if (once) process.exitCode = 1;
      }
      if (once) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally { release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`실패: ${error.message}\n`);
    process.exit(1);
  });
}
