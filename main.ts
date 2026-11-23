// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree, moves: [string, string][]) => void;

/** First of the values that is not undefined (null counts as a value). */
function pick<T>(...vs: (T | undefined)[]): T | undefined {
  for (const v of vs) if (v !== undefined) return v;
  return undefined;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** A file as lines: its line break, its lines, and whether it ends with one (section 3). */
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every position where O occurs in lines at one tier (section 5). */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const pos: number[] = [];
  if (o.length === 0 || o.length > lines.length) return pos;
  const no = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== no[j]) { ok = false; break; }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier at which O occurs, with its positions, or null. */
function findAtTier(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first tier at which O occurs at or after `from`, with those positions, or null. */
function findAtTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t).filter((p) => p >= from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first line at or after `from` equal to one line at the first tier with one, or -1. */
function findSingleLine(lines: string[], one: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(one, t)) return i;
    }
  }
  return -1;
}

/** A line of N re-indented from P to F (section 5, tier 2). */
function reindent(line: string, f: string, p: string): string {
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNl?: boolean;
}

/** The lines N writes when O matched at `pos`: context lines are the file's own (section 5). */
function buildNew(items: BodyLine[], fileLines: string[], pos: number, tier: number): string[] {
  const oItems = items.filter((i) => i.kind !== 'new');
  if (oItems.length === 0) return items.filter((i) => i.kind === 'new').map((i) => i.text);
  const f = leadWs(fileLines[pos] ?? '');
  const p = leadWs(oItems[0]!.text);
  const out: string[] = [];
  let oIdx = 0;
  for (const it of items) {
    if (it.kind === 'old') { oIdx++; continue; }
    if (it.kind === 'ctx') { out.push(fileLines[pos + oIdx]!); oIdx++; continue; }
    out.push(tier === 2 ? reindent(it.text, f, p) : it.text);
  }
  return out;
}

/** Whether a `\` line follows the hunk's last context or `+` line (section 6). */
function lastCtxNewNoNl(items: BodyLine[]): boolean {
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]!;
    if (it.kind === 'ctx' || it.kind === 'new') return it.noNl === true;
  }
  return false;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Unified diffs (SPEC.md section 6) ---- */

interface Hunk {
  a: number;
  items: BodyLine[];
}

interface UniSection {
  pairOld?: string | null;
  pairNew?: string | null;
  renOld?: string | null;
  renNew?: string | null;
  diffOld?: string | null;
  diffNew?: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** A `--- `/`+++ ` path: text after the four characters, up to the first tab, trimmed; /dev/null is no file. */
function uniPath(s: string): string | null {
  const t = s.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return t.replace(/^[ab]\//, '');
}

/** A section's header: paths, rename lines, new/deleted file mode. Returns the next line index. */
function uniHeader(lines: string[], i: number, sec: UniSection): number {
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) return i;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (sec.pairOld === undefined) {
          sec.pairOld = uniPath(l);
          sec.pairNew = uniPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        return i;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('+++ ')) {
      if (sec.pairNew === undefined) sec.pairNew = uniPath(l);
      i++;
      continue;
    }
    if (l.startsWith('rename from ')) {
      if (sec.renOld === undefined) sec.renOld = l.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (sec.renNew === undefined) sec.renNew = l.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('new file mode')) { sec.create = true; i++; continue; }
    if (l.startsWith('deleted file mode')) { sec.del = true; i++; continue; }
    i++;
  }
  return i;
}

/** A section's hunks. Returns the next line index. */
function uniHunks(lines: string[], i: number, sec: UniSection): number {
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    if (l.startsWith('@@')) {
      const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), items: [] };
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('@@')) break;
        if (b === '') { hunk.items.push({ kind: 'ctx', text: '' }); i++; continue; }
        const c = b[0]!;
        if (c === ' ') { hunk.items.push({ kind: 'ctx', text: b.slice(1) }); i++; continue; }
        if (c === '-') { hunk.items.push({ kind: 'old', text: b.slice(1) }); i++; continue; }
        if (c === '+') { hunk.items.push({ kind: 'new', text: b.slice(1) }); i++; continue; }
        if (c === '\\') {
          const last = hunk.items[hunk.items.length - 1];
          if (last !== undefined) last.noNl = true;
          i++;
          continue;
        }
        break;
      }
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1]!;
        if (last.kind === 'ctx' && last.text === '' && last.noNl !== true) hunk.items.pop();
        else break;
      }
      sec.hunks.push(hunk);
      continue;
    }
    i++;
  }
  return i;
}

/** Apply a section's hunks in order to one file's text (section 6). */
function applyHunks(text: string, hunks: Hunk[], path: string, strict: boolean): string {
  const model = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const oItems = h.items.filter((x) => x.kind !== 'new');
    const O = oItems.map((x) => x.text);
    if (O.length === 0) {
      const idx = Math.min(h.a + d, model.lines.length);
      const atEnd = idx === model.lines.length;
      const out = buildNew(h.items, model.lines, idx, 0);
      model.lines.splice(idx, 0, ...out);
      if (atEnd) model.final = !lastCtxNewNoNl(h.items);
      d += out.length;
      continue;
    }
    const found = findAtTier(model.lines, O, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    for (const p of found.pos) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const atEnd = best + O.length === model.lines.length;
    const out = buildNew(h.items, model.lines, best, found.tier);
    model.lines.splice(best, O.length, ...out);
    if (atEnd) model.final = !lastCtxNewNoNl(h.items);
    d += out.length - O.length;
  }
  return joinFile(model);
}

/** One unified section as one edit. */
function uniEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = pick(sec.pairOld, sec.renOld, sec.diffOld);
  const newP = pick(sec.pairNew, sec.renNew, sec.diffNew);
  return (tree, moves) => {
    if (oldP !== undefined && oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== undefined && newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (sec.create || oldP === null || oldP === undefined) {
      const np = newP as string | null | undefined;
      if (np === null || np === undefined) return;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const ls: string[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'new') ls.push(it.text);
      let fin = true;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        for (let k = h.items.length - 1; k >= 0; k--) {
          if (h.items[k]!.kind === 'new') { fin = h.items[k]!.noNl !== true; break outer; }
        }
      }
      tree.now.set(np, ls.length === 0 ? '' : ls.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (sec.del || newP === null || newP === undefined) {
      const op = oldP as string;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP as string;
    const np = newP as string;
    if (op !== np) {
      const cur = tree.get(op);
      if (cur === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const res = applyHunks(cur, sec.hunks, op, strict);
      tree.now.set(op, null);
      tree.now.set(np, res);
      moves.push([op, np]);
      return;
    }
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    tree.now.set(op, applyHunks(cur, sec.hunks, op, strict));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = l.trimEnd().match(/^diff --git a\/(\S+) b\/(\S+)$/);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: UniSection = { diffOld: m[1]!, diffNew: m[2]!, create: false, del: false, hunks: [] };
      i++;
      i = uniHeader(lines, i, sec);
      i = uniHunks(lines, i, sec);
      sections.push(sec);
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: UniSection = { create: false, del: false, hunks: [] };
      sec.pairOld = uniPath(l);
      sec.pairNew = uniPath(lines[i + 1]!);
      i += 2;
      i = uniHeader(lines, i, sec);
      i = uniHunks(lines, i, sec);
      sections.push(sec);
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => uniEdit(s, strict));
}

/* ---- SEARCH/REPLACE blocks (SPEC.md section 7) ---- */

function makeSrEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const model = splitFile(cur);
    const found = findAtTier(model.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const f = leadWs(model.lines[pos] ?? '');
    const p = leadWs(oldLines[0]!);
    const out = newLines.map((l) => (found.tier === 2 ? reindent(l, f, p) : l));
    model.lines.splice(pos, oldLines.length, ...out);
    tree.now.set(path, joinFile(model));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let si = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') { si = j; break; }
    }
    if (si < 0) break;
    let path: string | null = null;
    for (let j = si - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${si + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = si + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${si + 1}`);
    edits.push(makeSrEdit(path, lines.slice(si + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---- V4A patches (SPEC.md section 8) ---- */

interface V4aChunk {
  anchor: string | null;
  items: BodyLine[];
  eof: boolean;
}

function makeV4aAdd(path: string, ls: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, ls.length === 0 ? '' : ls.join('\n') + '\n');
  };
}

function makeV4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function makeV4aUpdate(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree, moves) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const at = findSingleLine(model.lines, ch.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const oItems = ch.items.filter((x) => x.kind !== 'new');
      const O = oItems.map((x) => x.text);
      if (O.length === 0) {
        const idx = ch.eof ? model.lines.length : cursor;
        const out = ch.items.filter((x) => x.kind === 'new').map((x) => x.text);
        model.lines.splice(idx, 0, ...out);
        cursor = idx + out.length;
        continue;
      }
      const found = findAtTierFrom(model.lines, O, cursor, strict);
      if (found === null) throw new Fail('no-match', path);
      let pos = -1;
      if (ch.eof) {
        for (const p of found.pos) {
          if (p + O.length === model.lines.length) { pos = p; break; }
        }
        if (pos < 0) throw new Fail('no-match', path);
      } else {
        pos = found.pos[0]!;
      }
      const out = buildNew(ch.items, model.lines, pos, found.tier);
      model.lines.splice(pos, O.length, ...out);
      cursor = pos + out.length;
    }
    const text = joinFile(model);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) { last = j; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i++; continue; }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const raw: string[] = [];
      i++;
      while (i < last) {
        const s = lines[i]!;
        if (s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ')) break;
        if (s.startsWith('+')) { raw.push(s.slice(1)); i++; continue; }
        if (s === '') { raw.push(''); i++; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      edits.push(makeV4aAdd(path, raw));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i++;
      edits.push(makeV4aDelete(path));
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const updateLine = i;
      const path = l.slice('*** Update File: '.length).trim();
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      const flush = (strip: boolean): void => {
        if (cur === null) return;
        if (strip) {
          while (cur.items.length > 0) {
            const lastItem = cur.items[cur.items.length - 1]!;
            if (lastItem.kind === 'ctx' && lastItem.text === '') cur.items.pop();
            else break;
          }
        }
        chunks.push(cur);
        cur = null;
      };
      while (i < last) {
        const s = lines[i]!;
        if (s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ')) break;
        if (s === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          flush(false);
          i++;
          continue;
        }
        if (s.startsWith('@@')) {
          flush(false);
          cur = { anchor: s.slice(2).trim(), items: [], eof: false };
          i++;
          continue;
        }
        if (s === '' || s[0] === ' ' || s[0] === '-' || s[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, items: [], eof: false };
          }
          if (s === '') cur.items.push({ kind: 'ctx', text: '' });
          else if (s[0] === ' ') cur.items.push({ kind: 'ctx', text: s.slice(1) });
          else if (s[0] === '-') cur.items.push({ kind: 'old', text: s.slice(1) });
          else cur.items.push({ kind: 'new', text: s.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      flush(true);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(makeV4aUpdate(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? srEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: [string, string][] = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const rNew = new Set<string>();
  const rOld = new Set<string>();
  for (const [old, nw] of moves) {
    const wasOld = tree.original(old);
    const nowOld = tree.get(old);
    const wasNew = tree.original(nw);
    const nowNew = tree.get(nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: nw, text: `R ${old} -> ${nw}` });
      rNew.add(nw);
      rOld.add(old);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (rNew.has(p) || rOld.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, v] of tree.now) {
      if (v === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
