// REST v3 handler for github-core-clone-01. Stdlib only, synchronous, deterministic.
// Shared helpers (global ids, git commit/tree building, issue/PR creation, squash
// merge) live here and are imported by graphql.ts and mcp.ts so all surfaces share
// one store and one set of semantics.

import type { Issue, PullFile, PullRequest, Repo, Store } from './store.ts';

export interface Ctx {
  store: Store;
  token: string;
  viewerLogin: string;
  authed: boolean;
}

export interface HandlerResult {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

let reqCounter = 0;
export function nextRequestId(prefix: string): string {
  reqCounter += 1;
  return `${prefix}-${reqCounter}`;
}

export function jsonReply(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
  prefix = 'rest',
): HandlerResult {
  const text = `${JSON.stringify(body)}\n`;
  return {
    status,
    contentType: 'application/json',
    body: Buffer.from(text, 'utf8'),
    headers: { 'X-GitHub-Request-Id': nextRequestId(prefix), 'X-OAuth-Scopes': 'repo, read:org', ...extraHeaders },
  };
}

export function errorReply(status: number, message: string, prefix = 'rest'): HandlerResult {
  return jsonReply(status, { message }, {}, prefix);
}

export function emptyReply(status: number, prefix = 'rest'): HandlerResult {
  return {
    status,
    contentType: 'application/json',
    body: Buffer.alloc(0),
    headers: { 'X-GitHub-Request-Id': nextRequestId(prefix), 'X-OAuth-Scopes': 'repo, read:org' },
  };
}

// ---------------------------------------------------------------- global ids
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string): string | null => {
  try {
    return Buffer.from(s, 'base64url').toString('utf8');
  } catch {
    return null;
  }
};

export function repoGlobalId(repo: Repo): string {
  return b64(`R:${repo.id}`);
}
export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64(`I:${repo.id}:${issue.number}`);
}
export function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return b64(`P:${repo.id}:${pull.number}`);
}
export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return b64(`C:${repo.id}:${issueNumber}:${commentId}`);
}

export interface ResolvedGlobalId {
  kind: 'repo' | 'issue' | 'pull' | 'comment';
  repoId: number;
  number?: number;
  commentId?: number;
}

export function resolveGlobalId(id: string): ResolvedGlobalId | null {
  const decoded = unb64(id);
  if (decoded === null) return null;
  const parts = decoded.split(':');
  if (parts.length < 2) return null;
  const kind = parts[0];
  const repoId = Number(parts[1]);
  if (!Number.isInteger(repoId) || repoId < 1) return null;
  if (kind === 'R' && parts.length === 2) return { kind: 'repo', repoId };
  if (kind === 'I' && parts.length === 3) return { kind: 'issue', repoId, number: Number(parts[2]) };
  if (kind === 'P' && parts.length === 3) return { kind: 'pull', repoId, number: Number(parts[2]) };
  if (kind === 'C' && parts.length === 4) {
    return { kind: 'comment', repoId, number: Number(parts[2]), commentId: Number(parts[3]) };
  }
  return null;
}

export function findRepoById(store: Store, repoId: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === repoId) return repo;
  return undefined;
}

// ---------------------------------------------------------------- git helpers
export function epochSeconds(store: Store): number {
  return Math.floor(Date.parse(store.baseIso()) / 1000);
}

export function authorLine(store: Store, login: string): string {
  return `${login === 'adaiversen' ? 'ada iversen' : login} <${login}@example.invalid> ${epochSeconds(store)} +0000`;
}

export function createCommit(
  store: Store,
  repo: Repo,
  treeSha: string,
  parents: string[],
  message: string,
): string {
  const line = authorLine(store, repo.owner);
  const header = [`tree ${treeSha}`, ...parents.map((p) => `parent ${p}`), `author ${line}`, `committer ${line}`].join('\n');
  const data = Buffer.from(`${header}\n\n${message}`, 'utf8');
  return store.putObject(repo, 'commit', data);
}

/** Build (and store) the tree for a flat path -> {mode, sha} map; returns root tree sha. */
export function buildTreeFromFlat(
  store: Store,
  repo: Repo,
  flat: Map<string, { mode: string; sha: string }>,
): string {
  const build = (prefix: string): string => {
    const entries: { mode: string; name: string; sha: string }[] = [];
    const dirs = new Map<string, Map<string, { mode: string; sha: string }>>();
    for (const [path, entry] of flat) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ mode: entry.mode, name: rest, sha: entry.sha });
      } else {
        const dir = rest.slice(0, slash);
        let sub = dirs.get(dir);
        if (sub === undefined) {
          sub = new Map();
          dirs.set(dir, sub);
        }
        sub.set(path, entry);
      }
    }
    for (const [dir, sub] of dirs) {
      // Rebuild the subtree with paths relative to that directory.
      const subFlat = new Map<string, { mode: string; sha: string }>();
      for (const [p, e] of sub) subFlat.set(p.slice(prefix === '' ? 0 : prefix.length + 1), e);
      // build() expects full paths under `prefix`; emulate by building from subFlat
      // with a synthetic prefix: simplest is a dedicated recursive helper below.
      void subFlat;
      entries.push({ mode: '40000', name: dir, sha: buildDir(store, repo, flat, prefix === '' ? dir : `${prefix}/${dir}`) });
    }
    return store.putObject(repo, 'tree', store.buildTree(entries));
  };
  return build('');
}

function buildDir(
  store: Store,
  repo: Repo,
  flat: Map<string, { mode: string; sha: string }>,
  dirPrefix: string,
): string {
  const entries: { mode: string; name: string; sha: string }[] = [];
  const subdirs = new Set<string>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(`${dirPrefix}/`)) continue;
    const rest = path.slice(dirPrefix.length + 1);
    const slash = rest.indexOf('/');
    if (slash < 0) entries.push({ mode: entry.mode, name: rest, sha: entry.sha });
    else subdirs.add(rest.slice(0, slash));
  }
  for (const dir of subdirs) {
    entries.push({ mode: '40000', name: dir, sha: buildDir(store, repo, flat, `${dirPrefix}/${dir}`) });
  }
  return store.putObject(repo, 'tree', store.buildTree(entries));
}

/** Map of directory path -> tree sha for a flat tree ('' = root). */
export function treeShaMap(
  store: Store,
  repo: Repo,
  flat: Map<string, { mode: string; sha: string }>,
): Map<string, string> {
  const out = new Map<string, string>();
  out.set('', buildTreeFromFlat(store, repo, flat));
  const dirs = new Set<string>();
  for (const path of flat.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const dir of dirs) out.set(dir, buildDir(store, repo, flat, dir));
  return out;
}

export function refTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

export function resolveRefTip(store: Store, repo: Repo, ref: string): string | undefined {
  // Branch name, full ref, or a commit sha.
  if (ref.startsWith('refs/heads/')) return repo.refs.get(ref);
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  const obj = repo.objects.get(ref);
  if (obj !== undefined && obj.type === 'commit') return ref;
  return undefined;
}

export function commitChain(store: Store, repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(cur);
    const parents = store.parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

export function findMergeBase(store: Store, repo: Repo, a: string, b: string): string | null {
  const aAnc = store.ancestors(repo, a);
  // BFS from b following parents in order; first ancestor also in a's set wins.
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (aAnc.has(cur)) return cur;
    const obj = repo.objects.get(cur);
    if (obj !== undefined && obj.type === 'commit') {
      for (const p of store.parseCommit(obj.data).parents) queue.push(p);
    }
  }
  return null;
}

function lineCount(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

export function computePullFiles(store: Store, repo: Repo, headSha: string, baseSha: string): PullFile[] {
  const headFlat = store.flattenTree(repo, headSha);
  const baseFlat = store.flattenTree(repo, baseSha);
  const files: PullFile[] = [];
  const all = new Set<string>([...headFlat.keys(), ...baseFlat.keys()]);
  for (const path of [...all].sort()) {
    const h = headFlat.get(path);
    const b = baseFlat.get(path);
    if (h !== undefined && b !== undefined && h.sha === b.sha) continue;
    if (h !== undefined && b === undefined) {
      const blob = repo.objects.get(h.sha);
      const additions = blob !== undefined ? lineCount(blob.data) : 0;
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, sha: h.sha });
    } else if (h === undefined && b !== undefined) {
      const blob = repo.objects.get(b.sha);
      const deletions = blob !== undefined ? lineCount(blob.data) : 0;
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, sha: b.sha });
    } else if (h !== undefined && b !== undefined) {
      const hb = repo.objects.get(h.sha);
      const bb = repo.objects.get(b.sha);
      const additions = hb !== undefined ? lineCount(hb.data) : 0;
      const deletions = bb !== undefined ? lineCount(bb.data) : 0;
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, sha: h.sha });
    }
  }
  return files;
}

export function checkConflict(store: Store, repo: Repo, headSha: string, baseSha: string): boolean {
  const base = findMergeBase(store, repo, headSha, baseSha);
  if (base === null) return false;
  const baseFlat = store.flattenTree(repo, base);
  const headFlat = store.flattenTree(repo, headSha);
  const curFlat = store.flattenTree(repo, baseSha);
  const all = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...curFlat.keys()]);
  for (const path of all) {
    const b = baseFlat.get(path)?.sha ?? null;
    const h = headFlat.get(path)?.sha ?? null;
    const c = curFlat.get(path)?.sha ?? null;
    const headChanged = h !== b;
    const baseChanged = c !== b;
    if (headChanged && baseChanged && h !== c) return true;
  }
  return false;
}

// ---------------------------------------------------------------- object JSON
export function repoJson(ctx: Ctx, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User', avatar_url: '', html_url: `https://github.com/${repo.owner}` },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    homepage: null,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: 0,
    node_id: b64(`L:${repo.id}:${name}`),
    name,
    color: label?.color ?? 'ffffff',
    description: label?.description ?? '',
    default: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
  };
}

export function issueJson(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: issue.user, id: 1000, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
  };
}

const mergedAtMap = new Map<string, string>();
export function getMergedAt(repo: Repo, number: number): string | null {
  return mergedAtMap.get(`${repo.id}:${number}`) ?? null;
}
function setMergedAt(repo: Repo, number: number, at: string): void {
  mergedAtMap.set(`${repo.id}:${number}`, at);
}

export function pullJson(ctx: Ctx, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const mergedAt = getMergedAt(repo, pull.number);
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeable ? 'clean' : 'dirty',
    merged_at: mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner, id: 1000 } },
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner, id: 1000 } },
    },
    user: { login: pull.user, id: 1000, type: 'User' },
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    labels: [],
    milestone: null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: pull.files.reduce((s, f) => s + f.additions, 0),
    deletions: pull.files.reduce((s, f) => s + f.deletions, 0),
    changed_files: pull.files.length,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
  };
}

export function commentJson(ctx: Ctx, repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo, issue.number, comment.id),
    body: comment.body,
    user: { login: comment.user, id: 1000, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

// ---------------------------------------------------------------- shared ops
export function createIssueInStore(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  labelNames: string[],
): { issue: Issue } | { error: string } {
  for (const name of labelNames) {
    if (!repo.labels.has(name)) return { error: `Label '${name}' does not exist` };
  }
  const now = store.nowIso();
  const issue: Issue = {
    id: store.nextIssueId++,
    number: repo.nextIssue++,
    title,
    body,
    state: 'open',
    labels: [...labelNames],
    user: store ? repo.owner : repo.owner,
    createdAt: now,
    updatedAt: now,
    comments: [],
  };
  repo.issues.set(issue.number, issue);
  return { issue };
}

export function addCommentInStore(store: Store, repo: Repo, issue: Issue, body: string): Issue['comments'][number] {
  const now = store.nowIso();
  const comment: Issue['comments'][number] = {
    id: repo.nextCommentId++,
    body,
    user: repo.owner,
    createdAt: now,
    updatedAt: now,
  };
  issue.comments.push(comment);
  return comment;
}

export function normalizeBranchRef(ref: string, owner: string): string {
  let r = ref.trim();
  if (r.startsWith('refs/heads/')) r = r.slice('refs/heads/'.length);
  const colon = r.indexOf(':');
  if (colon >= 0) r = r.slice(colon + 1);
  void owner;
  return r;
}

export function createPullInStore(
  store: Store,
  repo: Repo,
  headRaw: string,
  baseRaw: string,
  title: string,
  body: string,
): { pull: PullRequest } | { error: string } {
  const head = normalizeBranchRef(headRaw, repo.owner);
  const base = normalizeBranchRef(baseRaw, repo.owner);
  const headSha = refTip(repo, head);
  if (headSha === undefined) return { error: `Head branch '${head}' does not exist` };
  const baseSha = refTip(repo, base);
  if (baseSha === undefined) return { error: `Base branch '${base}' does not exist` };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head) {
      return { error: `A pull request already exists for head branch '${head}'` };
    }
  }
  const now = store.nowIso();
  const files = computePullFiles(store, repo, headSha, baseSha);
  const pull: PullRequest = {
    id: store.nextPullId++,
    number: repo.nextPull++,
    title,
    body,
    state: 'open',
    merged: false,
    mergeable: !checkConflict(store, repo, headSha, baseSha),
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    mergeCommitSha: null,
    user: repo.owner,
    createdAt: now,
    updatedAt: now,
    files,
    conflicted: checkConflict(store, repo, headSha, baseSha),
  };
  pull.mergeable = !pull.conflicted;
  repo.pulls.set(pull.number, pull);
  return { pull };
}

export function mergePullInStore(
  store: Store,
  repo: Repo,
  pull: PullRequest,
): { sha: string } | { error: 'conflict' | 'not-found'; message: string } {
  if (pull.merged && pull.mergeCommitSha !== null) return { sha: pull.mergeCommitSha };
  const baseTip = refTip(repo, pull.baseRef);
  if (baseTip === undefined) return { error: 'not-found', message: 'Base branch does not exist' };
  const headTip = refTip(repo, pull.headRef);
  if (headTip === undefined) return { error: 'not-found', message: 'Head branch does not exist' };
  if (checkConflict(store, repo, headTip, baseTip)) {
    pull.conflicted = true;
    pull.mergeable = false;
    return { error: 'conflict', message: 'Merge conflict: head and base both changed the same file' };
  }
  const headObj = repo.objects.get(headTip);
  if (headObj === undefined || headObj.type !== 'commit') {
    return { error: 'not-found', message: 'Head commit does not exist' };
  }
  const treeSha = store.parseCommit(headObj.data).tree;
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n`;
  const sha = createCommit(store, repo, treeSha, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.updatedAt = store.nowIso();
  setMergedAt(repo, pull.number, pull.updatedAt);
  return { sha };
}

// ---------------------------------------------------------------- REST handler
function parseJsonBody(body: Buffer | null): { ok: true; value: unknown } | { ok: false } {
  if (body === null || body.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; perPage: number; pageNum: number; totalPages: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.floor(perPageRaw) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const pageNum = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), perPage, pageNum, totalPages };
}

function linkHeader(baseUrl: string, path: string, query: URLSearchParams, pageNum: number, perPage: number, totalPages: number): string {
  const mk = (page: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(page));
    return `${baseUrl}${path}?${q.toString()}`;
  };
  const parts: string[] = [];
  if (pageNum < totalPages) parts.push(`<${mk(pageNum + 1)}>; rel="next"`);
  if (pageNum > 1) parts.push(`<${mk(pageNum - 1)}>; rel="prev"`);
  if (totalPages > 1) {
    parts.push(`<${mk(1)}>; rel="first"`);
    parts.push(`<${mk(totalPages)}>; rel="last"`);
  }
  return parts.join(', ');
}

function baseUrlOf(headers: Record<string, string | undefined>): string {
  const host = headers['host'] ?? headers['Host'];
  if (host !== undefined && host !== '') return `http://${host}`;
  return 'http://localhost';
}

function decodeSeg(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function parseAuthorLine(line: string): { name: string; email: string; date: string } {
  const m = /^(.*) <([^>]*)> (\d+) \+0000$/.exec(line);
  if (m === null) return { name: line, email: '', date: '' };
  const epoch = Number(m[3]);
  return { name: m[1] as string, email: m[2] as string, date: new Date(epoch * 1000).toISOString().replace('.000Z', 'Z') };
}

export function handleRest(
  ctx: Ctx,
  method: string,
  path: string,
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer | null,
): HandlerResult | null {
  const { store } = ctx;
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return null;
  const rest = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
  const segs = rest === '' ? [] : rest.split('/').map(decodeSeg);

  if (!ctx.authed) return errorReply(401, 'Requires authentication');

  const parsed = parseJsonBody(body);
  if (!parsed.ok) return errorReply(400, 'Malformed JSON in request body');
  const jsonBody = parsed.value;
  const bodyRec = asRecord(jsonBody);

  // API root
  if (segs.length === 0) {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    return jsonReply(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' });
  }

  // meta
  if (segs.length === 1 && segs[0] === 'meta') {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    return jsonReply(200, { installed_version: '1.0.0' });
  }

  // rate_limit (referenced by the root body)
  if (segs.length === 1 && segs[0] === 'rate_limit') {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    return jsonReply(200, {
      resources: { core: { limit: 5000, remaining: 5000, reset: Math.floor(Date.parse(store.baseIso()) / 1000) + 3600, used: 0 } },
      rate: { limit: 5000, remaining: 5000, reset: Math.floor(Date.parse(store.baseIso()) / 1000) + 3600, used: 0 },
    });
  }

  // /user and /user/repos
  if (segs[0] === 'user') {
    if (segs.length === 1) {
      if (method !== 'GET') return errorReply(404, 'Not Found');
      return jsonReply(200, {
        login: ctx.viewerLogin,
        id: 1000,
        node_id: b64(`U:1000`),
        name: 'ada iversen',
        email: `${ctx.viewerLogin}@example.invalid`,
        type: 'User',
        site_admin: false,
        html_url: `https://github.com/${ctx.viewerLogin}`,
        url: '/api/v3/user',
        avatar_url: '',
        created_at: store.baseIso(),
        updated_at: store.baseIso(),
      });
    }
    if (segs.length === 2 && segs[1] === 'repos') {
      if (method === 'GET') {
        const repos = store.reposOf(ctx.viewerLogin);
        const { page, perPage, pageNum, totalPages } = paginate(repos, query);
        const extra: Record<string, string> = {};
        const link = linkHeader(baseUrlOf(headers), path, query, pageNum, perPage, totalPages);
        if (link !== '') extra['Link'] = link;
        return jsonReply(200, page.map((r) => repoJson(ctx, r)), extra);
      }
      if (method === 'POST') {
        const name = str(bodyRec['name']);
        if (name === '') return errorReply(422, 'Repository name is required');
        if (store.getRepo(ctx.viewerLogin, name) !== undefined) {
          return errorReply(422, `Repository '${name}' already exists`);
        }
        const repo = store.createRepo(
          ctx.viewerLogin,
          name,
          str(bodyRec['description']),
          bodyRec['private'] === true,
        );
        return jsonReply(201, repoJson(ctx, repo));
      }
      return errorReply(404, 'Not Found');
    }
    return errorReply(404, 'Not Found');
  }

  // /repos/{owner}/{name}[...]
  if (segs[0] === 'repos') {
    if (segs.length < 3) return errorReply(404, 'Not Found');
    const owner = segs[1] as string;
    const repoName = segs[2] as string;
    // Wrong owner is always 404, never 403.
    if (owner !== ctx.viewerLogin) return errorReply(404, 'Not Found');
    const repo = store.getRepo(owner, repoName);
    const tail = segs.slice(3);

    // Repo itself
    if (tail.length === 0) {
      if (method === 'GET') {
        if (repo === undefined) return errorReply(404, 'Not Found');
        return jsonReply(200, repoJson(ctx, repo));
      }
      if (method === 'PATCH') {
        if (repo === undefined) return errorReply(404, 'Not Found');
        if (typeof bodyRec['description'] === 'string') repo.description = bodyRec['description'] as string;
        if (typeof bodyRec['private'] === 'boolean') repo.private = bodyRec['private'] as boolean;
        repo.updatedAt = store.nowIso();
        return jsonReply(200, repoJson(ctx, repo));
      }
      if (method === 'DELETE') {
        if (repo === undefined) return errorReply(404, 'Not Found');
        store.deleteRepo(owner, repoName);
        return emptyReply(204);
      }
      return errorReply(404, 'Not Found');
    }
    if (repo === undefined) return errorReply(404, 'Not Found');

    // branches
    if (tail[0] === 'branches') {
      if (tail.length === 1) {
        if (method !== 'GET') return errorReply(404, 'Not Found');
        const out: Record<string, unknown>[] = [];
        const refs = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort();
        for (const ref of refs) {
          out.push({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) }, protected: false });
        }
        return jsonReply(200, out);
      }
      const branch = tail.slice(1).join('/');
      if (method !== 'GET') return errorReply(404, 'Not Found');
      const sha = refTip(repo, branch);
      if (sha === undefined) return errorReply(404, 'Not Found');
      return jsonReply(200, { name: branch, commit: { sha }, protected: false });
    }

    // git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = str(bodyRec['ref']);
        const sha = str(bodyRec['sha']);
        if (ref === '' || sha === '') return errorReply(422, 'ref and sha are required');
        if (repo.refs.has(ref)) return errorReply(422, `Reference '${ref}' already exists`);
        if (repo.objects.get(sha) === undefined) return errorReply(422, `Object '${sha}' does not exist`);
        repo.refs.set(ref, sha);
        return jsonReply(201, { ref, object: { sha, type: 'commit' }, node_id: b64(`REF:${repo.id}:${ref}`) });
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = tail.slice(2).join('/');
        const fullRef = ref.startsWith('refs/') ? ref : `refs/${ref}`;
        const sha = repo.refs.get(fullRef) ?? repo.refs.get(ref);
        if (sha === undefined) return errorReply(404, 'Not Found');
        return jsonReply(200, { ref: fullRef, object: { sha, type: 'commit' }, node_id: b64(`REF:${repo.id}:${fullRef}`) });
      }
      return errorReply(404, 'Not Found');
    }

    // commits
    if (tail[0] === 'commits') {
      if (method !== 'GET' || tail.length !== 1) return errorReply(404, 'Not Found');
      const shaParam = query.get('sha');
      const tip = shaParam !== null && shaParam !== '' ? resolveRefTip(store, repo, shaParam) : refTip(repo, repo.defaultBranch);
      if (tip === undefined) return jsonReply(200, []);
      const chain = commitChain(store, repo, tip);
      const out = chain.map((sha) => {
        const obj = repo.objects.get(sha) as { data: Buffer };
        const parsedCommit = store.parseCommit(obj.data);
        const author = parseAuthorLine(parsedCommit.authorLine);
        const committer = parseAuthorLine(parsedCommit.committerLine);
        return {
          sha,
          node_id: b64(`CMT:${repo.id}:${sha}`),
          commit: {
            message: parsedCommit.message.replace(/\n+$/, ''),
            author: { name: author.name, email: author.email, date: author.date },
            committer: { name: committer.name, email: committer.email, date: committer.date },
            tree: { sha: parsedCommit.tree },
          },
          author: { login: repo.owner, id: 1000 },
          committer: { login: repo.owner, id: 1000 },
          parents: parsedCommit.parents.map((p) => ({ sha: p })),
          url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}`,
          html_url: `https://github.com/${owner}/${repoName}/commit/${sha}`,
        };
      });
      return jsonReply(200, out);
    }

    // contents
    if (tail[0] === 'contents') {
      const contentPath = tail.slice(1).join('/');
      const refParam = query.get('ref');
      const branchFor = (requested: string | undefined): string => {
        if (requested !== undefined && requested !== '') return requested;
        return repo.defaultBranch;
      };
      if (method === 'GET') {
        const branch = branchFor(refParam ?? undefined);
        const tip = refTip(repo, branch) ?? resolveRefTip(store, repo, branch);
        if (tip === undefined) return errorReply(404, 'Not Found');
        const flat = store.flattenTree(repo, tip);
        if (contentPath === '') {
          // Root directory listing.
          const tmap = treeShaMap(store, repo, flat);
          const entries: Record<string, unknown>[] = [];
          const seen = new Map<string, { type: string; sha: string }>();
          for (const p of flat.keys()) {
            const first = p.split('/')[0] as string;
            if (seen.has(first)) continue;
            const isDir = p.includes('/');
            seen.set(first, { type: isDir ? 'dir' : 'file', sha: isDir ? (tmap.get(first) as string) : (flat.get(p)?.sha as string) });
          }
          for (const [name, info] of [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
            entries.push({ type: info.type, name, path: name, sha: info.sha, size: info.type === 'file' ? (repo.objects.get(info.sha)?.data.length ?? 0) : 0 });
          }
          return jsonReply(200, entries);
        }
        const file = flat.get(contentPath);
        if (file !== undefined) {
          const blob = repo.objects.get(file.sha);
          const bytes = blob?.data ?? Buffer.alloc(0);
          return jsonReply(200, {
            type: 'file',
            encoding: 'base64',
            size: bytes.length,
            name: contentPath.split('/').pop() ?? contentPath,
            path: contentPath,
            content: bytes.toString('base64'),
            sha: file.sha,
            url: `/api/v3/repos/${owner}/${repoName}/contents/${contentPath}`,
            html_url: `https://github.com/${owner}/${repoName}/blob/${branch}/${contentPath}`,
            git_url: `/api/v3/repos/${owner}/${repoName}/git/blobs/${file.sha}`,
            download_url: null,
          });
        }
        // Directory?
        const prefix = `${contentPath}/`;
        const children = [...flat.keys()].filter((p) => p.startsWith(prefix));
        if (children.length === 0) return errorReply(404, 'Not Found');
        const tmap = treeShaMap(store, repo, flat);
        const seen = new Map<string, { type: string; sha: string; size: number }>();
        for (const p of children) {
          const restPath = p.slice(prefix.length);
          const first = restPath.split('/')[0] as string;
          if (seen.has(first)) continue;
          const isDir = restPath.includes('/');
          const sha = isDir ? (tmap.get(`${contentPath}/${first}`) as string) : (flat.get(p)?.sha as string);
          seen.set(first, { type: isDir ? 'dir' : 'file', sha, size: isDir ? 0 : (repo.objects.get(sha)?.data.length ?? 0) });
        }
        const entries = [...seen.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([name, info]) => ({ type: info.type, name, path: `${contentPath}/${name}`, sha: info.sha, size: info.size }));
        return jsonReply(200, entries);
      }
      if (method === 'PUT') {
        const message = str(bodyRec['message'], 'Update file');
        const contentB64 = str(bodyRec['content']);
        if (contentB64 === '') return errorReply(422, 'content is required');
        const bytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        const branch = branchFor(typeof bodyRec['branch'] === 'string' ? (bodyRec['branch'] as string) : undefined);
        let tip = refTip(repo, branch);
        const flat = tip !== undefined ? store.flattenTree(repo, tip) : new Map<string, { mode: string; sha: string }>();
        const existing = flat.get(contentPath);
        const givenSha = typeof bodyRec['sha'] === 'string' ? (bodyRec['sha'] as string) : undefined;
        if (existing !== undefined && givenSha !== undefined && givenSha !== existing.sha) {
          return errorReply(409, 'sha does not match the current blob sha');
        }
        if (existing === undefined && givenSha !== undefined) {
          return errorReply(409, 'sha does not match the current blob sha');
        }
        const isCreate = existing === undefined;
        const blobSha = store.putObject(repo, 'blob', bytes);
        const nextFlat = new Map(flat);
        nextFlat.set(contentPath, { mode: '100644', sha: blobSha });
        const treeSha = buildTreeFromFlat(store, repo, nextFlat);
        const commitSha = createCommit(store, repo, treeSha, tip !== undefined ? [tip] : [], message);
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        repo.updatedAt = store.nowIso();
        return jsonReply(isCreate ? 201 : 200, {
          content: {
            name: contentPath.split('/').pop() ?? contentPath,
            path: contentPath,
            sha: blobSha,
            size: bytes.length,
            type: 'file',
            encoding: 'base64',
            content: bytes.toString('base64'),
            url: `/api/v3/repos/${owner}/${repoName}/contents/${contentPath}`,
          },
          commit: { sha: commitSha, message },
        });
      }
      if (method === 'DELETE') {
        const message = str(bodyRec['message'], 'Delete file');
        const branch = branchFor(typeof bodyRec['branch'] === 'string' ? (bodyRec['branch'] as string) : undefined);
        const tip = refTip(repo, branch);
        if (tip === undefined) return errorReply(404, 'Not Found');
        const flat = store.flattenTree(repo, tip);
        if (!flat.has(contentPath)) return errorReply(404, 'Not Found');
        const givenSha = typeof bodyRec['sha'] === 'string' ? (bodyRec['sha'] as string) : undefined;
        if (givenSha !== undefined && givenSha !== flat.get(contentPath)?.sha) {
          return errorReply(409, 'sha does not match the current blob sha');
        }
        const nextFlat = new Map(flat);
        nextFlat.delete(contentPath);
        const treeSha = buildTreeFromFlat(store, repo, nextFlat);
        const commitSha = createCommit(store, repo, treeSha, [tip], message);
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        repo.updatedAt = store.nowIso();
        return jsonReply(200, { commit: { sha: commitSha, message } });
      }
      return errorReply(404, 'Not Found');
    }

    // labels
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        return jsonReply(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })));
      }
      if (method === 'POST' && tail.length === 1) {
        const name = str(bodyRec['name']);
        if (name === '') return errorReply(422, 'Label name is required');
        const color = str(bodyRec['color'], 'ffffff');
        const description = str(bodyRec['description']);
        repo.labels.set(name, { name, color, description });
        return jsonReply(201, { name, color, description });
      }
      return errorReply(404, 'Not Found');
    }

    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          let items = [...repo.issues.values()];
          const state = query.get('state') ?? 'open';
          if (state === 'open' || state === 'closed') items = items.filter((i) => i.state === state);
          else if (state !== 'all') items = items.filter((i) => i.state === 'open');
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          if (sort === 'created') {
            items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          }
          const { page, perPage, pageNum, totalPages } = paginate(items, query);
          const extra: Record<string, string> = {};
          const link = linkHeader(baseUrlOf(headers), path, query, pageNum, perPage, totalPages);
          if (link !== '') extra['Link'] = link;
          return jsonReply(200, page.map((i) => issueJson(ctx, repo, i)), extra);
        }
        if (method === 'POST') {
          const title = str(bodyRec['title']);
          if (title === '') return errorReply(422, 'Issue title is required');
          const bodyText = str(bodyRec['body']);
          const rawLabels = Array.isArray(bodyRec['labels']) ? (bodyRec['labels'] as unknown[]) : [];
          const labelNames = rawLabels.map((l) => (typeof l === 'string' ? l : str(asRecord(l)['name'])));
          const created = createIssueInStore(store, repo, title, bodyText, labelNames);
          if ('error' in created) return errorReply(422, created.error);
          return jsonReply(201, issueJson(ctx, repo, created.issue));
        }
        return errorReply(404, 'Not Found');
      }
      const issueNum = Number(tail[1]);
      if (!Number.isInteger(issueNum) || issueNum < 1) return errorReply(404, 'Not Found');
      const issue = repo.issues.get(issueNum);
      if (tail.length === 2) {
        if (method === 'GET') {
          if (issue === undefined) return errorReply(404, 'Not Found');
          return jsonReply(200, issueJson(ctx, repo, issue));
        }
        if (method === 'PATCH') {
          if (issue === undefined) return errorReply(404, 'Not Found');
          if (bodyRec['state'] === 'open' || bodyRec['state'] === 'closed') issue.state = bodyRec['state'] as 'open' | 'closed';
          if (typeof bodyRec['title'] === 'string') issue.title = bodyRec['title'] as string;
          if (typeof bodyRec['body'] === 'string') issue.body = bodyRec['body'] as string;
          issue.updatedAt = store.nowIso();
          return jsonReply(200, issueJson(ctx, repo, issue));
        }
        return errorReply(404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (issue === undefined) return errorReply(404, 'Not Found');
        if (method === 'GET') {
          const { page } = paginate(issue.comments, query);
          return jsonReply(200, page.map((c) => commentJson(ctx, repo, issue, c)));
        }
        if (method === 'POST') {
          const commentBody = str(bodyRec['body']);
          if (commentBody === '') return errorReply(422, 'Comment body is required');
          const comment = addCommentInStore(store, repo, issue, commentBody);
          return jsonReply(201, commentJson(ctx, repo, issue, comment));
        }
        return errorReply(404, 'Not Found');
      }
      return errorReply(404, 'Not Found');
    }

    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          let items = [...repo.pulls.values()];
          const state = query.get('state');
          if (state === 'all') {
            // all
          } else if (state === 'closed') items = items.filter((p) => p.state === 'closed');
          else items = items.filter((p) => p.state === 'open');
          items.sort((a, b) => a.number - b.number);
          const { page, perPage, pageNum, totalPages } = paginate(items, query);
          const extra: Record<string, string> = {};
          const link = linkHeader(baseUrlOf(headers), path, query, pageNum, perPage, totalPages);
          if (link !== '') extra['Link'] = link;
          return jsonReply(200, page.map((p) => pullJson(ctx, repo, p)), extra);
        }
        if (method === 'POST') {
          const title = str(bodyRec['title']);
          const head = str(bodyRec['head']);
          const base = str(bodyRec['base']);
          if (title === '' || head === '' || base === '') return errorReply(422, 'head, base and title are required');
          const created = createPullInStore(store, repo, head, base, title, str(bodyRec['body']));
          if ('error' in created) return errorReply(422, created.error);
          return jsonReply(201, pullJson(ctx, repo, created.pull));
        }
        return errorReply(404, 'Not Found');
      }
      const pullNum = Number(tail[1]);
      if (!Number.isInteger(pullNum) || pullNum < 1) return errorReply(404, 'Not Found');
      const pull = repo.pulls.get(pullNum);
      if (tail.length === 2) {
        if (method !== 'GET') return errorReply(404, 'Not Found');
        if (pull === undefined) return errorReply(404, 'Not Found');
        return jsonReply(200, pullJson(ctx, repo, pull));
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (method !== 'GET') return errorReply(404, 'Not Found');
        if (pull === undefined) return errorReply(404, 'Not Found');
        return jsonReply(
          200,
          pull.files.map((f) => ({
            sha: f.sha,
            filename: f.filename,
            status: f.status === 'modified' ? 'modified' : f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
            blob_url: '',
            raw_url: '',
            contents_url: `/api/v3/repos/${owner}/${repoName}/contents/${f.filename}`,
          })),
        );
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (method !== 'PUT' && method !== 'POST') return errorReply(404, 'Not Found');
        if (pull === undefined) return errorReply(404, 'Not Found');
        const merged = mergePullInStore(store, repo, pull);
        if ('error' in merged) {
          if (merged.error === 'conflict') return errorReply(405, merged.message);
          return errorReply(404, merged.message);
        }
        return jsonReply(200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
      }
      return errorReply(404, 'Not Found');
    }

    return errorReply(404, 'Not Found');
  }

  return errorReply(404, 'Not Found');
}
