// The server app: one HTTP surface for git smart HTTP, REST v3, GraphQL v4, MCP and lifecycle routes.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { generateUsers } from './scenario.ts';
import { handleGitRequest } from './git-http.ts';
import { handleRest, requestId, setOrigin } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

const VIEWER = generateUsers(12)[0].login;
const store = new Store(VIEWER);

/** The bearer token the entry receives; every API call must carry it, /healthz takes none. */
let expectedToken: string | null = null;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  // A cached exact response string (the issue cache's) is reused verbatim; anything else is
  // serialized as before.
  const text = body === null || body === undefined
    ? ''
    : typeof body === 'object' && body !== null && '_cachedJson' in (body as Record<string, unknown>)
      ? ((body as Record<string, unknown>)._cachedJson as string)
      : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    ...(text !== '' ? { 'content-length': Buffer.byteLength(text) } : {}),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

function pathOf(req: IncomingMessage): URL {
  // Fast path: a plain absolute path needs no URL constructor (fetch sends one; proxies may not).
  const raw = req.url ?? '/';
  if (raw.charCodeAt(0) === 0x2f && !raw.includes('..')) {
    return new URL(raw, 'http://entry');
  }
  try {
    return new URL(raw, 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

function authed(req: IncomingMessage): boolean {
  if (expectedToken === null) {
    // Dev/practice mode: any non-empty Bearer token is accepted; a missing one is not.
    const header = req.headers.authorization ?? '';
    return /^Bearer\s+\S+/.test(header.trim());
  }
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${expectedToken}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function repoSegs(path: string): { owner: string; repo: string; rest: string } | null {
  // /<owner>/<repo>(.git)/...
  const m = /^\/([^/]+)\/([^/]+?)(?:\.git)?(\/.*|\/?)$/.exec(path);
  if (m === null) return null;
  return { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]), rest: m[3] ?? '' };
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = pathOf(req);
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    try {
      // Lifecycle: the boot probe. No auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      const isAuthed = authed(req);
      const host = req.headers.host ?? 'forge.local';
      setOrigin(`http://${host}`);

      // REST v3 root.
      if (path === '/api/v3' || path === '/api/v3/') {
        if (!isAuthed) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
        sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }

      // REST v3 API.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!isAuthed) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        let parsedBody: unknown = undefined;
        if (body.length > 0 && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
          try {
            parsedBody = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
        }
        const apiRes = handleRest(store, method, path, url.searchParams, parsedBody, true);
        sendJson(res, apiRes.status, apiRes.body, apiRes.headers);
        return;
      }

      // GraphQL v4.
      if (path === '/api/graphql') {
        const text = body.toString('utf8');
        if (!isAuthed) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
        const gqlRes = handleGraphQL(store, text, true);
        sendJson(res, gqlRes.status, gqlRes.body);
        return;
      }

      // MCP.
      if (path === '/mcp') {
        const text = body.toString('utf8');
        const mcpRes = handleMcp(store, text, isAuthed, method, req.headers['mcp-session-id'] ?? null);
        const headers = mcpRes.headers ?? {};
        if (mcpRes.body === null || mcpRes.body === undefined) {
          res.writeHead(mcpRes.status, { 'content-length': 0, ...headers });
          res.end();
          return;
        }
        sendJson(res, mcpRes.status, mcpRes.body, headers);
        return;
      }

      // Git smart HTTP: /<owner>/<repo>.git/info/refs?service=... and the service POST routes.
      const segs = repoSegs(path);
      if (segs !== null) {
        const service = segs.rest.startsWith('/info/refs')
          ? (url.searchParams.get('service') === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack')
          : segs.rest === '/git-upload-pack'
            ? 'git-upload-pack'
            : segs.rest === '/git-receive-pack'
              ? 'git-receive-pack'
              : null;
        if (service !== null) {
          const repo = store.get(segs.owner, segs.repo);
          if (repo === null) {
            // A missing repository advertises 404 for both info/refs and service POSTs.
            if (isAuthed || expectedToken === null) {
              sendJson(res, 404, { message: 'Not Found' });
            } else {
              sendJson(res, 401, { message: 'Requires authentication' });
            }
            return;
          }
          const isInfoRefs = segs.rest.startsWith('/info/refs');
          if (!isInfoRefs && method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const protocolVersion = (req.headers['git-protocol'] ?? undefined) as string | undefined;
          const gitRes = handleGitRequest({
            store, repo, service, isInfoRefs,
            protocolVersion: protocolVersion === 'version=2' ? '2' : protocolVersion,
            body,
          });
          if (gitRes === null) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          sendBuffer(res, gitRes.status, gitRes.contentType, gitRes.body);
          return;
        }
      }

      // Anything else: GitHub's JSON 404.
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      sendJson(res, 500, { message: 'Internal Server Error' });
    }
  });
}

/** The token every API call must present; set once at boot from the environment. */
export function setExpectedToken(token: string | null): void {
  expectedToken = token;
}
