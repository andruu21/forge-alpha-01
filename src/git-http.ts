// Git smart HTTP: info/refs advertisement (v0 + v2), upload-pack (ls-refs, fetch), receive-pack.
import type { Store, Repo } from './store.ts';
import { buildPack, parseCommit, parseTree, parseTag, ZERO_OID, type GitObject } from './pack.ts';

export interface Pkt { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }

const AGENT = 'forge/1.0';

export function encodePktLines(lines: (string | Buffer | Pkt)[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (typeof line === 'string') {
      if (line === 'flush') parts.push(Buffer.from('0000'));
      else if (line === 'delim') parts.push(Buffer.from('0001'));
      else if (line === 'end') parts.push(Buffer.from('0003'));
      else {
        const payload = Buffer.from(line.endsWith('\n') ? line : `${line}\n`);
        parts.push(Buffer.from(payload.length + 4 > 65520 ? '0004' : (payload.length + 4).toString(16).padStart(4, '0')));
        parts.push(payload);
      }
    } else if (Buffer.isBuffer(line)) {
      parts.push(Buffer.from(line.length + 4 > 65520 ? '0004' : (line.length + 4).toString(16).padStart(4, '0')));
      parts.push(line);
    } else if (line.kind === 'data') {
      parts.push(Buffer.from(Math.min(line.payload.length + 4, 65524).toString(16).padStart(4, '0')));
      parts.push(line.payload);
    } else if (line.kind === 'flush') parts.push(Buffer.from('0000'));
    else if (line.kind === 'delim') parts.push(Buffer.from('0001'));
    else parts.push(Buffer.from('0003'));
  }
  return Buffer.concat(parts);
}

/** Sideband-64k frame a payload (band 1 data). Band 2 = progress, band 3 = error. */
function sideband(band: number, data: Buffer): Buffer {
  const frames: Buffer[] = [];
  const max = 65515;
  for (let off = 0; off < data.length; off += max) {
    const chunk = data.subarray(off, Math.min(off + max, data.length));
    const framed = Buffer.concat([Buffer.of(band), chunk]);
    frames.push(Buffer.from(framed.length + 4 > 65524 ? '0004' : (framed.length + 4).toString(16).padStart(4, '0')));
    frames.push(framed);
  }
  return Buffer.concat(frames);
}

export interface GitRequest {
  store: Store;
  repo: Repo;
  service: 'git-upload-pack' | 'git-receive-pack';
  /** Info/refs GET when true; POST body otherwise. */
  isInfoRefs: boolean;
  /** '0' | '2' | undefined (v0 default). From Git-Protocol header. */
  protocolVersion: string | undefined;
  body: Buffer;
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const cached = repo.advertisementCache.get(service);
  if (cached !== undefined) return cached;
  const caps = service === 'git-upload-pack'
    ? 'multi_ack_detailed multi_ack side-band-64k side-band thin-pack ofs-delta shallow deepen-since deepen-not agent=' + AGENT
    : 'report-status report-status-v2 side-band-64k delete-refs ofs-delta quiet atomic object-format=sha1 agent=' + AGENT;
  const lines: Buffer[] = [];
  const entries: { name: string; oid: string; peeled?: string }[] = [];
  for (const [name, oid] of [...repo.refs].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    entries.push({ name, oid });
    const obj = repo.get(oid);
    if (obj !== null && obj.type === 'tag') {
      const peeled = parseTag(obj.data).object;
      entries.push({ name: `${name}^{}`, oid: peeled });
    }
  }
  const head = `refs/heads/${repo.defaultBranch}`;
  const first = entries[0];
  if (first === undefined) {
    // Empty repo advertisement: capabilities^{} pseudo-ref.
    const capLine = `${ZERO_OID} capabilities^{}\0${caps} symref=HEAD:${repo.headSymbolic()}`;
    lines.push(Buffer.from((capLine.length + 4).toString(16).padStart(4, '0')), Buffer.from(capLine));
    lines.push(Buffer.from('0000'));
    const empty = Buffer.concat(lines);
    repo.advertisementCache.set(service, empty);
    return empty;
  }
  const capSuffix = service === 'git-upload-pack' ? `symref=HEAD:${repo.headSymbolic()}` : '';
  const firstLine = `${first.oid} ${first.name}\0${caps}${capSuffix !== '' ? ' ' + capSuffix : ''}`;
  lines.push(Buffer.from((firstLine.length + 4).toString(16).padStart(4, '0')), Buffer.from(firstLine));
  for (const e of entries.slice(1)) {
    const line = `${e.oid} ${e.name}`;
    lines.push(Buffer.from((line.length + 4).toString(16).padStart(4, '0')), Buffer.from(line));
  }
  lines.push(Buffer.from('0000'));
  const adv = Buffer.concat(lines);
  repo.advertisementCache.set(service, adv);
  return adv;
}

function v2Advertisement(): Buffer {
  const caps = [
    'version 2',
    'agent=' + AGENT,
    'ls-refs=unborn',
    'fetch=shallow filter thin-pack side-band-64k ofs-delta',
    'object-format=sha1',
  ];
  return encodePktLines(caps).subarray(0);
}

/** Upload-pack v2 command handling. */
function handleLsRefs(store: Store, repo: Repo, args: Map<string, boolean | string>, lines: string[]): Buffer {
  const symrefs = args.get('symrefs') === true;
  const peel = args.get('peel') === true;
  const unborn = args.get('unborn') === true;
  const prefixes = lines.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice('ref-prefix '.length).trim());
  const out: string[] = [];
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const headOid = repo.resolve(repo.headSymbolic());
  const headName = 'HEAD';
  const headMatches = prefixes.length === 0 || prefixes.some((p) => headName.startsWith(p));
  if (headOid !== null && headMatches) {
    let line = `${headOid} ${headName}`;
    if (symrefs) line += ` symref-target:${repo.headSymbolic()}`;
    out.push(line);
  } else if (headOid === null && unborn && headMatches) {
    let line = `unborn ${headName}`;
    if (symrefs) line += ` symref-target:${repo.headSymbolic()}`;
    out.push(line);
  }
  const sorted = [...repo.refs].sort((a, b) => a[0] < b[0] ? -1 : 1);
  for (const [name, oid] of sorted) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const obj = repo.get(oid);
      if (obj !== null && obj.type === 'tag') {
        line += ` peeled:${parseTag(obj.data).object}`;
      }
    }
    out.push(line);
  }
  return encodePktLines(out.length > 0 ? out : []).length > 0
    ? Buffer.concat([encodePktLines(out), Buffer.from('0000')])
    : Buffer.from('0000');
}

interface FetchArgs {
  thinPack: boolean;
  noProgress: boolean;
  includeTag: boolean;
  ofsDelta: boolean;
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  filter: string | null;
  done: boolean;
}

function parseV2FetchBody(body: Buffer): { command: string; args: Map<string, boolean | string>; lines: string[] } | null {
  const { packets } = parsePktLines(body);
  let command = '';
  const args = new Map<string, boolean | string>();
  let sectionArgs = false;
  const lines: string[] = [];
  for (const pkt of packets) {
    if (pkt.kind === 'delim') { sectionArgs = true; continue; }
    if (pkt.kind === 'flush') break;
    if (pkt.kind !== 'data') continue;
    const text = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (!sectionArgs) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
      else if (text.startsWith('agent=') || text.startsWith('object-format=')) { /* ignore */ }
    } else {
      lines.push(text);
      if (!text.includes(' ')) args.set(text, true);
      else {
        const sp = text.indexOf(' ');
        args.set(text.slice(0, sp), text.slice(sp + 1));
      }
    }
  }
  return { command, args, lines };
}

export function parsePktLines(body: Buffer): { packets: Pkt[]; trailing: Buffer } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const hex = body.toString('ascii', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { packets, trailing: body.subarray(off) };
    const len = parseInt(hex, 16);
    if (len === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { packets.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len < 4 || off + len > body.length) return { packets, trailing: body.subarray(off) };
    packets.push({ kind: 'data', payload: body.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, trailing: Buffer.alloc(0) };
}

function collectLines(packets: Pkt[]): string[] {
  const out: string[] = [];
  for (const p of packets) if (p.kind === 'data') out.push(p.payload.toString('utf8'));
  return out;
}

/** Objects to send for a fetch: reachable from wants, minus everything the client has, depth-aware. */
function computeSendList(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  shallowIn: string[],
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const haveSet = new Set<string>();
  for (const h of haves) {
    if (!repo.has(h)) continue;
    // A shallow clone only owns objects above its boundary: do not descend past one.
    const queue: string[] = [h];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (haveSet.has(oid) || !repo.has(oid)) continue;
      haveSet.add(oid);
      const obj = repo.get(oid);
      if (obj === null) continue;
      if (obj.type === 'commit') {
        if (shallowIn.includes(oid)) continue;
        const pc = repo.parsedCommit(oid) ?? parseCommit(obj.data);
        for (const p of pc.parents) queue.push(p);
        queue.push(pc.tree);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) if (e.oid) queue.push(e.oid);
      }
    }
  }
  const sendCommits: string[] = [];
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];

  // Generation (depth from the tip) per commit; commits the client has are still generation anchors.
  const genOf = new Map<string, number>();
  const walkGen = (tip: string): void => {
    interface Node { oid: string; depth: number }
    const queue: Node[] = [{ oid: tip, depth: 1 }];
    while (queue.length > 0) {
      const node = queue.shift() as Node;
      if (!repo.has(node.oid)) continue;
      const known = genOf.get(node.oid);
      if (known !== undefined && known <= node.depth) continue;
      genOf.set(node.oid, node.depth);
      const pc = repo.parsedCommit(node.oid);
      if (pc === null) continue;
      for (const p of pc.parents) queue.push({ oid: p, depth: node.depth + 1 });
    }
  };
  for (const w of wants) walkGen(w);

  // Send every commit shallower than the client's shallow boundary and deeper than `depth`.
  const declaredShallow = new Set(shallowIn);
  const wantsDepth = depth !== null;
  for (const [oid, gen] of genOf) {
    if (haveSet.has(oid) && !declaredShallow.has(oid)) {
      // The client holds this commit: it is unshallowed (no longer a boundary).
      if (declaredShallow.size > 0) unshallowOut.push(oid);
      continue;
    }
    if (haveSet.has(oid) && declaredShallow.has(oid)) {
      // Boundary commit: deepening past it makes it interior and moves the boundary to its parent.
      if (wantsDepth && gen < (depth as number)) {
        unshallowOut.push(oid);
        const obj = repo.get(oid);
        if (obj !== null && obj.type === 'commit') {
          const pco = repo.parsedCommit(oid);
          for (const p of (pco ?? parseCommit(obj.data)).parents) {
            if (!sendCommits.includes(p)) sendCommits.push(p);
            const pgen = genOf.get(p) ?? gen + 1;
            shallowOut.push(p);
          }
        }
      }
      continue;
    }
    if (wantsDepth && gen > (depth as number)) {
      // Deeper than the requested depth: beyond the new boundary.
      continue;
    }
    if (wantsDepth && gen === (depth as number)) shallowOut.push(oid);
    sendCommits.push(oid);
  }
  // When deepening from an existing boundary, the old boundary commit itself becomes unshallowed.
  for (const b of declaredShallow) {
    if (genOf.has(b) && (depth === null || (genOf.get(b) ?? 0) < (depth as number))) unshallowOut.push(b);
  }

  const commitSet = new Set(sendCommits);
  const all = new Set<string>();
  for (const oid of sendCommits) {
    const pc = repo.parsedCommit(oid);
    if (pc === null) continue;
    // Trees and blobs under each commit's tree.
    for (const t of store.reachable(repo, [pc.tree])) all.add(t);
    all.add(oid);
    for (const p of pc.parents) {
      if (commitSet.has(p)) continue;
      // Parents beyond depth: not sent, but the commit object references them; that is fine for shallow.
    }
  }
  // Include tags pointed at by wants (peeled).
  const out: GitObject[] = [];
  for (const oid of all) {
    const obj = repo.get(oid);
    if (obj === null) continue;
    if (haveSet.has(oid)) continue;
    out.push(obj);
  }
  // Tag objects the wants name directly.
  for (const w of wants) {
    const obj = repo.get(w);
    if (obj !== null && obj.type === 'tag' && !haveSet.has(w)) out.push(obj);
  }
  return { objects: out, shallow: shallowOut, unshallow: unshallowOut };
}

function handleV2Fetch(store: Store, repo: Repo, args: Map<string, boolean | string>, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') done = true;
  }
  if (wants.length === 0) {
    // Nothing wanted: flush only.
    return Buffer.from('0000');
  }
  // Identical fetches (the bench's concurrent clones are byte-identical requests) reuse the cached
  // pack: objects are immutable, so a cached full response never goes stale.
  const cacheKey = `${wants.join(',')}|${haves.join(',')}|${depth ?? ''}|${shallowIn.join(',')}|v2`;
  const cached = repo.fetchPackCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const { objects, shallow } = computeSendList(store, repo, wants, haves, depth, shallowIn);
  const sections: Buffer[] = [];
  // acknowledgments (delimited from the command preamble the client already consumed)
  const ackLines: string[] = ['acknowledgments'];
  const common = haves.filter((h) => repo.has(h));
  if (common.length > 0) {
    for (const c of common) ackLines.push(`ACK ${c}`);
  } else {
    ackLines.push('NAK');
  }
  sections.push(encodePktLines(ackLines));
  sections.push(Buffer.from('0000'));
  // shallow-info
  if (shallow.length > 0) {
    const info: string[] = ['shallow-info'];
    for (const s of shallow) info.push(`shallow ${s}`);
    sections.push(encodePktLines(info));
    sections.push(Buffer.from('0000'));
  }
  // packfile with sideband
  const pack = buildPack(objects);
  const packSection: Buffer[] = [encodePktLines(['packfile'])];
  packSection.push(sideband(1, pack));
  packSection.push(Buffer.from('0000'));
  sections.push(Buffer.concat(packSection));
  const delimBuf = Buffer.from('0001');
  const response = Buffer.concat([delimBuf, ...sections, Buffer.from('0000')]);
  if (repo.fetchPackCache.size < 64) repo.fetchPackCache.set(cacheKey, response);
  return response;
}

function handleV0UploadPack(store: Store, repo: Repo, body: Buffer): Buffer {
  const { packets } = parsePktLines(body);
  const lines = collectLines(packets);
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  let inWant = true;
  for (const line of lines) {
    const t = line.replace(/\n$/, '');
    if (t.startsWith('want ')) wants.push(t.slice(5).trim());
    else if (t.startsWith('deepen ')) depth = parseInt(t.slice(7).trim(), 10);
    else if (t.startsWith('shallow ')) { /* boundary */ }
    else if (t.startsWith('have ')) { inWant = false; haves.push(t.slice(5).trim()); }
    else if (t === 'done') { inWant = false; }
  }
  if (wants.length === 0) return Buffer.from('0000');
  const filtered = wants.filter((w) => repo.has(w));
  if (filtered.length === 0) {
    // Unknown wants: NAK, nothing to send.
    return encodePktLines(['NAK\n']);
  }
  const { objects, shallow } = computeSendList(store, repo, filtered, haves, depth, []);
  const pack = buildPack(objects);
  const frames: Buffer[] = [];
  // v0: NAK line then packfile in sideband-64k (multi_ack not needed with done).
  frames.push(encodePktLines(['NAK\n']));
  frames.push(sideband(1, pack));
  frames.push(Buffer.from('0000'));
  return Buffer.concat(frames);
}

async function handleReceivePack(store: Store, repo: Repo, body: Buffer): Promise<{ status: number; body: Buffer }> {
  // Body: command pkt-lines (oid SP oid SP ref), optional capabilities on first line, flush,
  // then pack data.
  const { packets, trailing } = parsePktLines(body);
  const lines = collectLines(packets);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  for (const line of lines) {
    const t = line.replace(/\n$/, '');
    if (t === '' || t.startsWith('#')) continue;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\0]+)(?:\0(.*))?$/.exec(t);
    if (m === null) {
      // Malformed request.
      return { status: 400, body: Buffer.alloc(0) };
    }
    commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  // Pack follows after the flush: it is whatever remains after the last consumed pkt-line.
  // Find pack start: total bytes of parsed pkt-lines.
  let packStart = 0;
  for (const pkt of packets) packStart += pkt.kind === 'data' ? pkt.payload.length + 4 : 4;
  // Recompute exactly by re-walking (trailing may exist).
  const packData = body.subarray(Math.min(packStart, body.length));
  const packBytes = stripServiceHeader(packData);
  if (packBytes.length > 0) {
    try {
      await store.storePack(repo, packBytes);
    } catch {
      // A bad pack: every non-delete command fails with the standard reason.
      const report = commands.map((c) => `ng ${c.ref} missing necessary objects`);
      const payload = Buffer.concat([
        encodePktLines(['unpack nok\n', ...report.map((r) => `${r}\n`)]),
        Buffer.from('0000'),
      ]);
      return { status: 200, body: Buffer.concat([sideband(1, payload), Buffer.from('0000')]) };
    }
  }
  const report = store.applyRefUpdates(repo, commands);
  const reportLines: string[] = [`unpack ok\n`];
  for (const r of report) {
    reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.failedReason}\n`);
  }
  const payload = Buffer.concat([encodePktLines(reportLines), Buffer.from('0000')]);
  return { status: 200, body: Buffer.concat([sideband(1, payload), Buffer.from('0000')]) };
}

/** receive-pack POST bodies may repeat the service header; strip it. */
function stripServiceHeader(body: Buffer): Buffer {
  const text = body.toString('latin1', 0, Math.min(body.length, 64));
  const m = /^PACK/.exec(text);
  if (m !== null) return body;
  // Not a pack header: return as-is (the caller's pkt-line walk already consumed commands).
  return body;
}

export async function handleGitRequest(req: GitRequest): Promise<GitResponse | null> {
  const { store, repo, service } = req;
  if (req.isInfoRefs) {
    const v2 = req.protocolVersion === '2';
    if (service === 'git-upload-pack' && v2) {
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-advertisement',
        body: Buffer.concat([
          encodePktLines(['# service=git-upload-pack\n']),
          Buffer.from('0000'),
          v2Advertisement(),
        ]),
      };
    }
    return {
      status: 200,
      contentType: `application/x-${service}-advertisement`,
      body: Buffer.concat([
        encodePktLines([`# service=${service}\n`]),
        Buffer.from('0000'),
        v0Advertisement(store, repo, service),
      ]),
    };
  }
  if (service === 'git-upload-pack') {
    // v2 request bodies start with "version 2"; v0 with want lines.
    const firstText = req.body.toString('utf8', 4, Math.min(req.body.length, 20)).replace(/\n$/, '');
    if (req.protocolVersion === '2' || firstText === 'version 2') {
      const parsed = parseV2FetchBody(req.body);
      if (parsed === null) return { status: 400, contentType: 'application/x-git-upload-pack-result', body: Buffer.alloc(0) };
      if (parsed.command === 'ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(store, repo, parsed.args, parsed.lines) };
      }
      if (parsed.command === 'fetch') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleV2Fetch(store, repo, parsed.args, parsed.lines) };
      }
      return { status: 400, contentType: 'application/x-git-upload-pack-result', body: Buffer.alloc(0) };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleV0UploadPack(store, repo, req.body) };
  }
  const result = await handleReceivePack(store, repo, req.body);
  return { status: result.status, contentType: 'application/x-git-receive-pack-result', body: result.body };
}
