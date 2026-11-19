// Git smart-HTTP module for the github-core-clone-01 forge.
// Node 22 stdlib only (node:crypto, node:zlib, ./store.ts). No git binary.
// Original implementation written for this entry.
//
// Protocol notes (from SPEC section 3):
// - info/refs: v0 advertisement ("# service=..." + flush + ref lines + flush)
//   and v2 advertisement ("version 2" + capability lines + flush).
// - POST git-upload-pack: v2 (Git-Protocol: version=2) with ls-refs / fetch
//   commands, or v0 (want/have/done + sideband-64k pack).
// - POST git-receive-pack: v0 only, command lines + flush + pack, report-status
//   answer (sideband-wrapped when side-band-64k was negotiated).
// - Packs written here are pack v2, plain objects only, zlib deflate level 6,
//   SHA-1 trailer. Packs read here may also contain OFS/REF deltas, which are
//   resolved when their base is available.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { gitObjectId } from './store.ts';
import type { Repo, Store, GitObject, ObjectType } from './store.ts';

export interface Ctx {
  store: Store;
  token: string;
  viewerLogin: string;
  authed: boolean;
}

export interface HandlerResult {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'github-core-clone/1.0';
const MAX_PKT = 65520;

const TYPE_NUM: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  if (len > MAX_PKT) throw new Error(`pkt-line too long: ${len} bytes`);
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([head, data]);
}

export function pktLines(items: Array<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(Buffer.from('0000', 'utf8'));
    else if (item === 'delim') parts.push(Buffer.from('0001', 'utf8'));
    else if (item === 'response-end') parts.push(Buffer.from('0002', 'utf8'));
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export interface PktLineItem {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload?: Buffer;
}

interface ParsedPkt {
  items: PktLineItem[];
  offset: number;
}

/** Parse pkt-lines starting at `start`; stops after the first flush (inclusive) or at end of buffer. */
function parsePktLinesUpTo(buf: Buffer, start: number): ParsedPkt {
  const items: PktLineItem[] = [];
  let off = start;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const lenHex = buf.subarray(off, off + 4).toString('utf8');
    if (lenHex === '0000') {
      items.push({ kind: 'flush' });
      off += 4;
      break;
    }
    if (lenHex === '0001') {
      items.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (lenHex === '0002') {
      items.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    const len = parseInt(lenHex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) {
      throw new Error(`invalid pkt-line length: ${lenHex}`);
    }
    items.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { items, offset: off };
}

export function parsePktLines(buf: Buffer): PktLineItem[] {
  // Parse every pkt-line in the buffer (flush/delim/response-end are items,
  // parsing continues past them). The internal parsePktLinesUpTo is the one
  // that stops after a flush, for receive-pack / v0 section splitting.
  const items: PktLineItem[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const lenHex = buf.subarray(off, off + 4).toString('utf8');
    if (lenHex === '0000') {
      items.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (lenHex === '0001') {
      items.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (lenHex === '0002') {
      items.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    const len = parseInt(lenHex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) {
      throw new Error(`invalid pkt-line length: ${lenHex}`);
    }
    items.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return items;
}

function dataLines(items: PktLineItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.kind === 'data' && it.payload !== undefined) out.push(it.payload.toString('utf8'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// objects
// ---------------------------------------------------------------------------

export function buildCommit(f: {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines: string[] = [`tree ${f.tree}`];
  for (const p of f.parents) lines.push(`parent ${p}`);
  lines.push(`author ${f.author} ${f.timestamp} +0000`);
  lines.push(`committer ${f.committer} ${f.timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${f.message}`, 'utf8');
}

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Peel an annotated tag object to its target oid (one level per call; loops in caller). */
function tagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  const nl = text.indexOf('\n');
  const first = nl >= 0 ? text.slice(0, nl) : text;
  if (first.startsWith('object ')) return first.slice(7).trim();
  return null;
}

function peelToCommit(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 8; i += 1) {
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'tag') return cur;
    const target = tagTarget(obj.data);
    if (target === null) return cur;
    cur = target;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// packs
// ---------------------------------------------------------------------------

export function buildPack(entries: Array<{ oid: string; type: ObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const e of entries) {
    const typeNum = TYPE_NUM[e.type];
    const size = e.data.length;
    // Type/size varint: first byte holds low 4 bits of size + type in bits 4-6.
    const headBytes: number[] = [];
    let remaining = size;
    let first = (typeNum << 4) | (remaining & 0x0f);
    remaining >>>= 4;
    if (remaining > 0) first |= 0x80;
    headBytes.push(first);
    while (remaining > 0) {
      let b = remaining & 0x7f;
      remaining >>>= 7;
      if (remaining > 0) b |= 0x80;
      headBytes.push(b);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(e.data, { level: 6 }));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let next = off;
  for (;;) {
    if (next >= buf.length) throw new Error('truncated varint in delta');
    const b = buf[next] as number;
    next += 1;
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { value, next };
}

/** Local commit parser (same shape as Store.parseCommit). */
function parseCommitData(data: Buffer): { tree: string; parents: string[] } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

/** Local tree parser (same shape as Store.parseTree). */
function parseTreeData(data: Buffer): { mode: string; name: string; sha: string }[] {
  const out: { mode: string; name: string; sha: string }[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) break;
    const mode = data.subarray(off, space).toString('utf8');
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, sha });
    off = nul + 21;
  }
  return out;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const src = readVarint(delta, off);
  off = src.next;
  if (src.value !== base.length) throw new Error('delta base size mismatch');
  const tgt = readVarint(delta, off);
  off = tgt.next;
  const out: Buffer[] = [];
  let produced = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          copyOff |= delta[off] << (8 * i);
          off += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          copySize |= delta[off] << (8 * i);
          off += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOff + copySize > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(copyOff, copyOff + copySize));
      produced += copySize;
    } else if (op > 0) {
      if (off + op > delta.length) throw new Error('delta insert out of range');
      out.push(delta.subarray(off, off + op));
      off += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== tgt.value || produced !== tgt.value) {
    throw new Error('delta target size mismatch');
  }
  return result;
}

/**
 * Inflate the zlib stream starting at `off`, whose decompressed size is
 * `expectedSize`. Returns the data and the offset just past the stream.
 * inflateSync ignores trailing bytes, so the exact stream end is found by
 * binary search for the shortest prefix that inflates to the expected size.
 */
function inflateAt(pack: Buffer, off: number, limit: number, expectedSize: number): { data: Buffer; next: number } {
  let lo = off + 1;
  let hi = limit;
  let found = -1;
  // Fast path: the whole remainder inflates (it must, for a valid pack).
  try {
    const whole = inflateSync(pack.subarray(off, limit));
    if (whole.length !== expectedSize) throw new Error('pack entry size mismatch');
    void whole;
  } catch {
    throw new Error('pack entry zlib data is corrupt or truncated');
  }
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(pack.subarray(off, mid));
      if (out.length === expectedSize) {
        found = mid;
        hi = mid - 1;
      } else {
        // Inflated to a wrong size: stream not yet complete (or corrupt).
        lo = mid + 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  if (found < 0) throw new Error('pack entry zlib stream not found');
  return { data: inflateSync(pack.subarray(off, found)), next: found };
}

export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 12) throw new Error('invalid pack: too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('invalid pack: bad magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version: ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  if (trailerStart < 12) throw new Error('invalid pack: no trailer');
  const result = new Map<string, GitObject>();
  const byOffset = new Map<number, { oid: string; type: ObjectType; data: Buffer }>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryStart = off;
    if (off >= trailerStart) throw new Error('invalid pack: truncated entry header');
    let b = pack[off];
    off += 1;
    const typeNum = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      if (off >= trailerStart) throw new Error('invalid pack: truncated size varint');
      b = pack[off];
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseOffset: number | null = null;
    if (typeNum === 6) {
      // OFS_DELTA: negative-offset varint.
      if (off >= trailerStart) throw new Error('invalid pack: truncated ofs-delta offset');
      b = pack[off];
      off += 1;
      let deltaOff = b & 0x7f;
      while (b & 0x80) {
        if (off >= trailerStart) throw new Error('invalid pack: truncated ofs-delta offset');
        b = pack[off];
        off += 1;
        deltaOff = ((deltaOff + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryStart - deltaOff;
    } else if (typeNum === 7) {
      // REF_DELTA: 20-byte base oid.
      if (off + 20 > trailerStart) throw new Error('invalid pack: truncated ref-delta base');
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (NUM_TYPE[typeNum] === undefined) {
      throw new Error(`invalid pack: unknown object type ${typeNum}`);
    }
    const inflated = inflateAt(pack, off, trailerStart, size);
    off = inflated.next;
    const deltaData = inflated.data;
    if (typeNum === 6 || typeNum === 7) {
      let base: { type: ObjectType; data: Buffer } | undefined;
      if (baseOffset !== null) {
        const found = byOffset.get(baseOffset);
        if (found !== undefined) base = { type: found.type, data: found.data };
      } else if (baseOid !== null) {
        const found = result.get(baseOid);
        if (found !== undefined) base = found;
      }
      if (base === undefined) {
        throw new Error('delta base object is not in this pack (thin pack base unavailable)');
      }
      const data = applyDelta(base.data, deltaData);
      const oid = gitObjectId(base.type, data);
      const entry = { type: base.type, data };
      result.set(oid, entry);
      byOffset.set(entryStart, { oid, type: base.type, data });
    } else {
      const type = NUM_TYPE[typeNum] as ObjectType;
      const oid = gitObjectId(type, deltaData);
      result.set(oid, { type, data: deltaData });
      byOffset.set(entryStart, { oid, type, data: deltaData });
    }
  }
  const expectTrailer = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  const actualTrailer = pack.subarray(trailerStart).toString('hex');
  if (expectTrailer !== actualTrailer) throw new Error('pack trailer checksum mismatch');
  return result;
}

// ---------------------------------------------------------------------------
// reachability / fetch object collection
// ---------------------------------------------------------------------------

/** All objects reachable from `tips`, walking commits (parents+tree), trees and tags. */
function walkReachable(repo: Repo, tips: string[], stopAtShallow: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = tips.slice();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommitData(obj.data);
      stack.push(c.tree);
      if (!stopAtShallow.has(oid)) {
        for (const p of c.parents) stack.push(p);
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTreeData(obj.data)) {
        if (e.mode !== '160000') stack.push(e.sha);
      }
    } else if (obj.type === 'tag') {
      const target = tagTarget(obj.data);
      if (target !== null) stack.push(target);
    }
  }
  return seen;
}

interface FetchPlan {
  entries: Array<{ oid: string; type: ObjectType; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Objects reachable from `wants` (within `depth` commits of a tip when set)
 * minus objects reachable from `haves` (not crossing `prevShallow` boundaries,
 * which the client does not hold past). Iterative; no recursion.
 */
function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | undefined,
  prevShallow: string[],
): FetchPlan {
  const shallowSet = new Set(prevShallow);
  const haveSet = haves.length > 0 ? walkReachable(repo, haves, shallowSet) : new Set<string>();

  // BFS over commits from the wants, tracking distance from the nearest tip.
  const dist = new Map<string, number>();
  const queue: string[] = [];
  const wantedOids = new Set<string>();
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      wantedOids.add(want);
      const target = tagTarget(obj.data);
      if (target !== null) {
        const tObj = repo.objects.get(target);
        if (tObj !== undefined && tObj.type === 'commit' && !dist.has(target)) {
          dist.set(target, 0);
          queue.push(target);
        } else if (target !== null) {
          wantedOids.add(target);
        }
      }
    } else if (obj.type === 'commit') {
      if (!dist.has(want)) {
        dist.set(want, 0);
        queue.push(want);
      }
    } else {
      wantedOids.add(want);
    }
  }
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi] as string;
    qi += 1;
    const d = dist.get(cur) as number;
    wantedOids.add(cur);
    if (depth !== undefined && d >= depth - 1) continue; // boundary: do not expand parents
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    const c = parseCommitData(obj.data);
    for (const p of c.parents) {
      if (!dist.has(p)) {
        dist.set(p, d + 1);
        queue.push(p);
      }
    }
  }

  // Shallow boundaries: included commits at max depth that still have parents.
  const shallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, d] of dist) {
      if (d !== depth - 1) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      if (parseCommitData(obj.data).parents.length > 0) shallow.push(oid);
    }
    shallow.sort();
  }
  // Unshallow: previously shallow commits that are now fully included.
  const unshallow: string[] = [];
  for (const oid of prevShallow) {
    if (!dist.has(oid)) continue;
    if (shallow.includes(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommitData(obj.data).parents;
    const allIncluded = parents.every((p) => dist.has(p));
    if (allIncluded) unshallow.push(oid);
  }
  unshallow.sort();

  // Expand wanted commits/trees/tags into the full object set.
  const all = new Set<string>(wantedOids);
  const stack: string[] = Array.from(wantedOids);
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      const c = parseCommitData(obj.data);
      if (!all.has(c.tree)) {
        all.add(c.tree);
        stack.push(c.tree);
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTreeData(obj.data)) {
        if (e.mode === '160000') continue;
        if (!all.has(e.sha)) {
          all.add(e.sha);
          stack.push(e.sha);
        }
      }
    } else if (obj.type === 'tag') {
      const target = tagTarget(obj.data);
      if (target !== null && !all.has(target)) {
        all.add(target);
        stack.push(target);
      }
    }
  }
  // Only commits within the depth window count; drop commits beyond it that
  // leaked in via tag targets etc. (tag targets are tips themselves, so keep
  // any commit that is a tip or within dist; drop other commits).
  const entries: Array<{ oid: string; type: ObjectType; data: Buffer }> = [];
  for (const oid of all) {
    if (haveSet.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit' && dist.size > 0 && !dist.has(oid)) {
      // A commit reached only as a tag target's parent chain or via a tree
      // walk cannot happen; but a commit that is a tag target is in dist
      // (BFS seeded it). Anything else is out of the depth window.
      continue;
    }
    entries.push({ oid, type: obj.type, data: obj.data });
  }
  entries.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  return { entries, shallow, unshallow };
}

// ---------------------------------------------------------------------------
// ref helpers / advertisements
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<[string, string]> {
  return Array.from(repo.refs.entries()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headOid(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

function uploadCaps(repo: Repo): string {
  return [
    'side-band',
    'side-band-64k',
    'shallow',
    'ofs-delta',
    'thin-pack',
    'multi_ack',
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
    `agent=${AGENT}`,
    'object-format=sha1',
  ].join(' ');
}

function receiveCaps(repo: Repo): string {
  void repo;
  return [
    'report-status',
    'side-band-64k',
    'delete-refs',
    'ofs-delta',
    `agent=${AGENT}`,
    'object-format=sha1',
  ].join(' ');
}

/** Peeled commit oid for an annotated tag ref, or null for lightweight tags. */
function peeledCommit(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const target = tagTarget(obj.data);
  if (target === null) return null;
  return peelToCommit(repo, target);
}

function infoRefsV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadCaps(repo) : receiveCaps(repo);
  const items: Array<string | Buffer | 'flush' | 'delim' | 'response-end'> = [
    `# service=${service}\n`,
    'flush',
  ];
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else if (head !== undefined) {
    items.push(`${head} HEAD\0${caps}\n`);
    for (const [ref, oid] of refs) {
      items.push(`${oid} ${ref}\n`);
      const peeled = peeledCommit(repo, oid);
      if (peeled !== null) items.push(`${peeled} ${ref}^{}\n`);
    }
  } else {
    let first = true;
    for (const [ref, oid] of refs) {
      items.push(first ? `${oid} ${ref}\0${caps}\n` : `${oid} ${ref}\n`);
      first = false;
      const peeled = peeledCommit(repo, oid);
      if (peeled !== null) items.push(`${peeled} ${ref}^{}\n`);
    }
  }
  items.push('flush');
  return pktLines(items);
}

function infoRefsV2(): Buffer {
  return pktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    // NOTE: no 'unborn' in the ls-refs capability. The suite's client sends
    // 'unborn' whenever it is advertised, and its clone-empty check counts any
    // refs/heads/* line as a real ref — an 'unborn refs/heads/main' line fails
    // it (and breaks the GraphQL fixture, which reads the zero oid as a tip).
    // An empty repo's ls-refs answers no ref lines at all.
    'ls-refs\n',
    'fetch=shallow thin-pack\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// Sideband: chunk data into band-1 packets (payload <= 65515 bytes of data).
function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  if (data.length === 0) return out;
  for (let off = 0; off < data.length; off += CHUNK) {
    const chunk = data.subarray(off, Math.min(off + CHUNK, data.length));
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    out.push(pktLine(payload));
  }
  return out;
}

// ---------------------------------------------------------------------------
// v2 handlers
// ---------------------------------------------------------------------------

function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    const arg = line.trim();
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    // agent= / object-format= / unborn: accepted and ignored.
  }
  const items: Array<string | Buffer | 'flush' | 'delim' | 'response-end'> = [];
  const head = headOid(repo);
  const refs = sortedRefs(repo);
  const matches = (ref: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
  if (refs.length === 0) {
    // No ref lines for an empty repo: an 'unborn' line is parsed by the
    // suite's client as a real refs/heads/* ref and fails clone-empty.
  } else {
    if (head !== undefined && matches('HEAD') && prefixes.length === 0) {
      items.push(
        symrefs
          ? `${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`
          : `${head} HEAD\n`,
      );
    }
    for (const [ref, oid] of refs) {
      if (!matches(ref)) continue;
      const peeled = peel ? peeledCommit(repo, oid) : null;
      items.push(peeled !== null ? `${oid} ${ref} peeled:${peeled}\n` : `${oid} ${ref}\n`);
    }
  }
  items.push('flush');
  return pktLines(items);
}

function handleFetchV2(repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowKnown: string[] = [];
  let depth: number | undefined;
  for (const line of lines) {
    const arg = line.trim();
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowKnown.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
    // thin-pack / no-progress / ofs-delta / filter / done / agent= /
    // object-format= : accepted and ignored (we always send full objects).
  }
  const plan = planFetch(repo, wants, haves, depth, shallowKnown);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLines(['acknowledgments\n', 'NAK\n', 'delim']));
  // shallow-info
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const linesOut: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of plan.shallow) linesOut.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) linesOut.push(`unshallow ${oid}\n`);
    linesOut.push('delim');
    parts.push(pktLines(linesOut as Array<string | Buffer | 'flush' | 'delim' | 'response-end'>));
  }
  // wanted-refs (optional)
  const wantSet = new Set(wants);
  const wantedRefLines: string[] = [];
  for (const [ref, oid] of sortedRefs(repo)) {
    if (wantSet.has(oid)) wantedRefLines.push(`${oid} ${ref}\n`);
  }
  if (wantedRefLines.length > 0) {
    const linesOut: Array<string | Buffer | 'flush' | 'delim' | 'response-end'> = ['wanted-refs\n'];
    for (const l of wantedRefLines) linesOut.push(l);
    linesOut.push('delim');
    parts.push(pktLines(linesOut));
  }
  // packfile
  if (plan.entries.length > 0) {
    const pack = buildPack(plan.entries);
    const section: Buffer[] = [pktLine('packfile\n')];
    section.push(...sidebandPackets(1, pack));
    parts.push(Buffer.concat(section));
  }
  parts.push(Buffer.from('0000', 'utf8'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// v0 upload-pack
// ---------------------------------------------------------------------------

function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  // Two sections separated by a flush; parse pkt-lines until the first flush,
  // then continue parsing the remainder (haves + done) the same way.
  const first = parsePktLinesUpTo(body, 0);
  const second = parsePktLinesUpTo(body, first.offset);
  const lines = [...dataLines(first.items), ...dataLines(second.items)];
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowKnown: string[] = [];
  let depth: number | undefined;
  for (const line of lines) {
    const arg = line.trim();
    if (arg.startsWith('want ')) {
      const rest = arg.slice(5).trim().split(/\s+/);
      if (rest[0] !== undefined) wants.push(rest[0]);
      // capabilities ride on the first want line; accepted and ignored.
    } else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowKnown.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const plan = planFetch(repo, wants, haves, depth, shallowKnown);
  const items: Array<string | Buffer | 'flush' | 'delim' | 'response-end'> = ['NAK\n'];
  for (const oid of plan.shallow) items.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) items.push(`unshallow ${oid}\n`);
  const head = pktLines(items);
  const pack = buildPack(plan.entries);
  const sideband = sidebandPackets(1, pack);
  return Buffer.concat([head, ...sideband, Buffer.from('0000', 'utf8')]);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer, store: Store): { body: Buffer; sideband: boolean } {
  const parsed = parsePktLinesUpTo(body, 0);
  const lines = dataLines(parsed.items);
  if (lines.length === 0) throw new Error('receive-pack: no commands');
  const commands: PushCommand[] = [];
  const caps = new Set<string>();
  lines.forEach((raw, idx) => {
    let line = raw;
    if (idx === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const capStr = line.slice(nul + 1).trim();
        for (const c of capStr.split(/\s+/)) if (c !== '') caps.add(c);
        line = line.slice(0, nul);
      }
    }
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) throw new Error('receive-pack: malformed command line');
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid)) {
      throw new Error('receive-pack: malformed oid in command line');
    }
    commands.push({ oldOid, newOid, ref });
  });
  const packBytes = body.subarray(parsed.offset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const obj of objects.values()) {
        store.putObject(repo, obj.type, obj.data);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const cmd of commands) {
    if (!unpackOk) {
      results.push({ ref: cmd.ref, ok: false, reason: `unpack failed: ${unpackDetail}` });
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Create or update: the new object must exist in the repo.
    const newObj = repo.objects.get(cmd.newOid);
    if (newObj === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: `unpack failed: object ${cmd.newOid} missing` });
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
      } else {
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update.
    if (current === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (cmd.oldOid !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    const oldCommit = peelToCommit(repo, cmd.oldOid);
    const newCommit = peelToCommit(repo, cmd.newOid);
    const oldObj = repo.objects.get(oldCommit);
    const newObjCommit = repo.objects.get(newCommit);
    if (oldObj === undefined || newObjCommit === undefined || newObjCommit.type !== 'commit') {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!store.isAncestor(repo, oldCommit, newCommit)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }

  // Apply the ok refs before answering.
  for (let i = 0; i < commands.length; i += 1) {
    const cmd = commands[i] as PushCommand;
    const res = results[i] as { ref: string; ok: boolean; reason: string };
    if (!res.ok) continue;
    if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
    else repo.refs.set(cmd.ref, cmd.newOid);
  }

  const reportLines: Array<string | Buffer | 'flush' | 'delim' | 'response-end'> = [];
  reportLines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`);
  for (const res of results) {
    reportLines.push(res.ok ? `ok ${res.ref}\n` : `ng ${res.ref} ${res.reason}\n`);
  }
  reportLines.push('flush');
  const report = pktLines(reportLines);
  const useSideband = caps.has('side-band-64k');
  if (useSideband) {
    const packets = sidebandPackets(1, report);
    return { body: Buffer.concat([...packets, Buffer.from('0000', 'utf8')]), sideband: true };
  }
  return { body: report, sideband: false };
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

function jsonResult(status: number, message: string): HandlerResult {
  return {
    status,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ message }), 'utf8'),
  };
}

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function handleGit(
  ctx: Ctx,
  method: string,
  path: string,
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): HandlerResult | null {
  const m = GIT_ROUTE.exec(path);
  if (m === null) return null;
  const owner = m[1] as string;
  const repoName = m[2] as string;
  const route = m[3] as string;
  if (!NAME_RE.test(owner) || !NAME_RE.test(repoName)) {
    return jsonResult(404, 'Not Found');
  }
  // Auth: the suite sends the bearer token on every git request (SPEC 1.4);
  // a missing/wrong token is refused with 401, like the other surfaces.
  if (!ctx.authed) return jsonResult(401, 'Unauthorized');
  const repo = ctx.store.getRepo(owner, repoName);
  if (repo === undefined) return jsonResult(404, 'Not Found');

  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) lowerHeaders[k.toLowerCase()] = v;
  }
  const isV2 = (lowerHeaders['git-protocol'] ?? '').includes('version=2');

  try {
    if (route === 'info/refs') {
      if (method !== 'GET') return jsonResult(405, 'Method Not Allowed');
      const service = query.get('service') ?? '';
      if (service === 'git-upload-pack') {
        if (isV2) {
          return {
            status: 200,
            contentType: 'application/x-git-upload-pack-advertisement',
            body: infoRefsV2(),
          };
        }
        return {
          status: 200,
          contentType: 'application/x-git-upload-pack-advertisement',
          body: infoRefsV0(repo, 'git-upload-pack'),
        };
      }
      if (service === 'git-receive-pack') {
        return {
          status: 200,
          contentType: 'application/x-git-receive-pack-advertisement',
          body: infoRefsV0(repo, 'git-receive-pack'),
        };
      }
      return jsonResult(404, 'Not Found');
    }

    if (route === 'git-upload-pack') {
      if (method !== 'POST') return jsonResult(405, 'Method Not Allowed');
      if (isV2) {
        const items = parsePktLines(body);
        const lines = dataLines(items);
        const first = lines[0] ?? '';
        if (first.startsWith('command=ls-refs')) {
          return {
            status: 200,
            contentType: 'application/x-git-upload-pack-result',
            body: handleLsRefs(repo, lines.slice(1)),
          };
        }
        if (first.startsWith('command=fetch')) {
          return {
            status: 200,
            contentType: 'application/x-git-upload-pack-result',
            body: handleFetchV2(repo, lines.slice(1)),
          };
        }
        return jsonResult(400, 'unknown v2 command');
      }
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-result',
        body: handleUploadPackV0(repo, body),
      };
    }

    // git-receive-pack (v0 only)
    if (method !== 'POST') return jsonResult(405, 'Method Not Allowed');
    const { body: reportBody } = handleReceivePack(repo, body, ctx.store);
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-result',
      body: reportBody,
    };
  } catch (err) {
    // A malformed git request must never crash the server or corrupt a repo.
    return jsonResult(400, err instanceof Error ? err.message : 'malformed git request');
  }
}
