// GraphQL v4 handler for github-core-clone-01. Small executor for exactly the
// 18 documents in SPEC §4.1, plus introspection for Issue / PullRequest /
// Repository / SearchType. Stdlib only, synchronous, deterministic.

import type { Issue, PullRequest, Repo } from './store.ts';
import {
  addCommentInStore,
  commentGlobalId,
  createIssueInStore,
  createPullInStore,
  findRepoById,
  issueGlobalId,
  jsonReply,
  mergePullInStore,
  pullGlobalId,
  repoGlobalId,
  resolveGlobalId,
} from './rest.ts';
import type { Ctx, HandlerResult } from './rest.ts';

// ------------------------------------------------------------------ tokenizer
type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      // Block string """...""" or normal "..."
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        const raw = end < 0 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw.replace(/\\"""/g, '"""') });
        i = end < 0 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc as string;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if ('!$&():=[]{}|@.'.includes(ch) || ch === '.' ) {
      if (ch === '.' && input.startsWith('...', i)) {
        tokens.push({ kind: 'punct', value: '...' });
        i += 3;
        continue;
      }
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    i += 1; // skip unknown char
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ------------------------------------------------------------------ AST types
type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldSel {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, ValueNode>;
  selections: Selection[];
}
interface SpreadSel {
  kind: 'spread';
  name: string;
}
interface InlineSel {
  kind: 'inline';
  typeCondition: string | null;
  selections: Selection[];
}
type Selection = FieldSel | SpreadSel | InlineSel;

interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefs: string[];
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  next(): Token {
    const t = this.tokens[this.pos] as Token;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return t;
  }
  expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}`);
  }
  expectName(v?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('expected name');
    if (v !== undefined && t.value !== v) throw new Error(`expected ${v}`);
    return t.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, { typeCondition: string; selections: Selection[] }> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: Selection[] }>();
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ type: 'query', name: null, varDefs: [], selections: this.parseSelections() });
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        const type = this.next().value as Operation['type'];
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefs: string[] = [];
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVarDefs(varDefs);
        operations.push({ type, name, varDefs, selections: this.parseSelections() });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelections();
        fragments.set(fragName, { typeCondition, selections });
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }

  private parseVarDefs(out: string[]): void {
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      if (this.peek().kind === 'eof') break;
      if (this.peek().kind === 'punct' && this.peek().value === '$') {
        this.next();
        out.push(this.expectName());
      } else if (this.peek().kind === 'name') {
        out.push(this.next().value);
      } else {
        this.next();
      }
      // Skip the type annotation tokens until ',' or ')' at depth 0.
      let depth = 0;
      while (this.peek().kind !== 'eof') {
        const t = this.peek();
        if (depth === 0 && ((t.kind === 'punct' && (t.value === ',' || t.value === ')')) || (t.kind === 'punct' && t.value === '$'))) break;
        if (t.kind === 'punct' && (t.value === '[' || t.value === '(' || t.value === '{')) depth += 1;
        if (t.kind === 'punct' && (t.value === ']' || t.value === ')' || t.value === '}')) {
          if (depth === 0) break;
          depth -= 1;
        }
        this.next();
      }
      if (this.peek().kind === 'punct' && this.peek().value === ',') this.next();
    }
    this.expectPunct(')');
  }

  parseSelections(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') break;
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): Selection {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const n = this.peek();
      if (n.kind === 'name' && n.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelections() };
      }
      if (n.kind === 'name') {
        return { kind: 'spread', name: this.next().value };
      }
      return { kind: 'inline', typeCondition: null, selections: this.parseSelections() };
    }
    let alias = '';
    let name = this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    if (alias === '') alias = name;
    const args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        if (this.peek().kind === 'eof') break;
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
        if (this.peek().kind === 'punct' && this.peek().value === ',') this.next();
      }
      this.expectPunct(')');
    }
    // Directives (@skip/@include): skip them.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        let depth = 0;
        do {
          const tok = this.next();
          if (tok.kind === 'punct' && tok.value === '(') depth += 1;
          if (tok.kind === 'punct' && tok.value === ')') depth -= 1;
        } while (depth > 0 && this.peek().kind !== 'eof');
      }
    }
    let selections: Selection[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelections();
    return { kind: 'field', alias, name, args, selections };
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'int') return { kind: 'literal', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'literal', value: parseFloat(t.value) };
    if (t.kind === 'string') return { kind: 'literal', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'literal', value: true };
      if (t.value === 'false') return { kind: 'literal', value: false };
      if (t.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        if (this.peek().kind === 'eof') break;
        items.push(this.parseValue());
        if (this.peek().kind === 'punct' && this.peek().value === ',') this.next();
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        if (this.peek().kind === 'eof') break;
        const fname = this.expectName();
        this.expectPunct(':');
        fields[fname] = this.parseValue();
        if (this.peek().kind === 'punct' && this.peek().value === ',') this.next();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    return { kind: 'literal', value: null };
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'literal':
      return node.value;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((i) => resolveValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ schema
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'private',
    'isPrivate', 'createdAt', 'updatedAt', 'url', 'fork', 'defaultBranch',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author',
    'user', 'labels', 'comments', 'url', 'repository', 'closed', 'titleHTML',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'author', 'user',
    'url', 'repository', 'closed',
  ],
  User: ['login', 'id', 'databaseId', 'name', 'email', 'avatarUrl', 'url'],
  Actor: ['login', 'id'],
  Ref: ['name', 'prefix', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  ChangedFile: ['path', 'additions', 'deletions', 'changes'],
  Comment: ['id', 'databaseId', 'body', 'author', 'user', 'createdAt', 'updatedAt', 'url'],
  CommentEdge: ['node', 'cursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __InputValue: ['name', 'description', 'type'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
};

const INTROSPECTION: Record<string, { fields: string[]; enumValues: string[] }> = {
  Issue: {
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'repository', 'closed'],
    enumValues: [],
  },
  PullRequest: {
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'author', 'url', 'repository', 'closed'],
    enumValues: [],
  },
  Repository: {
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'private', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
    enumValues: [],
  },
  SearchType: { fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'] },
  IssueState: { fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
};

// ------------------------------------------------------------------ node model
type GNode =
  | { kind: 'Query' }
  | { kind: 'Mutation' }
  | { kind: 'Repository'; repo: Repo }
  | { kind: 'Issue'; repo: Repo; issue: Issue }
  | { kind: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { kind: 'User'; login: string }
  | { kind: 'Ref'; name: string }
  | { kind: 'IssueConnection'; repo: Repo; items: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null; startCursor: string | null; hasPreviousPage: boolean } }
  | { kind: 'PullRequestConnection'; repo: Repo; items: PullRequest[]; pageInfo: { hasNextPage: boolean; endCursor: string | null; startCursor: string | null; hasPreviousPage: boolean } }
  | { kind: 'FileConnection'; files: import('./store.ts').PullFile[] }
  | { kind: 'ChangedFile'; file: import('./store.ts').PullFile }
  | { kind: 'Comment'; repo: Repo; issue: Issue; comment: Issue['comments'][number] }
  | { kind: 'CommentEdge'; node: GNode }
  | { kind: 'Edge'; node: GNode; cursor: string }
  | { kind: 'PageInfo'; info: { hasNextPage: boolean; endCursor: string | null; startCursor: string | null; hasPreviousPage: boolean } }
  | { kind: 'Type'; name: string }
  | { kind: 'Schema' }
  | { kind: 'Payload'; fields: Record<string, GNode | unknown> };

function typeNameOf(node: GNode): string {
  switch (node.kind) {
    case 'Query': return 'Query';
    case 'Mutation': return 'Mutation';
    case 'Repository': return 'Repository';
    case 'Issue': return 'Issue';
    case 'PullRequest': return 'PullRequest';
    case 'User': return 'User';
    case 'Ref': return 'Ref';
    case 'IssueConnection': return 'IssueConnection';
    case 'PullRequestConnection': return 'PullRequestConnection';
    case 'FileConnection': return 'PullRequestChangedFileConnection';
    case 'ChangedFile': return 'ChangedFile';
    case 'Comment': return 'Comment';
    case 'CommentEdge': return 'CommentEdge';
    case 'Edge': return node.node.kind === 'Issue' ? 'IssueEdge' : 'PullRequestEdge';
    case 'PageInfo': return 'PageInfo';
    case 'Type': return '__Type';
    case 'Schema': return '__Schema';
    case 'Payload': return 'Payload';
  }
}

const cursorOf = (n: number): string => Buffer.from(`cursor:${n}`, 'utf8').toString('base64url');
function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(-?\d+)$/.exec(decoded);
    if (m !== null) return Number(m[1]);
    const asNum = Number(decoded);
    return Number.isFinite(asNum) ? asNum : null;
  } catch {
    return null;
  }
}

function paginateConnection<T extends { number: number }>(
  items: T[],
  first: unknown,
  after: unknown,
): { page: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null; startCursor: string | null; hasPreviousPage: boolean } } {
  const afterNum = cursorNumber(after);
  let start = 0;
  if (afterNum !== null) {
    const idx = items.findIndex((i) => i.number === afterNum);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const limit = typeof first === 'number' && first >= 0 ? Math.floor(first) : items.length - start;
  const page = items.slice(start, start + limit);
  const end = start + page.length;
  return {
    page,
    pageInfo: {
      hasNextPage: end < items.length,
      endCursor: page.length > 0 ? cursorOf((page[page.length - 1] as T).number) : null,
      startCursor: page.length > 0 ? cursorOf((page[0] as T).number) : null,
      hasPreviousPage: start > 0,
    },
  };
}

// ------------------------------------------------------------------ executor
interface ExecCtx {
  ctx: Ctx;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
  errors: { message: string }[];
}

function validateSelections(
  parentType: string,
  selections: Selection[],
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>,
  errors: { message: string }[],
  depth = 0,
): void {
  if (depth > 12) return;
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = fragments.get(sel.name);
      if (frag !== undefined) validateSelections(frag.typeCondition, frag.selections, fragments, errors, depth + 1);
      continue;
    }
    if (sel.kind === 'inline') {
      validateSelections(sel.typeCondition ?? parentType, sel.selections, fragments, errors, depth + 1);
      continue;
    }
    if (sel.name === '__typename') continue;
    const allowed = TYPE_FIELDS[parentType];
    if (allowed !== undefined && !allowed.includes(sel.name)) {
      errors.push({ message: `Cannot query field "${sel.name}" on type "${parentType}".` });
      continue;
    }
    // Recurse into sub-selections with the child type when known.
    if (sel.selections.length > 0) {
      const childType = childTypeOf(parentType, sel.name);
      if (childType !== null) validateSelections(childType, sel.selections, fragments, errors, depth + 1);
    }
  }
}

function childTypeOf(parentType: string, field: string): string | null {
  const map: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Repository' },
    Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
    Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection' },
    Issue: { author: 'User', user: 'User', labels: 'LabelConnection', comments: 'Comment' },
    PullRequest: { author: 'User', user: 'User', files: 'PullRequestChangedFileConnection', headRef: 'Ref', baseRef: 'Ref' },
    IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
    PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
    PullRequestChangedFileConnection: { nodes: 'ChangedFile', edges: 'ChangedFile', pageInfo: 'PageInfo' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'CommentEdge', comment: 'Comment' },
    CommentEdge: { node: 'Comment' },
    IssueEdge: { node: 'Issue' },
    PullRequestEdge: { node: 'PullRequest' },
    __Type: { fields: '__Field', enumValues: '__EnumValue' },
    __Schema: { types: '__Type', queryType: '__Type', mutationType: '__Type' },
  };
  return map[parentType]?.[field] ?? null;
}

function executeSelections(
  exec: ExecCtx,
  node: GNode,
  selections: Selection[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const parentType = typeNameOf(node);
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = exec.fragments.get(sel.name);
      if (frag === undefined) continue;
      if (frag.typeCondition !== parentType && frag.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelections(exec, node, frag.selections));
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition !== null && sel.typeCondition !== parentType && sel.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelections(exec, node, sel.selections));
      continue;
    }
    out[sel.alias] = executeField(exec, node, sel);
  }
  return out;
}

function executeField(exec: ExecCtx, node: GNode, sel: FieldSel): unknown {
  const { ctx, variables } = exec;
  const store = ctx.store;
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sel.args)) args[k] = resolveValue(v, variables);

  if (sel.name === '__typename') return typeNameOf(node);

  switch (node.kind) {
    case 'Query': {
      if (sel.name === 'viewer') {
        return executeSelections(exec, { kind: 'User', login: ctx.viewerLogin }, sel.selections);
      }
      if (sel.name === 'repository') {
        const owner = String(args['owner'] ?? '');
        const name = String(args['name'] ?? '');
        const repo = owner === ctx.viewerLogin ? store.getRepo(owner, name) : undefined;
        if (repo === undefined) return null;
        return executeSelections(exec, { kind: 'Repository', repo }, sel.selections);
      }
      if (sel.name === 'node') {
        const id = String(args['id'] ?? '');
        const resolved = resolveGlobalId(id);
        if (resolved === null) return null;
        const repo = findRepoById(store, resolved.repoId);
        if (repo === undefined) return null;
        if (resolved.kind === 'repo') return executeSelections(exec, { kind: 'Repository', repo }, sel.selections);
        if (resolved.kind === 'issue') {
          const issue = repo.issues.get(resolved.number ?? -1);
          if (issue === undefined) return null;
          return executeSelections(exec, { kind: 'Issue', repo, issue }, sel.selections);
        }
        if (resolved.kind === 'pull') {
          const pull = repo.pulls.get(resolved.number ?? -1);
          if (pull === undefined) return null;
          return executeSelections(exec, { kind: 'PullRequest', repo, pull }, sel.selections);
        }
        return null;
      }
      if (sel.name === '__type') {
        const name = String(args['name'] ?? '');
        if (INTROSPECTION[name] === undefined) return null;
        return executeSelections(exec, { kind: 'Type', name }, sel.selections);
      }
      if (sel.name === '__schema') {
        return executeSelections(exec, { kind: 'Schema' }, sel.selections);
      }
      return null;
    }
    case 'Mutation': {
      return executeMutation(exec, sel);
    }
    case 'Repository': {
      const repo = node.repo;
      switch (sel.name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'description': return repo.description;
        case 'private': case 'isPrivate': return repo.private;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'url': return `/api/v3/repos/${repo.owner}/${repo.name}`;
        case 'fork': return false;
        case 'defaultBranch': return repo.defaultBranch;
        case 'owner': return executeSelections(exec, { kind: 'User', login: repo.owner }, sel.selections);
        case 'defaultBranchRef': return executeSelections(exec, { kind: 'Ref', name: repo.defaultBranch }, sel.selections);
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const issue = repo.issues.get(Number(args['number']));
          if (issue === undefined) return null;
          return executeSelections(exec, { kind: 'Issue', repo, issue }, sel.selections);
        }
        case 'issues': {
          let items = [...repo.issues.values()];
          const states = args['states'];
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((s) => String(s).toLowerCase()));
            items = items.filter((i) => wanted.has(i.state));
          }
          const orderBy = args['orderBy'] as Record<string, unknown> | undefined;
          const direction = orderBy !== undefined ? String(orderBy['direction'] ?? 'ASC') : 'ASC';
          items.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
          const { page, pageInfo } = paginateConnection(items, args['first'], args['after']);
          return executeSelections(exec, { kind: 'IssueConnection', repo, items: page, pageInfo }, sel.selections);
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args['number']));
          if (pull === undefined) return null;
          return executeSelections(exec, { kind: 'PullRequest', repo, pull }, sel.selections);
        }
        case 'pullRequests': {
          let items = [...repo.pulls.values()];
          const states = args['states'];
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((s) => String(s).toUpperCase()));
            items = items.filter((p) => wanted.has(p.state === 'closed' && p.merged ? 'MERGED' : p.state.toUpperCase()));
          }
          const orderBy = args['orderBy'] as Record<string, unknown> | undefined;
          const direction = orderBy !== undefined ? String(orderBy['direction'] ?? 'ASC') : 'ASC';
          items.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
          const { page, pageInfo } = paginateConnection(items, args['first'], args['after']);
          return executeSelections(exec, { kind: 'PullRequestConnection', repo, items: page, pageInfo }, sel.selections);
        }
        default: return null;
      }
    }
    case 'Issue': {
      const { repo, issue } = node;
      switch (sel.name) {
        case 'id': return issueGlobalId(repo, issue);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'closed': return issue.state === 'closed';
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'url': return `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'author': case 'user': return executeSelections(exec, { kind: 'User', login: issue.user }, sel.selections);
        case 'repository': return executeSelections(exec, { kind: 'Repository', repo }, sel.selections);
        case 'labels': {
          const nodes = issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ffffff', description: repo.labels.get(name)?.description ?? '' }));
          if (sel.selections.length === 0) return nodes;
          return { nodes: nodes.map((l) => executeSelections(exec, { kind: 'Payload', fields: l } as GNode, sel.selections)) };
        }
        case 'comments': {
          const nodes = issue.comments.map((c) => ({ kind: 'Comment', repo, issue, comment: c }) as GNode);
          if (sel.selections.length === 0) return nodes;
          // comments is a connection in real GitHub; support nodes subfield if present.
          const hasNodes = sel.selections.some((s) => s.kind === 'field' && s.name === 'nodes');
          if (hasNodes) {
            const out: Record<string, unknown> = {};
            for (const s of sel.selections) {
              if (s.kind === 'field' && s.name === 'nodes') {
                out[s.alias] = nodes.map((n) => executeSelections(exec, n, s.selections));
              }
            }
            return out;
          }
          return nodes.map((n) => executeSelections(exec, n, sel.selections));
        }
        default: return null;
      }
    }
    case 'PullRequest': {
      const { repo, pull } = node;
      switch (sel.name) {
        case 'id': return pullGlobalId(repo, pull);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'CLOSED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'closed': return pull.state === 'closed';
        case 'mergeable': return pull.mergeable ? 'MERGEABLE' : 'CONFLICTING';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRef': return executeSelections(exec, { kind: 'Ref', name: pull.headRef }, sel.selections);
        case 'baseRef': return executeSelections(exec, { kind: 'Ref', name: pull.baseRef }, sel.selections);
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'url': return `/api/v3/repos/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'author': case 'user': return executeSelections(exec, { kind: 'User', login: pull.user }, sel.selections);
        case 'repository': return executeSelections(exec, { kind: 'Repository', repo }, sel.selections);
        case 'files': {
          const first = typeof args['first'] === 'number' ? Math.floor(args['first'] as number) : pull.files.length;
          const files = pull.files.slice(0, first);
          return executeSelections(exec, { kind: 'FileConnection', files }, sel.selections);
        }
        default: return null;
      }
    }
    case 'User': {
      switch (sel.name) {
        case 'login': return node.login;
        case 'id': return Buffer.from(`U:${node.login}`, 'utf8').toString('base64url');
        case 'databaseId': return node.login === ctx.viewerLogin ? 1000 : 1001;
        case 'name': return node.login === ctx.viewerLogin ? 'ada iversen' : node.login;
        case 'email': return `${node.login}@example.invalid`;
        case 'url': return `https://github.com/${node.login}`;
        case 'avatarUrl': return '';
        default: return null;
      }
    }
    case 'Ref': {
      switch (sel.name) {
        case 'name': return node.name;
        case 'prefix': return 'refs/heads/';
        case 'target': return null;
        default: return null;
      }
    }
    case 'IssueConnection': {
      switch (sel.name) {
        case 'nodes': return node.items.map((issue) => executeSelections(exec, { kind: 'Issue', repo: node.repo, issue }, sel.selections));
        case 'edges': return node.items.map((issue) => executeSelections(exec, { kind: 'Edge', node: { kind: 'Issue', repo: node.repo, issue }, cursor: cursorOf(issue.number) }, sel.selections));
        case 'pageInfo': return executeSelections(exec, { kind: 'PageInfo', info: node.pageInfo }, sel.selections);
        case 'totalCount': return node.items.length;
        default: return null;
      }
    }
    case 'PullRequestConnection': {
      switch (sel.name) {
        case 'nodes': return node.items.map((pull) => executeSelections(exec, { kind: 'PullRequest', repo: node.repo, pull }, sel.selections));
        case 'edges': return node.items.map((pull) => executeSelections(exec, { kind: 'Edge', node: { kind: 'PullRequest', repo: node.repo, pull }, cursor: cursorOf(pull.number) }, sel.selections));
        case 'pageInfo': return executeSelections(exec, { kind: 'PageInfo', info: node.pageInfo }, sel.selections);
        case 'totalCount': return node.items.length;
        default: return null;
      }
    }
    case 'FileConnection': {
      switch (sel.name) {
        case 'nodes': return node.files.map((file) => executeSelections(exec, { kind: 'ChangedFile', file }, sel.selections));
        case 'edges': return node.files.map((file) => ({ node: executeSelections(exec, { kind: 'ChangedFile', file }, []) }));
        case 'pageInfo': return { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
        case 'totalCount': return node.files.length;
        default: return null;
      }
    }
    case 'ChangedFile': {
      switch (sel.name) {
        case 'path': return node.file.filename;
        case 'additions': return node.file.additions;
        case 'deletions': return node.file.deletions;
        case 'changes': return node.file.changes;
        default: return null;
      }
    }
    case 'Comment': {
      switch (sel.name) {
        case 'id': return commentGlobalId(node.repo, node.issue.number, node.comment.id);
        case 'databaseId': return node.comment.id;
        case 'body': return node.comment.body;
        case 'createdAt': return node.comment.createdAt;
        case 'updatedAt': return node.comment.updatedAt;
        case 'author': case 'user': return executeSelections(exec, { kind: 'User', login: node.comment.user }, sel.selections);
        case 'url': return '';
        default: return null;
      }
    }
    case 'CommentEdge': {
      if (sel.name === 'node') return executeSelections(exec, node.node, sel.selections);
      if (sel.name === 'cursor') return '';
      return null;
    }
    case 'Edge': {
      if (sel.name === 'node') return executeSelections(exec, node.node, sel.selections);
      if (sel.name === 'cursor') return node.cursor;
      return null;
    }
    case 'PageInfo': {
      switch (sel.name) {
        case 'hasNextPage': return node.info.hasNextPage;
        case 'hasPreviousPage': return node.info.hasPreviousPage;
        case 'startCursor': return node.info.startCursor;
        case 'endCursor': return node.info.endCursor;
        default: return null;
      }
    }
    case 'Type': {
      const info = INTROSPECTION[node.name];
      switch (sel.name) {
        case 'name': return node.name;
        case 'kind': return info !== undefined && info.enumValues.length > 0 ? 'ENUM' : 'OBJECT';
        case 'description': return null;
        case 'fields': {
          const fields = info?.fields ?? [];
          return fields.map((name) => ({ name }));
        }
        case 'enumValues': {
          const values = info?.enumValues ?? [];
          return values.map((name) => ({ name }));
        }
        default: return null;
      }
    }
    case 'Schema': {
      switch (sel.name) {
        case 'types': return Object.keys(INTROSPECTION).map((name) => ({ name }));
        case 'queryType': return { name: 'Query' };
        case 'mutationType': return { name: 'Mutation' };
        case 'subscriptionType': return null;
        case 'directives': return [];
        default: return null;
      }
    }
    case 'Payload': {
      const value = node.fields[sel.name];
      if (value !== undefined && typeof value === 'object' && value !== null && 'kind' in (value as Record<string, unknown>)) {
        return executeSelections(exec, value as GNode, sel.selections);
      }
      return value ?? null;
    }
    default:
      return null;
  }
}

function executeMutation(exec: ExecCtx, sel: FieldSel): unknown {
  const { ctx } = exec;
  const store = ctx.store;
  const input = (resolveValue(sel.args['input'] as ValueNode, exec.variables) ?? {}) as Record<string, unknown>;
  // Payload wrappers are executed via executeSelections on a Payload node, so
  // build the node and let the generic path render the requested subfields.
  const payloadFor = (fields: Record<string, GNode | unknown>): unknown =>
    executeSelections(exec, { kind: 'Payload', fields }, sel.selections);

  if (sel.name === 'createIssue') {
    const resolved = resolveGlobalId(String(input['repositoryId'] ?? ''));
    const repo = resolved !== null && resolved.kind === 'repo' ? findRepoById(store, resolved.repoId) : undefined;
    if (repo === undefined) {
      exec.errors.push({ message: 'Could not resolve repositoryId to a repository' });
      return null;
    }
    const created = createIssueInStore(store, repo, String(input['title'] ?? ''), String(input['body'] ?? ''), []);
    if ('error' in created) {
      exec.errors.push({ message: created.error });
      return null;
    }
    return payloadFor({ issue: { kind: 'Issue', repo, issue: created.issue } });
  }
  if (sel.name === 'closeIssue') {
    const resolved = resolveGlobalId(String(input['issueId'] ?? ''));
    const repo = resolved !== null ? findRepoById(store, resolved.repoId) : undefined;
    const issue = repo !== undefined && resolved?.kind === 'issue' ? repo.issues.get(resolved.number ?? -1) : undefined;
    if (repo === undefined || issue === undefined) {
      exec.errors.push({ message: 'Could not resolve issueId to an issue' });
      return null;
    }
    issue.state = 'closed';
    issue.updatedAt = store.nowIso();
    return payloadFor({ issue: { kind: 'Issue', repo, issue } });
  }
  if (sel.name === 'createPullRequest') {
    const resolved = resolveGlobalId(String(input['repositoryId'] ?? ''));
    const repo = resolved !== null && resolved.kind === 'repo' ? findRepoById(store, resolved.repoId) : undefined;
    if (repo === undefined) {
      exec.errors.push({ message: 'Could not resolve repositoryId to a repository' });
      return null;
    }
    const created = createPullInStore(
      store,
      repo,
      String(input['headRefName'] ?? ''),
      String(input['baseRefName'] ?? ''),
      String(input['title'] ?? ''),
      String(input['body'] ?? ''),
    );
    if ('error' in created) {
      exec.errors.push({ message: created.error });
      return null;
    }
    return payloadFor({ pullRequest: { kind: 'PullRequest', repo, pull: created.pull } });
  }
  if (sel.name === 'mergePullRequest') {
    const resolved = resolveGlobalId(String(input['pullRequestId'] ?? ''));
    const repo = resolved !== null ? findRepoById(store, resolved.repoId) : undefined;
    const pull = repo !== undefined && resolved?.kind === 'pull' ? repo.pulls.get(resolved.number ?? -1) : undefined;
    if (repo === undefined || pull === undefined) {
      exec.errors.push({ message: 'Could not resolve pullRequestId to a pull request' });
      return null;
    }
    const merged = mergePullInStore(store, repo, pull);
    if ('error' in merged) {
      exec.errors.push({ message: merged.message });
      return null;
    }
    return payloadFor({ pullRequest: { kind: 'PullRequest', repo, pull } });
  }
  if (sel.name === 'addComment') {
    const resolved = resolveGlobalId(String(input['subjectId'] ?? ''));
    const repo = resolved !== null ? findRepoById(store, resolved.repoId) : undefined;
    const issue = repo !== undefined && resolved?.kind === 'issue' ? repo.issues.get(resolved.number ?? -1) : undefined;
    if (repo === undefined || issue === undefined) {
      exec.errors.push({ message: 'Could not resolve subjectId to an issue' });
      return null;
    }
    const comment = addCommentInStore(store, repo, issue, String(input['body'] ?? ''));
    return payloadFor({ commentEdge: { kind: 'CommentEdge', node: { kind: 'Comment', repo, issue, comment } }, comment: { kind: 'Comment', repo, issue, comment } });
  }
  return null;
}

function runOperation(
  ctx: Ctx,
  doc: { operations: Operation[]; fragments: Map<string, { typeCondition: string; selections: Selection[] }> },
  operationName: string | undefined,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  let operation = doc.operations[0] as Operation | undefined;
  if (operationName !== undefined) {
    operation = doc.operations.find((o) => o.name === operationName);
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  }
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'Unknown operation' }] };
  }
  const exec: ExecCtx = { ctx, variables, fragments: doc.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(rootType, operation.selections, doc.fragments, exec.errors);
  if (exec.errors.length > 0) {
    return { data: null, errors: exec.errors };
  }
  const rootNode: GNode = operation.type === 'mutation' ? { kind: 'Mutation' } : { kind: 'Query' };
  const data = executeSelections(exec, rootNode, operation.selections);
  if (exec.errors.length > 0) {
    return { data, errors: exec.errors };
  }
  return { data };
}

export function handleGraphQL(
  ctx: Ctx,
  method: string,
  path: string,
  _query: URLSearchParams,
  _headers: Record<string, string | undefined>,
  body: Buffer | null,
): HandlerResult | null {
  if (path !== '/api/graphql' && path !== '/api/graphql/') return null;
  if (method !== 'POST') {
    return jsonReply(404, { message: 'Not Found' }, {}, 'gql');
  }
  if (!ctx.authed) {
    return jsonReply(401, { message: 'Requires authentication' }, {}, 'gql');
  }
  if (body === null || body.length === 0) {
    return jsonReply(400, { message: 'Request body is required' }, {}, 'gql');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonReply(400, { message: 'Malformed JSON in request body' }, {}, 'gql');
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    const rec = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
    const queryText = typeof rec['query'] === 'string' ? (rec['query'] as string) : '';
    const variables = rec['variables'] !== null && typeof rec['variables'] === 'object' && !Array.isArray(rec['variables'])
      ? (rec['variables'] as Record<string, unknown>)
      : {};
    const operationName = typeof rec['operationName'] === 'string' ? (rec['operationName'] as string) : undefined;
    if (queryText === '') return { data: null, errors: [{ message: 'Missing query' }] };
    let doc;
    try {
      doc = new Parser(tokenize(queryText)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Failed to parse query' }] };
    }
    if (doc.operations.length === 0) return { data: null, errors: [{ message: 'No operation found in query' }] };
    return runOperation(ctx, doc, operationName, variables);
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => runOne(entry));
    return jsonReply(200, results, {}, 'gql');
  }
  return jsonReply(200, runOne(parsed), {}, 'gql');
}
