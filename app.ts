// The forge's HTTP server: routing, auth, body reading, response writing.
// All surfaces (git smart HTTP, REST v3, GraphQL v4, MCP) share one Store and
// one token. Node 22 stdlib only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { scenarioIdentities } from './scenario.ts';
import { handleRest, type Ctx, type HandlerResult } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

let fallbackReqCounter = 0;

function sendResult(res: ServerResponse, result: HandlerResult): void {
  const headers: Record<string, string> = { ...result.headers };
  if (result.contentType !== '') headers['content-type'] = result.contentType;
  headers['content-length'] = String(result.body.length);
  if (headers['x-github-request-id'] === undefined) {
    fallbackReqCounter += 1;
    headers['x-github-request-id'] = `forge-${fallbackReqCounter}`;
  }
  res.writeHead(result.status, headers);
  res.end(result.body);
}

function sendJson404(res: ServerResponse): void {
  const body = Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8');
  fallbackReqCounter += 1;
  res.writeHead(404, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'x-github-request-id': `forge-${fallbackReqCounter}`,
  });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      if (tooBig) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) {
        resolve(null);
        return;
      }
      resolve(chunks.length === 0 ? null : Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const nowIso = process.env.MAKEFUN_TRIAL_NOW ?? '2025-01-01T00:00:00Z';
  const store = new Store(nowIso);
  const viewerLogin = scenarioIdentities().viewer;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const path = pathOf(req);
        const url = new URL(req.url ?? '/', 'http://entry');
        const query = url.searchParams;
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
        }
        const authHeader = headers['authorization'] ?? '';
        const authed = token !== '' && authHeader === `Bearer ${token}`;
        const ctx: Ctx = { store, token, viewerLogin, authed };

        if (method === 'GET' && path === '/healthz') {
          const body = Buffer.from(JSON.stringify({ ok: true }), 'utf8');
          fallbackReqCounter += 1;
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(body.length),
            'x-github-request-id': `forge-${fallbackReqCounter}`,
          });
          res.end(body);
          return;
        }

        const body = await readBody(req);

        const rest = handleRest(ctx, method, path, query, headers, body);
        if (rest !== null) {
          sendResult(res, rest);
          return;
        }
        const gql = handleGraphQL(ctx, method, path, query, headers, body);
        if (gql !== null) {
          sendResult(res, gql);
          return;
        }
        const mcp = handleMcp(ctx, method, path, query, headers, body);
        if (mcp !== null) {
          sendResult(res, mcp);
          return;
        }
        const git = handleGit(ctx, method, path, query, headers, body ?? Buffer.alloc(0));
        if (git !== null) {
          sendResult(res, git);
          return;
        }
        sendJson404(res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const body = Buffer.from(JSON.stringify({ message: `Internal Server Error: ${message}` }), 'utf8');
        fallbackReqCounter += 1;
        try {
          res.writeHead(500, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(body.length),
            'x-github-request-id': `forge-${fallbackReqCounter}`,
          });
          res.end(body);
        } catch {
          // The socket is gone; nothing left to do.
        }
      }
    })();
  });
}
