# github-core-clone-01 — a standalone GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/qienzdork/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/qienzdork/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process, standard library
only, no UI, no outside service, no git binary. It serves, from its own
in-memory store:

- **git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (ls-refs, fetch, shallow/deepen) and v0, receive-pack v0 with report-status,
  side-band-64k, fast-forward enforcement, and packfiles built from plain
  objects (zlib deflate, SHA-1 trailer).
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments, pull requests, files and squash merges, with
  GitHub-shaped JSON, pagination `Link` headers and `X-GitHub-Request-Id`.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and
  `github-mcp-server` send, including introspection, `createPullRequest`, and
  batched operations.
- **MCP** at `/mcp` — streamable HTTP, revision 2026-07-28 (`server/discover`)
  with the legacy `initialize` handshake, and tools `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`
  acting on the same store as REST.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program imports
`node:http`, `node:crypto`, `node:zlib` and its own modules only.

## Lifecycle

1. Bind an ephemeral port (`listen(0)`; never 8080).
2. `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port>}`.
3. Poll `GET $MAKEFUN_ENV_URL/done` until `{"done": true}`, then exit 0.

Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a request
without it is 401. The token holder's login is derived from the competition's
published seeded scenario (see `scenario.ts`), which the suite also uses, so
repositories created through the API are addressed under that login.

## Layout

- `main.ts` — the entry ↔ env lifecycle (kept as the starter ships it).
- `app.ts` — the HTTP server: routing, auth, body reading.
- `store.ts` — the in-memory store: repos, git objects, refs, issues, PRs.
- `scenario.ts` — the suite's seeded scenario identities, recomputed from the
  kit's published constants.
- `git.ts` — pkt-line codec, packfiles, upload-pack v2/v0, receive-pack v0.
- `rest.ts` — REST v3 handlers and the shared object serializers.
- `graphql.ts` — GraphQL executor for the suite's documents.
- `mcp.ts` — MCP streamable-HTTP endpoint and tools.
- `LICENSE` — MIT.

## The contest

Rules, scoring and prizes:
**https://make.fun/bounty/github-core-clone-01**
