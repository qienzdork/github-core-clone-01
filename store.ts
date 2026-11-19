// In-memory store for the forge: git objects, refs, repos, issues, pull requests.
// Single process, no persistence needed: a trial starts fresh and the suite is
// the only client. Deterministic logical clock: timestamps come from
// MAKEFUN_TRIAL_NOW (the trial's fixed now) plus one second per mutation, so two
// runs on the same instance produce the same visible state.

import { createHash } from 'node:crypto';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  user: string;
  createdAt: string;
  updatedAt: string;
  files: PullFile[];
  /** True when the head branch's tip is not a descendant of base (merge would conflict). */
  conflicted: boolean;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** ref name (refs/heads/x) -> commit sha */
  refs: Map<string, string>;
  /** git objects, keyed by sha */
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  nextIssue: number;
  pulls: Map<number, PullRequest>;
  nextPull: number;
  nextCommentId: number;
}

export function gitObjectId(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export class Store {
  readonly repos = new Map<string, Repo>(); // key `${owner}/${name}`
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  #clockMs: number;
  #tick = 0;

  constructor(nowIso: string) {
    const parsed = Date.parse(nowIso);
    this.#clockMs = Number.isFinite(parsed) ? parsed : Date.parse('2025-01-01T00:00:00Z');
  }

  /** Deterministic timestamp: base now + 1s per call. */
  nowIso(): string {
    const ms = this.#clockMs + this.#tick * 1000;
    this.#tick += 1;
    return new Date(ms).toISOString().replace('.000Z', 'Z');
  }

  /** The fixed base time, for read-only stamps. */
  baseIso(): string {
    return new Date(this.#clockMs).toISOString().replace('.000Z', 'Z');
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      nextIssue: 1,
      pulls: new Map(),
      nextPull: 1,
      nextCommentId: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** All repos owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const sha = gitObjectId(type, data);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
    return sha;
  }

  getObject(repo: Repo, sha: string): GitObject | undefined {
    return repo.objects.get(sha);
  }

  /** Parse a commit object's fields. */
  parseCommit(data: Buffer): { tree: string; parents: string[]; message: string; authorLine: string; committerLine: string } {
    const text = data.toString('utf8');
    const split = text.indexOf('\n\n');
    const header = split >= 0 ? text.slice(0, split) : text;
    const message = split >= 0 ? text.slice(split + 2) : '';
    let tree = '';
    const parents: string[] = [];
    let authorLine = '';
    let committerLine = '';
    for (const line of header.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
      else if (line.startsWith('author ')) authorLine = line.slice(7);
      else if (line.startsWith('committer ')) committerLine = line.slice(10);
    }
    return { tree, parents, message, authorLine, committerLine };
  }

  /** Parse a tree object's entries: [{mode, name, sha}]. */
  parseTree(data: Buffer): { mode: string; name: string; sha: string }[] {
    const out: { mode: string; name: string; sha: string }[] = [];
    let off = 0;
    while (off < data.length) {
      const space = data.indexOf(0x20, off);
      if (space < 0) break;
      const mode = data.subarray(off, space).toString('utf8');
      const nul = data.indexOf(0x00, space);
      if (nul < 0) break;
      const name = data.subarray(space + 1, nul).toString('utf8');
      const sha = data.subarray(nul + 1, nul + 21).toString('hex');
      out.push({ mode, name, sha });
      off = nul + 21;
    }
    return out;
  }

  /** Build a tree object body from entries (sorted by git's rules: names, dirs as name+'/'). */
  buildTree(entries: { mode: string; name: string; sha: string }[]): Buffer {
    const sorted = entries.slice().sort((a, b) => {
      const an = a.mode === '40000' ? `${a.name}/` : a.name;
      const bn = b.mode === '40000' ? `${b.name}/` : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const parts: Buffer[] = [];
    for (const e of sorted) {
      parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      parts.push(Buffer.from(e.sha, 'hex'));
    }
    return Buffer.concat(parts);
  }

  /** All ancestors of `sha` (including itself) reachable by parent links. */
  ancestors(repo: Repo, sha: string): Set<string> {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (obj !== undefined && obj.type === 'commit') {
        for (const p of this.parseCommit(obj.data).parents) stack.push(p);
      }
    }
    return seen;
  }

  /** True when `ancestor` is an ancestor of `descendant` (or equal). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.ancestors(repo, descendant).has(ancestor);
  }

  /** Tree at a commit, flattened to path -> {mode, sha}. */
  flattenTree(repo: Repo, commitSha: string): Map<string, { mode: string; sha: string }> {
    const out = new Map<string, { mode: string; sha: string }>();
    const obj = repo.objects.get(commitSha);
    if (obj === undefined || obj.type !== 'commit') return out;
    const { tree } = this.parseCommit(obj.data);
    const walk = (treeSha: string, prefix: string): void => {
      const t = repo.objects.get(treeSha);
      if (t === undefined || t.type !== 'tree') return;
      for (const e of this.parseTree(t.data)) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.sha, path);
        else out.set(path, { mode: e.mode, sha: e.sha });
      }
    };
    walk(tree, '');
    return out;
  }
}
