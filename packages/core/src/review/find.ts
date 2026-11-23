/**
 * Fast in-file find for the review diff (Cmd/Ctrl+F).
 *
 * Rows are joined once into a single haystack (plus a lower-cased copy) with a
 * row-start table, so each query is a native `indexOf` / `RegExp` scan over one
 * string and matches map back to rows with a linear walk. 100k-line files
 * search in a few milliseconds.
 */

export interface FindIndex {
  /** rows joined with "\n" */
  hay: string;
  /** lower-cased `hay` (built lazily) */
  lower: string | null;
  /** offset of each row's first character in `hay` (length = rows + 1; last = hay.length + 1) */
  starts: Int32Array;
}

export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** stop collecting positions after this many matches (the total is still counted up to `countLimit`) */
  limit?: number;
  countLimit?: number;
}

export interface FindResult {
  /** row index of each collected match */
  rows: Int32Array;
  /** column (offset within the row) of each collected match */
  cols: Int32Array;
  /** length of each collected match */
  lens: Int32Array;
  /** total matches counted (capped at countLimit) */
  total: number;
  /** total hit countLimit */
  capped: boolean;
  /** regex failed to compile */
  error?: string;
}

const EMPTY: FindResult = { rows: new Int32Array(0), cols: new Int32Array(0), lens: new Int32Array(0), total: 0, capped: false };

export function buildFindIndex(rows: readonly string[]): FindIndex {
  const starts = new Int32Array(rows.length + 1);
  let offset = 0;
  for (let i = 0; i < rows.length; i++) {
    starts[i] = offset;
    offset += rows[i]!.length + 1;
  }
  starts[rows.length] = offset;
  return { hay: rows.join("\n"), lower: null, starts };
}

const WORD = /[\p{L}\p{N}_$]/u;
const isWordChar = (ch: string | undefined) => !!ch && WORD.test(ch);

export function findInIndex(index: FindIndex, query: string, opts: FindOptions = {}): FindResult {
  if (!query) return EMPTY;
  const limit = opts.limit ?? 20_000;
  const countLimit = opts.countLimit ?? 1_000_000;
  const rows: number[] = [];
  const cols: number[] = [];
  const lens: number[] = [];
  const { starts } = index;
  let row = 0;
  let total = 0;
  const push = (at: number, len: number): boolean => {
    while (starts[row + 1]! <= at) row++;
    // a match may not span rows
    if (at + len > starts[row + 1]! - 1 && len > 0) return true;
    if (opts.wholeWord && (isWordChar(index.hay[at - 1]) || isWordChar(index.hay[at + len]))) return true;
    total++;
    if (rows.length < limit) {
      rows.push(row);
      cols.push(at - starts[row]!);
      lens.push(len);
    }
    return total < countLimit;
  };

  if (opts.regex) {
    let re: RegExp;
    try {
      re = new RegExp(query, opts.caseSensitive ? "gmu" : "gimu");
    } catch (e) {
      return { ...EMPTY, error: (e as Error).message };
    }
    let m: RegExpExecArray | null;
    while ((m = re.exec(index.hay))) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (!push(m.index, m[0].length)) break;
    }
  } else {
    const hay = opts.caseSensitive ? index.hay : (index.lower ??= index.hay.toLowerCase());
    const needle = opts.caseSensitive ? query : query.toLowerCase();
    // toLowerCase can change length for a few exotic characters; fall back to a regex then.
    if (!opts.caseSensitive && hay.length !== index.hay.length) {
      return findInIndex(index, query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), { ...opts, regex: true });
    }
    let at = hay.indexOf(needle);
    while (at >= 0) {
      if (!push(at, needle.length)) break;
      at = hay.indexOf(needle, at + Math.max(1, needle.length));
    }
  }
  return { rows: Int32Array.from(rows), cols: Int32Array.from(cols), lens: Int32Array.from(lens), total, capped: total >= countLimit };
}

/** Index of the first collected match at or after (row, col); wraps to 0. */
export function nextMatch(result: FindResult, row: number, col = -1): number {
  const n = result.rows.length;
  if (!n) return -1;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = result.rows[mid]!;
    if (r < row || (r === row && result.cols[mid]! <= col)) lo = mid + 1;
    else hi = mid;
  }
  return lo < n ? lo : 0;
}

/** Matches grouped by row: row → [col, len][] (only rows that have matches). */
export function matchesByRow(result: FindResult): Map<number, [number, number][]> {
  const out = new Map<number, [number, number][]>();
  for (let i = 0; i < result.rows.length; i++) {
    const r = result.rows[i]!;
    let list = out.get(r);
    if (!list) out.set(r, (list = []));
    list.push([result.cols[i]!, result.lens[i]!]);
  }
  return out;
}

/**
 * Count matches per file in a raw unified diff without parsing hunks: only
 * hits on content lines (`+`, `-`, ` `) after the first `@@` of a file count.
 * `fileStarts` are the byte offsets of each file section in `text` (ascending).
 */
export function countMatchesPerFile(text: string, lowerText: string | null, fileStarts: readonly number[], query: string, opts: FindOptions = {}): Map<number, number> {
  const out = new Map<number, number>();
  if (!query) return out;
  const index: FindIndex = { hay: text, lower: lowerText, starts: new Int32Array([0, text.length + 1]) };
  // A single "row" spanning the whole text: rows are checked manually below.
  const res = findInIndexRaw(index, query, opts);
  let file = 0;
  for (let i = 0; i < res.length; i++) {
    const at = res[i]!;
    while (file + 1 < fileStarts.length && fileStarts[file + 1]! <= at) file++;
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    if (at === lineStart) continue; // the +/-/space prefix column
    const c = text.charCodeAt(lineStart);
    if (c !== 43 /* + */ && c !== 45 /* - */ && c !== 32 /* space */) continue;
    if (text.startsWith("+++ ", lineStart) || text.startsWith("--- ", lineStart)) continue;
    out.set(file, (out.get(file) ?? 0) + 1);
  }
  return out;
}

function findInIndexRaw(index: FindIndex, query: string, opts: FindOptions): number[] {
  const out: number[] = [];
  const max = opts.countLimit ?? 1_000_000;
  const text = index.hay;
  const word = (at: number, len: number) => !opts.wholeWord || (!isWordChar(text[at - 1]) && !isWordChar(text[at + len]));
  if (opts.regex) {
    let re: RegExp;
    try { re = new RegExp(query, opts.caseSensitive ? "gmu" : "gimu"); } catch { return out; }
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) && out.length < max) {
      if (!m[0].length) { re.lastIndex++; continue; }
      if (!m[0].includes("\n") && word(m.index, m[0].length)) out.push(m.index);
    }
    return out;
  }
  const hay = opts.caseSensitive ? text : (index.lower ?? text.toLowerCase());
  const needle = opts.caseSensitive ? query : query.toLowerCase();
  let at = hay.indexOf(needle);
  while (at >= 0 && out.length < max) {
    if (word(at, needle.length)) out.push(at);
    at = hay.indexOf(needle, at + Math.max(1, needle.length));
  }
  return out;
}
