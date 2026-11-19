// In-memory git repository store shared by the git, REST, GraphQL and MCP surfaces.
import { createHash } from 'node:crypto';
import {
  buildTree, hashObject, makeObject, parseCommit, parseTag, parseTree,
  resolvePack, ZERO_OID, type GitObject, type ObjectType, type ParsedCommit,
} from './pack.ts';

export interface RefUpdate { ref: string; oldOid: string; newOid: string; ok: boolean; failedReason?: string }

export class Repo {
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  headRef = 'refs/heads/main';
  readonly issues: Issue[] = [];
  readonly pulls: Pull[] = [];
  readonly labels: Label[] = [];
  nextIssueNumber = 1;
  nextPullNumber = 1;
  idCounter = 1;
  readonly owner: string;
  readonly name: string;
  readonly privateRepo: boolean;
  description: string;
  readonly defaultBranch: string;
  constructor(owner: string, name: string, privateRepo: boolean, description: string, defaultBranch: string) {
    this.owner = owner;
    this.name = name;
    this.privateRepo = privateRepo;
    this.description = description;
    this.defaultBranch = defaultBranch;
  }
  nextId(): number { return this.idCounter++; }

  has(oid: string): boolean { return this.objects.has(oid); }
  get(oid: string): GitObject | null { return this.objects.get(oid) ?? null; }
  put(obj: GitObject): void { this.objects.set(obj.oid, obj); }

  /** Parsed-commit cache: commit objects are immutable, so a parse result never goes stale. */
  private readonly commitCache = new Map<string, ParsedCommit>();
  parsedCommit(oid: string): ParsedCommit | null {
    let pc = this.commitCache.get(oid);
    if (pc !== undefined) return pc;
    const obj = this.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return null;
    pc = parseCommit(obj.data);
    this.commitCache.set(oid, pc);
    return pc;
  }

  /**
   * Cached upload-pack response for an identical fetch (same wants/haves/depth): building the pack
   * dominates a clone, and objects are immutable so a cached pack never goes stale.
   */
  readonly fetchPackCache = new Map<string, Buffer>();

  /**
   * Cached info/refs advertisements, cleared on every ref write. A push does one advertisement per
   * exchange and the ref set is unchanged between them, so this only rebuilds after a real update.
   */
  readonly advertisementCache = new Map<string, Buffer>();

  refValue(ref: string): string | null { return this.refs.get(ref) ?? null; }
  setRef(ref: string, oid: string): void { this.refs.set(ref, oid); this.advertisementCache.clear(); }
  deleteRef(ref: string): void { this.refs.delete(ref); this.advertisementCache.clear(); }

  /** Resolve a ref name or sha-ish to an oid; null when unknown. */
  resolve(name: string): string | null {
    if (/^[0-9a-f]{40}$/.test(name)) return this.objects.has(name) ? name : null;
    const candidates = [name, `refs/${name}`, `refs/heads/${name}`, `refs/tags/${name}`];
    for (const c of candidates) {
      const v = this.refs.get(c);
      if (v !== undefined) return v;
    }
    return null;
  }

  defaultBranchOid(): string | null {
    return this.refs.get(`refs/heads/${this.defaultBranch}`) ?? null;
  }

  headSymbolic(): string { return `refs/heads/${this.defaultBranch}`; }
}

export interface Label { readonly name: string; color: string; description: string | null }
export interface IssueComment { id: number; body: string; user: string; created_at: string; updated_at: string }
export interface Issue {
  repo: Repo; number: number; id: number; title: string; body: string;
  state: 'open' | 'closed'; labels: Label[]; comments: IssueComment[];
  user: string; created_at: string; updated_at: string; closed_at: string | null;
  node_id: string;
}
export interface Pull {
  repo: Repo; number: number; id: number; title: string; body: string;
  state: 'open' | 'closed'; merged: boolean; merged_at: string | null; merge_commit_sha: string | null;
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  user: string; created_at: string; updated_at: string; closed_at: string | null;
  mergeable: boolean; merge_commit_oid: string | null; node_id: string;
}

export class Store {
  readonly repos = new Map<string, Repo>(); // key: `${owner}/${name}`
  readonly viewer: string;
  issueCounter = 100;
  pullCounter = 100;
  commentCounter = 1000;
  nodeCounter = 1;

  constructor(viewerLogin: string) {
    this.viewer = viewerLogin;
  }

  /** Deterministic node id (global id): opaque base64 of a typed triple. */
  globalId(kind: string, repoKey: string, n: number): string {
    return Buffer.from(`${kind}:${repoKey}:${n}`, 'utf8').toString('base64url');
  }

  get(owner: string, name: string): Repo | null {
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  /** A stable per-repo numeric index (creation order), used for deterministic ids. */
  repoIndex(repo: Repo): number {
    let i = 0;
    for (const r of this.repos.values()) {
      if (r === repo) return i;
      i += 1;
    }
    return 0;
  }

  createRepo(owner: string, name: string, priv: boolean, description: string, defaultBranch: string, id: number): Repo {
    const repo = new Repo(owner, name, priv, description, defaultBranch);
    this.repos.set(`${owner}/${name}`, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  reposOf(owner: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === owner);
  }

  /** Commit a file change to a repo: builds blob/tree/commit objects. Returns the commit oid. */
  commitFile(repo: Repo, path: string, content: Buffer, message: string, branchOid: string | null, author: { name: string; email: string }, timestampSec: number): string {
    // Build the tree from the branch's current tree + path replacement.
    const entries = new Map<string, string>(); // full path -> oid
    const modes = new Map<string, string>();
    if (branchOid !== null) {
      const commit = repo.get(branchOid);
      if (commit !== null && commit.type === 'commit') {
        const pc = parseCommit(commit.data);
        this.flattenTree(repo, pc.tree, '', entries, modes);
      }
    }
    const blob = makeObject('blob', content);
    repo.put(blob);
    entries.set(path, blob.oid);
    modes.set(path, '100644');
    const treeOid = this.buildNestedTree(repo, entries, modes);
    const parentLine = branchOid !== null ? `parent ${branchOid}\n` : '';
    const ts = `${timestampSec} +0000`;
    const ident = `${author.name} <${author.email}>`;
    const commitData = Buffer.from(
      `tree ${treeOid}\n${parentLine}author ${ident} ${ts}\ncommitter ${ident} ${ts}\n\n${message}\n`,
    );
    const commit = makeObject('commit', commitData);
    repo.put(commit);
    return commit.oid;
  }

  flattenTree(repo: Repo, treeOid: string, prefix: string, entries: Map<string, string>, modes: Map<string, string>): void {
    const tree = repo.get(treeOid);
    if (tree === null) return;
    for (const e of parseTree(tree.data)) {
      const full = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') this.flattenTree(repo, e.oid, full, entries, modes);
      else { entries.set(full, e.oid); modes.set(full, e.mode); }
    }
  }

  /** Build nested tree objects from a flat path->oid map; returns root tree oid. */
  buildNestedTree(repo: Repo, entries: Map<string, string>, modes: Map<string, string>): string {
    interface Dir { children: Map<string, Dir | 'blob'>; blobs: Map<string, { oid: string; mode: string }> }
    const root: Dir = { children: new Map(), blobs: new Map() };
    for (const [path, oid] of entries) {
      const segs = path.split('/');
      let dir = root;
      for (let i = 0; i < segs.length - 1; i += 1) {
        let next = dir.children.get(segs[i]);
        if (next === undefined || next === 'blob') {
          next = { children: new Map(), blobs: new Map() };
          dir.children.set(segs[i], next);
        }
        dir = next;
      }
      dir.blobs.set(segs[segs.length - 1], { oid, mode: modes.get(path) ?? '100644' });
    }
    const write = (dir: Dir): string => {
      const treeEntries = [];
      for (const [name, sub] of dir.children) {
        if (sub === 'blob') continue;
        treeEntries.push({ mode: '40000', name, oid: write(sub) });
      }
      for (const [name, blob] of dir.blobs) {
        treeEntries.push({ mode: blob.mode, name, oid: blob.oid });
      }
      const tree = makeObject('tree', buildTree(treeEntries));
      repo.put(tree);
      return tree.oid;
    };
    return write(root);
  }

  /** Read a file's blob oid at a tree, by path. */
  blobAt(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
    const segs = path.split('/').filter((s) => s !== '');
    let current = treeOid;
    for (let i = 0; i < segs.length; i += 1) {
      const tree = repo.get(current);
      if (tree === null || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((e) => e.name === segs[i]);
      if (entry === undefined) return null;
      if (i === segs.length - 1) return entry.mode === '40000' ? null : { oid: entry.oid, mode: entry.mode };
      current = entry.oid;
    }
    return null;
  }

  /** List a directory's entries at a tree, by path. */
  dirAt(repo: Repo, treeOid: string, path: string): { name: string; oid: string; mode: string; type: 'file' | 'dir' }[] | null {
    const segs = path.split('/').filter((s) => s !== '');
    let current = treeOid;
    for (const seg of segs) {
      const tree = repo.get(current);
      if (tree === null || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((e) => e.name === seg);
      if (entry === undefined || entry.mode !== '40000') return null;
      current = entry.oid;
    }
    const tree = repo.get(current);
    if (tree === null || tree.type !== 'tree') return null;
    return parseTree(tree.data).map((e) => ({
      name: e.name, oid: e.oid, mode: e.mode, type: e.mode === '40000' ? 'dir' as const : 'file' as const,
    }));
  }

  /** Objects reachable from `tips` (commits/trees/blobs/tags), walking parents and trees. */
  reachable(repo: Repo, tips: string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop() ?? '';
      if (seen.has(oid)) continue;
      const obj = repo.get(oid);
      if (obj === null) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const pc = parseCommit(obj.data);
        stack.push(pc.tree, ...pc.parents);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return seen;
  }

  /** Commits reachable from a tip, newest first (topological by parent walk). */
  commitHistory(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() ?? '';
      if (seen.has(oid) || !repo.has(oid)) continue;
      seen.add(oid);
      const obj = repo.get(oid);
      if (obj === null || obj.type !== 'commit') continue;
      out.push(oid);
      const pc = parseCommit(obj.data);
      for (const p of pc.parents) queue.push(p);
    }
    return out;
  }

  /** Apply a receive-pack command list; returns the per-ref report. */
  applyRefUpdates(repo: Repo, commands: { oldOid: string; newOid: string; ref: string }[]): RefUpdate[] {
    const report: RefUpdate[] = [];
    for (const cmd of commands) {
      const current = repo.refValue(cmd.ref);
      if (cmd.oldOid === ZERO_OID) {
        if (current !== null) {
          report.push({ ref: cmd.ref, oldOid: cmd.oldOid, newOid: cmd.newOid, ok: false, failedReason: 'fetch first' });
          continue;
        }
      } else if (current === null || current !== cmd.oldOid) {
        report.push({ ref: cmd.ref, oldOid: cmd.oldOid, newOid: cmd.newOid, ok: false, failedReason: 'fetch first' });
        continue;
      }
      if (cmd.newOid === ZERO_OID) {
        repo.deleteRef(cmd.ref);
        report.push({ ref: cmd.ref, oldOid: cmd.oldOid, newOid: cmd.newOid, ok: true });
        continue;
      }
      // Objects for the new tip must be present (the pack preceded the command list).
      if (!repo.has(cmd.newOid)) {
        report.push({ ref: cmd.ref, oldOid: cmd.oldOid, newOid: cmd.newOid, ok: false, failedReason: 'missing necessary objects' });
        continue;
      }
      // Fast-forward check when updating an existing branch: the new tip must descend from it.
      if (current !== null) {
        const obj = repo.get(cmd.newOid);
        if (obj !== null && obj.type === 'commit') {
          // Walk the new tip's ancestry with an early exit at the expected parent: the common
          // fast-forward case reaches `current` in one hop, so no full-history walk happens.
          let cur: string | null = cmd.newOid;
          const seen = new Set<string>();
          let descended = false;
          while (cur !== null && !seen.has(cur)) {
            seen.add(cur);
            if (cur === current) { descended = true; break; }
            const pc = repo.parsedCommit(cur);
            if (pc === null) break;
            cur = pc.parents.length > 0 ? pc.parents[0] : null;
          }
          if (!descended) {
            // Fall back to a full reachable check (merge commits descend through second parents).
            const history = this.commitHistory(repo, cmd.newOid);
            descended = history.includes(current);
          }
          if (!descended) {
            report.push({ ref: cmd.ref, oldOid: cmd.oldOid, newOid: cmd.newOid, ok: false, failedReason: 'non-fast-forward' });
            continue;
          }
        }
      }
      repo.setRef(cmd.ref, cmd.newOid);
      report.push({ ref: cmd.ref, oldOid: cmd.oldOid, newOid: cmd.newOid, ok: true });
    }
    return report;
  }

  /** Store a pushed pack's objects (thin-pack bases resolved from the repo). */
  async storePack(repo: Repo, pack: Buffer): Promise<void> {
    const resolved = await resolvePack(pack, (oid) => repo.get(oid));
    for (const obj of resolved.values()) repo.put(obj);
  }
}

/** The timestamp the whole server's generated data uses (deterministic, never a wall clock). */
export function fixedTimestamp(baseSec: number, offsetSec: number): string {
  return new Date((baseSec + offsetSec) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
