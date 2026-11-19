// MCP endpoint (/mcp): streamable HTTP, JSON-RPC 2.0, initialize + tools/list + tools/call.
import type { Store } from './store.ts';
import { mergeIntoBase } from './rest.ts';

export interface McpResponse { status: number; body: unknown; headers?: Record<string, string> }

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        description: { type: 'string', description: 'The repository description' },
        auto_init: { type: 'boolean', description: 'Initialize with a README' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'The issue title' },
        body: { type: 'string', description: 'The issue body' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed, all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch to a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'The pull request title' },
        head: { type: 'string', description: 'The head branch name' },
        base: { type: 'string', description: 'The base branch name' },
        body: { type: 'string', description: 'The pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'The pull request number' },
        merge_method: { type: 'string', description: 'merge, squash or rebase' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function handleMcp(store: Store, bodyText: string, authed: boolean, method: string, sessionHeader: string | null): McpResponse {
  const headers: Record<string, string> = {
    'mcp-protocol-version': PROTOCOL_VERSION,
    'mcp-session-id': 'forge-session-1',
  };

  let reqs: JsonRpcRequest[];
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    reqs = Array.isArray(parsed) ? parsed as JsonRpcRequest[] : [parsed as JsonRpcRequest];
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }

  const responses: Record<string, unknown>[] = [];
  for (const req of reqs) {
    if (typeof req.method !== 'string') {
      responses.push(rpcError(req.id ?? null, -32600, 'Invalid Request'));
      continue;
    }
    // tools/call requires a token; other methods answer without one.
    if (!authed && req.method === 'tools/call') {
      return { status: 401, body: { message: 'Requires authentication' } };
    }
    const result = dispatch(store, req, authed);
    if (result === undefined) continue; // notification: no reply
    if ('_rpcError' in result) {
      responses.push(rpcError(req.id ?? null, result._rpcError.code, result._rpcError.message));
      continue;
    }
    responses.push(rpcResult(req.id ?? null, result));
  }
  if (responses.length === 0) return { status: 202, body: null };
  const wasBatched = Array.isArray(JSON.parse(bodyText));
  const body = wasBatched ? responses : responses[0];
  return { status: 200, body, headers };
}

/** Sentinel-shaped internal results. */
interface RpcErrorResult { _rpcError: { code: number; message: string } }

function dispatch(store: Store, req: JsonRpcRequest, authed: boolean): Record<string, unknown> | RpcErrorResult | undefined {
  const params = req.params ?? {};
  switch (req.method) {
    case 'initialize': {
      const clientVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0];
      const negotiated = SUPPORTED_VERSIONS.includes(clientVersion) ? clientVersion : SUPPORTED_VERSIONS[0];
      return {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'forge-mcp-server', version: '1.0.0' },
        instructions: 'A GitHub-compatible forge.',
      };
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined;
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return callTool(store, params);
    default:
      return { _rpcError: { code: -32601, message: `Method not found: ${req.method}` } };
  }
}

function callTool(store: Store, params: Record<string, unknown>): Record<string, unknown> | RpcErrorResult {
  const name = typeof params.name === 'string' ? params.name : '';
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined || name === '') {
    return { _rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  // Required-argument validation.
  const missing: string[] = [];
  for (const req of tool.inputSchema.required) {
    if (args[req] === undefined || args[req] === null) missing.push(req);
  }
  if (missing.length > 0) {
    return { _rpcError: { code: -32602, message: `Missing required arguments: ${missing.join(', ')}` } };
  }
  try {
    return executeTool(store, tool.name, args);
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

function executeTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const priv = args.private === true;
      const description = typeof args.description === 'string' ? args.description : '';
      if (store.get(store.viewer, repoName) !== null) {
        return textResult(`Repository ${repoName} already exists`, true);
      }
      const repo = store.createRepo(store.viewer, repoName, priv, description, 'main', store.repos.size + 1);
      return jsonResult({ id: 5000, node_id: store.globalId('repo', `${repo.owner}/${repo.name}`, 0), name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: priv, owner: { login: repo.owner }, description, default_branch: repo.defaultBranch });
    }
    case 'get_repo': {
      const repo = store.get(String(args.owner), String(args.repo));
      if (repo === null) return textResult(`Repository ${args.owner}/${args.repo} not found`, true);
      return jsonResult({ id: 5000, node_id: store.globalId('repo', `${repo.owner}/${repo.name}`, 0), name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.privateRepo, owner: { login: repo.owner }, description: repo.description, default_branch: repo.defaultBranch });
    }
    case 'create_issue': {
      const repo = store.get(String(args.owner), String(args.repo));
      if (repo === null) return textResult(`Repository ${args.owner}/${args.repo} not found`, true);
      const title = String(args.title);
      const number = repo.nextIssueNumber++;
      const issue = {
        repo, number, id: 5000 + number, title, body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const, labels: [], comments: [], user: store.viewer,
        created_at: isoNow(), updated_at: isoNow(), closed_at: null,
        node_id: store.globalId('issue', `${repo.owner}/${repo.name}`, number),
      };
      repo.issues.push(issue);
      return jsonResult({ id: issue.id, node_id: issue.node_id, number, title, body: issue.body, state: 'open', url: `https://forge.local/${repo.owner}/${repo.name}/issues/${number}` });
    }
    case 'list_issues': {
      const repo = store.get(String(args.owner), String(args.repo));
      if (repo === null) return textResult(`Repository ${args.owner}/${args.repo} not found`, true);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues.filter((i) => state === 'all' ? true : i.state === state);
      return jsonResult(issues.map((i) => ({ id: i.id, node_id: i.node_id, number: i.number, title: i.title, body: i.body, state: i.state, url: `https://forge.local/${repo.owner}/${repo.name}/issues/${i.number}` })));
    }
    case 'create_pull_request': {
      const repo = store.get(String(args.owner), String(args.repo));
      if (repo === null) return textResult(`Repository ${args.owner}/${args.repo} not found`, true);
      const head = String(args.head);
      const base = String(args.base);
      const headSha = repo.resolve(head);
      const baseSha = repo.resolve(base);
      if (headSha === null || baseSha === null) return textResult('Head or base branch not found', true);
      const title = String(args.title);
      const number = repo.nextPullNumber++;
      const pull = {
        repo, number, id: 7000 + number, title, body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const, merged: false, merged_at: null, merge_commit_sha: null,
        headRef: head, baseRef: base, headSha, baseSha,
        user: store.viewer, created_at: isoNow(), updated_at: isoNow(), closed_at: null,
        mergeable: true, merge_commit_oid: null,
        node_id: store.globalId('pull', `${repo.owner}/${repo.name}`, number),
      };
      repo.pulls.push(pull);
      return jsonResult({ id: pull.id, node_id: pull.node_id, number, title, state: 'open', head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha }, url: `https://forge.local/${repo.owner}/${repo.name}/pull/${number}` });
    }
    case 'merge_pull_request': {
      const repo = store.get(String(args.owner), String(args.repo));
      if (repo === null) return textResult(`Repository ${args.owner}/${args.repo} not found`, true);
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) return textResult(`Pull request ${number} not found`, true);
      if (pull.merged) return textResult('Pull request already merged', true);
      const merged = mergeIntoBase(store, pull, typeof args.merge_method === 'string' ? args.merge_method : 'merge');
      if (!merged) return textResult('Pull request is not mergeable', true);
      return jsonResult({ sha: pull.merge_commit_sha, merged: true, message: `Merged pull request #${number}` });
    }
    default:
      return textResult(`Unknown tool: ${name}`, true);
  }
}

function jsonResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: false, _json: value };
}

function textResult(text: string, isError: boolean): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError };
}

function isoNow(): string {
  return new Date(1767225600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
