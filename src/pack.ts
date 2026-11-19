// Git object model + packfile reader/writer (Node stdlib only).
import { createHash } from 'node:crypto';
import { createInflate, deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export const ZERO_OID = '0'.repeat(40);

const TYPE_NAMES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** A decoded git object. */
export interface GitObject {
  type: ObjectType;
  data: Buffer;
  oid: string;
}

/** git's object hash: sha1("<type> <size>\0<bytes>"). */
export function hashObject(type: ObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}`);
  h.update(Buffer.of(0));
  h.update(data);
  return h.digest('hex');
}

export function makeObject(type: ObjectType, data: Buffer): GitObject {
  return { type, data, oid: hashObject(type, data) };
}

export interface TreeEntry { mode: string; name: string; oid: string }

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0, sp + 1);
    const mode = data.subarray(i, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    i = nul + 21;
    entries.push({ mode, name, oid });
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}`));
    parts.push(Buffer.of(0));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const split = data.indexOf('\n\n');
  const headerEnd = split === -1 ? data.length : split;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = split === -1 ? '' : data.subarray(headerEnd + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message };
}

/** Inflate one zlib stream starting at `offset` and report the exact compressed length. */
async function inflateStreamAt(buf: Buffer, offset: number): Promise<{ data: Buffer; end: number }> {
  // A streaming Inflate stops exactly at the zlib stream end; bytesRead is how many compressed
  // bytes it consumed. One pass, no probing: the next object's header starts at offset + end.
  return await new Promise((resolve, reject) => {
    const inflater = createInflate();
    const chunks: Buffer[] = [];
    inflater.on('data', (c: Buffer) => chunks.push(c));
    inflater.on('end', () => resolve({ data: Buffer.concat(chunks), end: inflater.bytesRead }));
    inflater.on('error', reject);
    inflater.write(buf.subarray(offset));
    inflater.end();
  });
}

/**
 * Decode a packfile: every object resolved (deltas applied), keyed by oid, trailer verified.
 * `baseResolver` supplies thin-pack REF_DELTA bases the pack itself does not carry.
 */
export async function resolvePack(
  pack: Buffer,
  baseResolver?: (oid: string) => GitObject | null,
): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`bad pack version ${version}`);
  const count = pack.readUInt32BE(8);
  if (pack.length < 12 + count + 20) {
    // Minimum sanity; each object is at least a few bytes. Full bounds checked while walking.
  }

  interface Slot {
    kind: ObjectType | 'ofs_delta' | 'ref_delta';
    data: Buffer;
    start: number;
    baseOfs?: number;
    baseRef?: string;
    obj?: GitObject;
  }
  const slots: Slot[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    if (offset >= pack.length - 20) throw new Error(`object ${i} header past pack body`);
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const typeNum = (byte >> 4) & 7;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
    }
    let baseOfs: number | undefined;
    let baseRef: string | undefined;
    if (typeNum === 6) {
      byte = pack[offset];
      offset += 1;
      let ofs = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        ofs = ((ofs + 1) << 7) | (byte & 0x7f);
      }
      baseOfs = start - ofs;
    } else if (typeNum === 7) {
      baseRef = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    if (typeNum === 0 || typeNum === 5 || (typeNum > 7)) throw new Error(`bad object type ${typeNum}`);
    const { data, end } = await inflateStreamAt(pack, offset);
    offset += end;
    slots.push({
      kind: typeNum === 6 ? 'ofs_delta' : typeNum === 7 ? 'ref_delta' : TYPE_NAMES[typeNum],
      data,
      start,
      baseOfs,
      baseRef,
    });
  }
  // Trailer checksum.
  const body = pack.subarray(0, pack.length - 20);
  const trailer = pack.subarray(pack.length - 20);
  if (!createHash('sha1').update(body).digest().equals(trailer)) {
    throw new Error('pack trailer checksum mismatch');
  }

  const objects = new Map<string, GitObject>();
  const slotAtStart = new Map<number, Slot>();
  for (const s of slots) slotAtStart.set(s.start, s);

  function applyDelta(base: Buffer, delta: Buffer): Buffer {
    let p = 0;
    let size = 0;
    let shift = 0;
    for (;;) {
      const b = delta[p++];
      size |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const result = Buffer.alloc(size);
    let out = 0;
    while (p < delta.length) {
      const op = delta[p++];
      if (op & 0x80) {
        let cpOff = 0;
        let cpSize = 0;
        if (op & 0x01) cpOff |= delta[p++];
        if (op & 0x02) cpOff |= delta[p++] << 8;
        if (op & 0x04) cpOff |= delta[p++] << 16;
        if (op & 0x08) cpOff |= delta[p++] << 24;
        if (op & 0x10) cpSize |= delta[p++];
        if (op & 0x20) cpSize |= delta[p++] << 8;
        if (op & 0x40) cpSize |= delta[p++] << 16;
        if (cpSize === 0) cpSize = 0x10000;
        base.copy(result, out, cpOff, cpOff + cpSize);
        out += cpSize;
      } else if (op > 0) {
        delta.copy(result, out, p, p + op);
        p += op;
        out += op;
      } else {
        throw new Error('bad delta op 0');
      }
    }
    if (out !== size) throw new Error('delta size mismatch');
    return result;
  }

  function resolveSlot(slot: Slot, depth = 0): GitObject {
    if (slot.obj) return slot.obj;
    if (depth > 128) throw new Error('delta chain too deep');
    let type: ObjectType;
    let data: Buffer;
    if (slot.kind === 'ofs_delta' || slot.kind === 'ref_delta') {
      let baseObj: GitObject | null = null;
      if (slot.kind === 'ofs_delta') {
        const baseSlot = slotAtStart.get(slot.baseOfs ?? -1);
        if (baseSlot) baseObj = resolveSlot(baseSlot, depth + 1);
      } else if (slot.kind === 'ref_delta') {
        baseObj = objects.get(slot.baseRef ?? '') ?? null;
        if (baseObj === null && baseResolver) baseObj = baseResolver(slot.baseRef ?? '');
      }
      if (baseObj === null) throw new Error(`delta base not found (${slot.kind})`);
      type = baseObj.type;
      data = applyDelta(baseObj.data, slot.data);
    } else {
      type = slot.kind;
      data = slot.data;
    }
    const obj = makeObject(type, data);
    slot.obj = obj;
    objects.set(obj.oid, obj);
    return obj;
  }

  for (const s of slots) resolveSlot(s);
  return objects;
}

/** Encode objects into a pack buffer (plain objects, no deltas, level-1 deflate). */
export function buildPack(objects: GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of objects) {
    const typeNum = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    let size = obj.data.length;
    const headerBytes: number[] = [(typeNum << 4) | (size & 15)];
    size >>= 4;
    while (size > 0) {
      headerBytes[headerBytes.length - 1] |= 0x80;
      headerBytes.push(size & 0x7f);
      size >>= 7;
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
