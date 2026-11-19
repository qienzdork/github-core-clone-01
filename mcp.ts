// MCP handler for github-core-clone-01 (streamable HTTP, 2026-07-28 modern
// revision with legacy initialize fallback). Stdlib only, synchronous,
// stateless, deterministic. Tools act on the same store as REST/GraphQL.

import type { Ctx, HandlerResult } from './rest.ts';
import {
  createIssueInStore,
  createPullInStore,
  issueJson,
  jsonReply,
  mergePullInStore,
  pullJson,
  repoJson,
} from './rest.ts';
import type { Repo } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

const TOOLS: Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        name: { type: 'string', description: 'Name of the repository to create.' },
        description: { type: 'string', description: 'Description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        body: { type: 'string', description: 'Body of the pull request.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        pull_number: { type: 'integer', description: 'Number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcReply(id: unknown, result: unknown): HandlerResult {
  return jsonReply(200, { jsonrpc: '2.0', id: id ?? null, result }, {}, 'mcp');
}

function rpcError(id: unknown, code: number, message: string, httpStatus = 200): HandlerResult {
  return jsonReply(httpStatus, { jsonrpc: '2.0', id: id ?? null, error: { code, message } }, {}, 'mcp');
}

function toolResult(structured: unknown, isError = false): Record<string, unknown> {
  const text = typeof structured === 'string' ? structured : JSON.stringify(structured);
  return { content: [{ type: 'text', text }], structuredContent: structured, isError };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Normalized argument lookup: keys are lowercased with non-alphanumerics stripped.
function normKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function argMap(args: Record<string, unknown>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [k, v] of Object.entries(args)) out.set(normKey(k), v);
  return out;
}

function pickArg(map: Map<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const v = map.get(normKey(name));
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function pickStr(map: Map<string, unknown>, names: string[]): string | undefined {
  const v = pickArg(map, names);
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

function resolveOwnerRepo(
  ctx: Ctx,
  map: Map<string, unknown>,
): { owner: string; repo: string } | null {
  const fullName = pickStr(map, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
  if (fullName !== undefined && fullName.includes('/')) {
    const [owner, repo] = fullName.split('/');
    if (owner !== undefined && repo !== undefined && owner !== '' && repo !== '') return { owner, repo };
  }
  const owner = pickStr(map, ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']) ?? ctx.viewerLogin;
  const repo = pickStr(map, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']);
  if (repo === undefined) return null;
  return { owner, repo };
}

function getRepoOrError(ctx: Ctx, owner: string, repoName: string): Repo | null {
  if (owner !== ctx.viewerLogin) return null;
  return ctx.store.getRepo(owner, repoName) ?? null;
}

export function handleMcp(
  ctx: Ctx,
  method: string,
  path: string,
  _query: URLSearchParams,
  _headers: Record<string, string | undefined>,
  body: Buffer | null,
): HandlerResult | null {
  if (path !== '/mcp' && path !== '/mcp/') return null;
  if (method !== 'POST') {
    return jsonReply(404, { message: 'Not Found' }, {}, 'mcp');
  }
  // Auth is decided before any tool lookup, for every method.
  if (!ctx.authed) {
    return jsonReply(401, { message: 'Requires authentication' }, {}, 'mcp');
  }
  if (body === null || body.length === 0) {
    return rpcError(null, -32700, 'Parse error: empty body', 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    // Try to recover the request id for the -32700 error.
    const text = body.toString('utf8');
    const m = /"id"\s*:\s*(\d+|"[^"]*")/.exec(text);
    let id: unknown = null;
    if (m !== null) {
      const raw = m[1] as string;
      id = raw.startsWith('"') ? raw.slice(1, -1) : Number(raw);
    }
    return rpcError(id, -32700, 'Parse error', 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const rec = parsed as Record<string, unknown>;
  const id = 'id' in rec ? rec['id'] : null;
  const isNotification = !('id' in rec);
  const rpcMethod = typeof rec['method'] === 'string' ? (rec['method'] as string) : '';
  const params = rec['params'] !== null && typeof rec['params'] === 'object' && !Array.isArray(rec['params'])
    ? (rec['params'] as Record<string, unknown>)
    : {};

  if (rpcMethod.startsWith('notifications/')) {
    // Notifications get no response body.
    return { status: 202, contentType: 'application/json', body: Buffer.alloc(0), headers: {} };
  }
  if (isNotification) {
    return { status: 202, contentType: 'application/json', body: Buffer.alloc(0), headers: {} };
  }

  if (rpcMethod === 'server/discover') {
    return rpcReply(id, {
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (rpcMethod === 'initialize') {
    const offered =
      typeof params['protocolVersion'] === 'string'
        ? (params['protocolVersion'] as string)
        : '2025-11-25';
    return rpcReply(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (rpcMethod === 'ping') {
    return rpcReply(id, {});
  }

  if (rpcMethod === 'tools/list') {
    // Built once from the constant above; identical bytes on every call.
    return rpcReply(id, { tools: TOOLS });
  }

  if (rpcMethod === 'tools/call') {
    const name = typeof params['name'] === 'string' ? (params['name'] as string) : '';
    const args = params['arguments'] !== null && typeof params['arguments'] === 'object' && !Array.isArray(params['arguments'])
      ? (params['arguments'] as Record<string, unknown>)
      : {};
    const map = argMap(args);
    const known = new Set(TOOLS.map((t) => String(t['name'])));
    if (!known.has(name)) {
      return rpcError(id, -32602, `Unknown tool: ${name}`);
    }

    if (name === 'create_repo') {
      const repoName = pickStr(map, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
      if (repoName === undefined || repoName === '') {
        return rpcReply(id, toolError('Missing required argument: name'));
      }
      const description = pickStr(map, ['description', 'about', 'summary', 'body']) ?? '';
      const isPrivate = pickArg(map, ['private', 'is_private']) === true;
      if (ctx.store.getRepo(ctx.viewerLogin, repoName) !== undefined) {
        return rpcReply(id, toolError(`Repository '${repoName}' already exists`));
      }
      const repo = ctx.store.createRepo(ctx.viewerLogin, repoName, description, isPrivate);
      const structured = repoJson(ctx, repo);
      return rpcReply(id, toolResult(structured));
    }

    if (name === 'get_repo') {
      const resolved = resolveOwnerRepo(ctx, map);
      if (resolved === null) return rpcReply(id, toolError('Missing required argument: repo'));
      const repo = getRepoOrError(ctx, resolved.owner, resolved.repo);
      if (repo === null) return rpcReply(id, toolError(`Repository '${resolved.owner}/${resolved.repo}' not found`));
      return rpcReply(id, toolResult(repoJson(ctx, repo)));
    }

    if (name === 'create_issue') {
      const resolved = resolveOwnerRepo(ctx, map);
      const title = pickStr(map, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
      if (resolved === null || title === undefined || title === '') {
        return rpcReply(id, toolError('Missing required argument: repo or title'));
      }
      const repo = getRepoOrError(ctx, resolved.owner, resolved.repo);
      if (repo === null) return rpcReply(id, toolError(`Repository '${resolved.owner}/${resolved.repo}' not found`));
      const bodyText = pickStr(map, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
      const created = createIssueInStore(ctx.store, repo, title, bodyText, []);
      if ('error' in created) return rpcReply(id, toolError(created.error));
      return rpcReply(id, toolResult(issueJson(ctx, repo, created.issue)));
    }

    if (name === 'list_issues') {
      const resolved = resolveOwnerRepo(ctx, map);
      if (resolved === null) return rpcReply(id, toolError('Missing required argument: repo'));
      const repo = getRepoOrError(ctx, resolved.owner, resolved.repo);
      if (repo === null) return rpcReply(id, toolError(`Repository '${resolved.owner}/${resolved.repo}' not found`));
      const state = pickStr(map, ['state', 'status']);
      let items = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') items = items.filter((i) => i.state === state);
      items.sort((a, b) => a.number - b.number);
      const structured = { owner: resolved.owner, repo: resolved.repo, issues: items.map((i) => issueJson(ctx, repo, i)) };
      return rpcReply(id, toolResult(structured));
    }

    if (name === 'create_pull_request') {
      const resolved = resolveOwnerRepo(ctx, map);
      const title = pickStr(map, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
      const head = pickStr(map, ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']);
      const base = pickStr(map, ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']);
      if (resolved === null || title === undefined || title === '' || head === undefined || base === undefined) {
        return rpcReply(id, toolError('Missing required argument: repo, title, head, or base'));
      }
      const repo = getRepoOrError(ctx, resolved.owner, resolved.repo);
      if (repo === null) return rpcReply(id, toolError(`Repository '${resolved.owner}/${resolved.repo}' not found`));
      const bodyText = pickStr(map, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
      const created = createPullInStore(ctx.store, repo, head, base, title, bodyText);
      if ('error' in created) return rpcReply(id, toolError(created.error));
      return rpcReply(id, toolResult(pullJson(ctx, repo, created.pull)));
    }

    if (name === 'merge_pull_request') {
      const resolved = resolveOwnerRepo(ctx, map);
      const numRaw = pickArg(map, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
      const pullNumber = typeof numRaw === 'number' ? numRaw : typeof numRaw === 'string' ? Number(numRaw) : NaN;
      if (resolved === null || !Number.isInteger(pullNumber) || pullNumber < 1) {
        return rpcReply(id, toolError('Missing required argument: repo or pull_number'));
      }
      const repo = getRepoOrError(ctx, resolved.owner, resolved.repo);
      if (repo === null) return rpcReply(id, toolError(`Repository '${resolved.owner}/${resolved.repo}' not found`));
      const pull = repo.pulls.get(pullNumber);
      if (pull === undefined) return rpcReply(id, toolError(`Pull request #${pullNumber} not found`));
      const merged = mergePullInStore(ctx.store, repo, pull);
      if ('error' in merged) return rpcReply(id, toolError(merged.message));
      const structured = { ...pullJson(ctx, repo, pull), sha: merged.sha, merged: true };
      return rpcReply(id, toolResult(structured));
    }

    return rpcError(id, -32602, `Unknown tool: ${name}`);
  }

  return rpcError(id, -32601, `Method not found: ${rpcMethod}`);
}
