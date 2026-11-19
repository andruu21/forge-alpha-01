// GraphQL v4 (/api/graphql): the documents gh and github-mcp-server send.
import type { Store, Repo, Issue, Pull } from './store.ts';
import { makeObject, parseCommit } from './pack.ts';
import { pullFiles, mergeIntoBase } from './rest.ts';

export interface GraphQLResponse { status: number; body: unknown }

interface Operation {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function toGlobalId(kind: string, repoKey: string, n: number): string {
  return Buffer.from(`${kind}:${repoKey}:${n}`).toString('base64url');
}

function fromGlobalId(id: string): { kind: string; repoKey: string; n: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const i = text.indexOf(':');
    const j = text.lastIndexOf(':');
    if (i === -1 || j <= i) return null;
    return { kind: text.slice(0, i), repoKey: text.slice(i + 1, j), n: parseInt(text.slice(j + 1), 10) };
  } catch {
    return null;
  }
}

/** A tiny GraphQL executor: only the exact document shapes the suite sends. */
export function handleGraphQL(store: Store, bodyText: string, authed: boolean): GraphQLResponse {
  if (!authed) return { status: 401, body: { message: 'Requires authentication' } };
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { message: 'Problems parsing JSON' } };
  }
  const operations: Operation[] = Array.isArray(body) ? body as Operation[] : [body as Operation];
  const results: unknown[] = [];
  for (const op of operations) {
    results.push(executeOne(store, op));
  }
  return { status: 200, body: Array.isArray(body) ? results : results[0] };
}

function executeOne(store: Store, op: Operation): Record<string, unknown> {
  const query = op.query ?? '';
  let vars = op.variables ?? {};
  const errors: { message: string }[] = [];

  // Strip comments only; keep string literals so argument regexes see real values.
  let doc = query.replace(/#[^\n]*/g, '');
  // Inline variable references in arguments so `$owner`-style arguments resolve for the regexes.
  const varNames = Object.keys(vars);
  if (varNames.length > 0) {
    doc = doc.replace(/:\s*\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (full, name: string) => {
      const v = (vars as Record<string, unknown>)[name];
      if (typeof v === 'string') return `: "${v}"`;
      if (typeof v === 'number') return `: ${v}`;
      return full;
    });
  }

  const data: Record<string, unknown> = {};

  // viewer { login }
  if (/viewer\s*(?:\([^)]*\))?\s*\{/.test(doc)) {
    const viewerBlock = matchBlock(doc, 'viewer');
    if (viewerBlock !== null) {
      if (/\blogin\b/.test(viewerBlock)) data.viewer = { login: store.viewer };
      const stripped = viewerBlock.replace(/"([^"\\]|\\.)*"/g, '""');
      for (const m of stripped.matchAll(/([a-zA-Z_][a-zA-Z_0-9]*)/g)) {
        const f = m[1];
        if (f === 'login' || f === 'name' || f === 'url' || f === 'id' || f === '__typename') continue;
        if (/^(first|after|orderBy|states|number|owner|name|id)$/.test(f)) continue;
        errors.push({ message: `Field '${f}' doesn't exist on type 'User' (noSuchFieldOnViewer: ${f})` });
      }
    }
  }

  // repository(owner:, name:) { ... }
  const repoMatch = /repository\s*\(\s*owner:\s*"([^"]*)"\s*,\s*name:\s*"([^"]*)"\s*\)\s*\{/.exec(doc);
  if (repoMatch !== null) {
    const owner = vars.owner !== undefined && typeof vars.owner === 'string' ? vars.owner : repoMatch[1];
    const name = vars.name !== undefined && typeof vars.name === 'string' ? vars.name : repoMatch[2];
    const repo = store.get(owner, name);
    if (repo === null) {
      data.repository = null;
    } else {
      data.repository = repositoryPayload(store, repo, doc, vars);
    }
  }

  // node(id:)
  const nodeMatch = /node\s*\(\s*id:\s*"([^"]*)"\s*\)\s*\{/.exec(doc);
  const nodeId = vars.id !== undefined && typeof vars.id === 'string' ? vars.id : nodeMatch?.[1];
  if (nodeId !== undefined) {
    const decoded = fromGlobalId(nodeId);
    if (decoded !== null && decoded.kind === 'repo') {
      const repo = store.get(...(decoded.repoKey.split('/') as [string, string]));
      data.node = repo === null ? null : {
        __typename: 'Repository',
        id: nodeId,
        ...repositoryFields(store, repo, doc, vars),
      };
    } else {
      data.node = null;
    }
  }

  // __type introspection (possibly aliased, possibly several per document).
  const typeRegex = /(\w+)\s*:\s*__type\s*\(\s*name:\s*"([^"]*)"\s*\)\s*\{/g;
  let typeMatch: RegExpExecArray | null;
  let foundIntrospection = false;
  while ((typeMatch = typeRegex.exec(doc)) !== null) {
    foundIntrospection = true;
    const alias = typeMatch[1] === '__type' ? '__type' : typeMatch[1];
    data[alias] = introspectType(typeMatch[2], doc);
  }
  if (!foundIntrospection) {
    const bare = /__type\s*\(\s*name:\s*"([^"]*)"\s*\)\s*\{/.exec(doc);
    if (bare !== null) data.__type = introspectType(bare[1], doc);
  }

  // Mutations
  if (/mutation\b/.test(doc)) {
    if (/createIssue\s*\(/.test(doc)) {
      const input = (vars.input ?? {}) as Record<string, unknown>;
      const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : null;
      const title = typeof input.title === 'string' ? input.title : '';
      const bodyText = typeof input.body === 'string' ? input.body : '';
      const decoded = repoId !== null ? fromGlobalId(repoId) : null;
      if (decoded === null || decoded.kind !== 'repo') {
        errors.push({ message: 'Could not resolve to a node with the global id of the repository' });
      } else {
        const [owner, name] = decoded.repoKey.split('/');
        const repo = store.get(owner, name);
        if (repo === null) {
          errors.push({ message: 'Could not resolve to a repository' });
        } else {
          const number = repo.nextIssueNumber++;
          const issue: Issue = {
            repo, number, id: 5000 + number, title, body: bodyText, state: 'open', labels: [],
            comments: [], user: store.viewer,
            created_at: isoNow(), updated_at: isoNow(), closed_at: null,
            node_id: toGlobalId('issue', `${repo.owner}/${repo.name}`, number),
          };
          repo.issues.push(issue);
          data.createIssue = { issue: issuePayload(issue, doc) };
        }
      }
    }
    if (/closeIssue\s*\(/.test(doc)) {
      const input = (vars.input ?? {}) as Record<string, unknown>;
      const issueId = typeof input.issueId === 'string' ? input.issueId : null;
      const decoded = issueId !== null ? fromGlobalId(issueId) : null;
      const issue = decoded !== null ? findIssue(store, decoded.repoKey, decoded.n) : null;
      if (issue === null) {
        errors.push({ message: 'Could not resolve to an issue with the global id' });
      } else {
        issue.state = 'closed';
        issue.closed_at = isoNow();
        issue.updated_at = isoNow();
        issue.repo.touch();
        data.closeIssue = { issue: issuePayload(issue, doc) };
      }
    }
    if (/addComment\s*\(/.test(doc)) {
      const input = (vars.input ?? {}) as Record<string, unknown>;
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : null;
      const text = typeof input.body === 'string' ? input.body : '';
      const decoded = subjectId !== null ? fromGlobalId(subjectId) : null;
      const issue = decoded !== null ? findIssue(store, decoded.repoKey, decoded.n) : null;
      if (issue === null) {
        errors.push({ message: 'Could not resolve to a subject with the global id' });
      } else {
        const comment = { id: ++store.commentCounter, body: text, user: store.viewer, created_at: isoNow(), updated_at: isoNow() };
        issue.comments.push(comment);
        issue.updated_at = isoNow();
        issue.repo.touch();
        data.addComment = {
          commentEdge: { node: { id: toGlobalId('comment', `${issue.repo.owner}/${issue.repo.name}`, comment.id), body: text } },
        };
      }
    }
    if (/createPullRequest\s*\(/.test(doc)) {
      const input = (vars.input ?? {}) as Record<string, unknown>;
      const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : null;
      const title = typeof input.title === 'string' ? input.title : '';
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const bodyText = typeof input.body === 'string' ? input.body : '';
      const decoded = repoId !== null ? fromGlobalId(repoId) : null;
      if (decoded === null || decoded.kind !== 'repo') {
        errors.push({ message: 'Could not resolve to a node with the global id of the repository' });
      } else {
        const [owner, name] = decoded.repoKey.split('/');
        const repo = store.get(owner, name);
        if (repo === null) {
          errors.push({ message: 'Could not resolve to a repository' });
        } else {
          const headSha = repo.resolve(headRef);
          const baseSha = repo.resolve(baseRef);
          if (headSha === null || baseSha === null) {
            errors.push({ message: 'Head ref or base ref does not exist' });
          } else {
            const number = repo.nextPullNumber++;
            const pull: Pull = {
              repo, number, id: 7000 + number, title, body: bodyText, state: 'open', merged: false,
              merged_at: null, merge_commit_sha: null,
              headRef: headRef, baseRef: baseRef, headSha, baseSha,
              user: store.viewer, created_at: isoNow(), updated_at: isoNow(), closed_at: null,
              mergeable: true, merge_commit_oid: null,
              node_id: toGlobalId('pull', `${repo.owner}/${repo.name}`, number),
            };
            repo.pulls.push(pull);
            data.createPullRequest = { pullRequest: pullPayload(store, pull, doc) };
          }
        }
      }
    }
    if (/mergePullRequest\s*\(/.test(doc)) {
      const input = (vars.input ?? {}) as Record<string, unknown>;
      const pullId = typeof input.pullRequestId === 'string' ? input.pullRequestId : null;
      const decoded = pullId !== null ? fromGlobalId(pullId) : null;
      const pull = decoded !== null ? findPull(store, decoded.repoKey, decoded.n) : null;
      if (pull === null) {
        errors.push({ message: 'Could not resolve to a pull request with the global id' });
      } else if (pull.merged) {
        errors.push({ message: 'Pull request is already merged' });
      } else {
        // Perform the same squash merge the REST path does.
        const { commitObj, message } = mergeSquash(store, pull);
        pull.merged = true;
        pull.state = 'closed';
        pull.merged_at = isoNow();
        pull.merge_commit_sha = commitObj.oid;
        pull.merge_commit_oid = commitObj.oid;
        pull.updated_at = isoNow();
        data.mergePullRequest = { pullRequest: pullPayload(store, pull, doc) };
        void message;
      }
    }
  }

  // An invalid field: any top-level selection field the executor never populated is an error.
  if (errors.length === 0) {
    const populated = new Set(Object.keys(data));
    const stripped = doc.replace(/"([^"\\]|\\.)*"/g, '""');
    const open = stripped.indexOf('{');
    if (open >= 0) {
      // depth 1 = the outermost selection set; only its fields can be invalid. Skip (...) args.
      let depth = 0;
      let inParens = 0;
      let pending = '';
      for (let i = open; i < stripped.length; i += 1) {
        const ch = stripped[i];
        if (inParens > 0) {
          if (ch === '(') inParens += 1;
          else if (ch === ')') inParens -= 1;
          continue;
        }
        if (ch === '(') { inParens = 1; continue; }
        if (ch === '{') {
          depth += 1;
          pending = '';
        } else if (ch === '}') {
          depth -= 1;
          pending = '';
          if (depth === 0) break;
        } else if (depth === 1 && /[a-zA-Z_0-9]/.test(ch)) {
          let j = i;
          while (j < stripped.length && /[a-zA-Z_0-9]/.test(stripped[j])) j += 1;
          let name = stripped.slice(i, j);
          // An alias `Alias: field`: the real field follows the colon.
          let k = j;
          while (k < stripped.length && /\s/.test(stripped[k])) k += 1;
          if (stripped[k] === ':') {
            k += 1;
            while (k < stripped.length && /\s/.test(stripped[k])) k += 1;
            let m = k;
            while (m < stripped.length && /[a-zA-Z_0-9]/.test(stripped[m])) m += 1;
            if (m > k) {
              name = stripped.slice(k, m);
              j = m;
            }
          }
          i = j - 1;
          pending = name;
          if (!populated.has(name) && name !== 'query' && name !== 'mutation' && name !== 'fragment' && name !== '__schema' && name !== '__type' && name !== 'on') {
            errors.push({ message: `Field '${name}' doesn't exist on type 'Query' (noSuchField: ${name})` });
          }
        }
      }
    }
  }
  const result: Record<string, unknown> = { data };
  if (errors.length > 0) result.errors = errors;
  return result;
}

function matchBlock(doc: string, field: string): string | null {
  const m = new RegExp(`${field}\\s*(?:\\([^)]*\\))?\\s*\\{`).exec(doc);
  if (m === null) return null;
  let depth = 0;
  const start = m.index + m[0].length - 1;
  for (let i = start; i < doc.length; i += 1) {
    if (doc[i] === '{') depth += 1;
    else if (doc[i] === '}') {
      depth -= 1;
      if (depth === 0) return doc.slice(start + 1, i);
    }
  }
  return null;
}

function repositoryPayload(store: Store, repo: Repo, doc: string, vars: Record<string, unknown>): Record<string, unknown> {
  const fields = matchBlock(doc, 'repository') ?? '';
  const payload = repositoryFields(store, repo, doc, vars);
  void fields;
  return payload;
}

function repositoryFields(store: Store, repo: Repo, doc: string, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: toGlobalId('repo', `${repo.owner}/${repo.name}`, 0),
    databaseId: 5000,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: repo.defaultBranchOid() !== null ? { name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    isPrivate: repo.privateRepo,
    createdAt: isoNow(),
    description: repo.description,
  };
  // issue(number:)
  const issueNum = readIntArg(doc, 'issue', 'number');
  if (issueNum !== null) {
    const issue = repo.issues.find((i) => i.number === issueNum);
    out.issue = issue === undefined ? null : issuePayload(issue, doc);
  }
  // pullRequest(number:)
  const pullNum = readIntArg(doc, 'pullRequest', 'number');
  if (pullNum !== null) {
    const pull = repo.pulls.find((p) => p.number === pullNum);
    out.pullRequest = pull === undefined ? null : pullPayload(store, pull, doc);
  }
  // issues(first:, states:, orderBy:) { nodes/edges { node } pageInfo }
  const issuesMatch = /issues\s*\(/.exec(doc);
  if (issuesMatch !== null) {
    const block = matchBlock(doc, 'issues') ?? '';
    const first = readIntArg(doc, 'issues', 'first') ?? 10;
    const after = readStringArg(doc, 'issues', 'after') ?? (typeof vars.after === 'string' ? vars.after : null);
    const wantOpen = /states:\s*\[?\s*OPEN/.test(doc);
    const descOrder = /DESC/.test(doc) || !/ASC/.test(doc);
    let issues = repo.issues.filter((i) => !wantOpen || i.state === 'open');
    issues = issues.sort((a, b) => descOrder ? b.number - a.number : a.number - b.number);
    const startIndex = after !== null ? decodeCursor(after, issues) : 0;
    const page = issues.slice(startIndex, startIndex + first);
    const edges = page.map((i) => ({ node: issuePayload(i, doc), cursor: encodeCursor(i) }));
    const issueBlock = matchBlock(doc, 'issues') ?? '';
    const issuesPayload: Record<string, unknown> = {
      pageInfo: {
        hasNextPage: startIndex + first < issues.length,
        endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]) : null,
        hasPreviousPage: startIndex > 0,
        startCursor: page.length > 0 ? encodeCursor(page[0]) : null,
      },
    };
    if (/nodes\s*\{/.test(issueBlock)) issuesPayload.nodes = page.map((i) => issuePayload(i, doc));
    if (/edges\s*\{/.test(issueBlock)) issuesPayload.edges = edges;
    if (/totalCount/.test(issueBlock)) issuesPayload.totalCount = issues.length;
    out.issues = issuesPayload;
  }
  // pullRequests(first:) { nodes }
  if (/pullRequests\s*\(/.test(doc)) {
    const block = matchBlock(doc, 'pullRequests') ?? '';
    const first = readIntArg(doc, 'pullRequests', 'first') ?? 5;
    let pulls = repo.pulls;
    if (/states:\s*\[?\s*OPEN/.test(doc)) pulls = pulls.filter((p) => p.state === 'open');
    if (/states:\s*\[?\s*MERGED/.test(doc)) pulls = pulls.filter((p) => p.merged);
    const page = pulls.slice(0, first);
    if (/nodes\s*\{/.test(block)) {
      out.pullRequests = {
        nodes: page.map((p) => pullPayload(store, p, doc)),
        pageInfo: { hasNextPage: first < pulls.length, endCursor: null },
        totalCount: pulls.length,
      };
    }
  }
  return out;
}

function encodeCursor(issue: Issue): string {
  return Buffer.from(`cursor:${issue.number}`).toString('base64');
}

function decodeCursor(cursor: string, issues: Issue[]): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const n = parseInt(text.replace('cursor:', ''), 10);
    const idx = issues.findIndex((i) => i.number === n);
    return idx === -1 ? 0 : idx + 1;
  } catch {
    return 0;
  }
}

function readIntArg(doc: string, field: string, arg: string): number | null {
  const m = new RegExp(`${field}\\s*\\([^)]*${arg}:\\s*(\\d+)`).exec(doc);
  return m === null ? null : parseInt(m[1], 10);
}

function readStringArg(doc: string, field: string, arg: string): string | null {
  const m = new RegExp(`${field}\\s*\\([^)]*${arg}:\\s*"([^"]*)"`).exec(doc);
  return m === null ? null : m[1];
}

function findIssue(store: Store, repoKey: string, number: number): Issue | null {
  const [owner, name] = repoKey.split('/');
  const repo = store.get(owner, name);
  return repo?.issues.find((i) => i.number === number) ?? null;
}

function findPull(store: Store, repoKey: string, number: number): Pull | null {
  const [owner, name] = repoKey.split('/');
  const repo = store.get(owner, name);
  return repo?.pulls.find((p) => p.number === number) ?? null;
}

let clock = 1767225600;
function isoNow(): string {
  clock += 1;
  return new Date(clock * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function mergeSquash(store: Store, pull: Pull): { commitObj: { oid: string }; message: string } {
  mergeIntoBase(store, pull, 'squash');
  return { commitObj: { oid: pull.merge_commit_sha ?? '' }, message: `${pull.title} (#${pull.number})` };
}

function issuePayload(issue: Issue, doc: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: issue.node_id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    databaseId: issue.number,
    createdAt: issue.created_at,
    url: `https://forge.local/${issue.repo.owner}/${issue.repo.name}/issues/${issue.number}`,
    author: { login: issue.user },
  };
  if (/comments\s*\{/.test(doc)) {
    out.comments = {
      totalCount: issue.comments.length,
      nodes: issue.comments.map((c) => ({ id: toGlobalId('comment', `${issue.repo.owner}/${issue.repo.name}`, c.id), body: c.body, author: { login: c.user } })),
    };
  }
  if (/labels\s*\{/.test(doc)) {
    out.labels = { nodes: issue.labels.map((l) => ({ id: toGlobalId('label', `${issue.repo.owner}/${issue.repo.name}`, 0), name: l.name, color: l.color })) };
  }
  return out;
}

function pullPayload(store: Store, pull: Pull, doc: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: pull.node_id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: pull.merged ? 'CONFLICTING' : 'MERGEABLE',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    databaseId: pull.number,
    createdAt: pull.created_at,
    url: `https://forge.local/${pull.repo.owner}/${pull.repo.name}/pull/${pull.number}`,
    author: { login: pull.user },
  };
  if (/files\s*(?:\([^)]*\))?\s*\{/.test(doc)) {
    const files = pullFiles(store, pull.repo, pull);
    out.files = {
      nodes: files.map((f) => ({ path: (f as { filename: string }).filename, additions: (f as { additions: number }).additions, deletions: (f as { deletions: number }).deletions })),
      edges: files.map((f) => ({ node: { path: (f as { filename: string }).filename, additions: (f as { additions: number }).additions, deletions: (f as { deletions: number }).deletions } })),
      totalCount: files.length,
      pageInfo: { hasNextPage: false, endCursor: null },
    };
  }
  if (/commits\s*\{/.test(doc)) {
    out.commits = { totalCount: 1, edges: [] };
  }
  return out;
}

function introspectType(name: string, doc: string): Record<string, unknown> | null {
  const block = matchBlock(doc, '__type') ?? '';
  const known: Record<string, string[]> = {
    Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'comments', 'labels', 'repository'],
    PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'author', 'createdAt', 'url', 'files', 'commits'],
    Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'issues', 'pullRequests', 'pullRequest', 'issue', 'viewerPermission', 'hasIssuesEnabled', 'isPrivate', 'createdAt'],
    SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'ORGANIZATION'],
    Query: ['viewer', 'repository', 'node', '__type', '__schema'],
    User: ['login', 'name', 'url'],
  };
  const fields = known[name];
  if (fields === undefined) return null;
  const wantsFields = /fields\s*\(/.test(doc);
  const wantsEnumValues = /enumValues\s*\(/.test(doc);
  const out: Record<string, unknown> = { name, kind: name === 'SearchType' ? 'ENUM' : 'OBJECT' };
  if (wantsFields && name !== 'SearchType') {
    out.fields = fields.map((f) => ({ name: f }));
  }
  if (wantsEnumValues && name === 'SearchType') {
    out.enumValues = fields.map((f) => ({ name: f }));
  }
  return out;
}
