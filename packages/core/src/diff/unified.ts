/**
 * Streaming-friendly unified (git) diff parser (design §5.5, §6).
 *
 * Produces an index of file entries with byte offsets into the source patch so
 * the UI can lazily materialise only the visible file's hunks. Never executes
 * or interprets anything in the text beyond diff syntax.
 */

export type ChangeKind = "added" | "deleted" | "modified" | "renamed" | "copied" | "mode-change" | "binary" | "submodule";

export interface DiffFileEntry {
  /** index within its patch */
  index: number;
  oldPath: string | null; // null for /dev/null
  newPath: string | null;
  /** display path (new path, or old path when deleted) */
  path: string;
  kind: ChangeKind;
  binary: boolean;
  /** gitlink (mode 160000) change — a submodule pointer update */
  gitlink: boolean;
  oldMode: string | null;
  newMode: string | null;
  similarity: number | null;
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
  hunkCount: number;
  /** [start, end) character offsets of this file's section in the patch text */
  start: number;
  end: number;
  /** Characters of the section; helps the UI treat huge generated files distinctly. */
  size: number;
  generated: boolean;
  issues: string[];
}

export type LineKind = "context" | "add" | "del" | "meta";

export interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** text after the second @@, typically the enclosing function */
  section: string;
  lines: DiffLine[];
  /** Stable content hash of the hunk's +/- lines (for revision-aware review). */
  hash: string;
}

export interface ParsedPatchIndex {
  files: DiffFileEntry[];
  issues: string[];
  additions: number;
  deletions: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const GENERATED_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|.*\.min\.(js|css)|.*\.generated\.\w+|.*_pb2\.py)$|(^|\/)(dist|build|generated)\//;

/** Unquote git's C-style quoted paths: "a/foo\tbar" */
function unquote(p: string): string {
  if (!p.startsWith('"')) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c !== "\\") {
      for (const b of new TextEncoder().encode(c)) bytes.push(b);
      continue;
    }
    const n = inner[++i];
    if (n === undefined) break;
    if (/[0-7]/.test(n)) {
      const oct = inner.slice(i, i + 3);
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else {
      const map: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
      bytes.push(map[n] ?? n.charCodeAt(0));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function stripPrefix(p: string): string | null {
  const u = unquote(p.trim());
  if (u === "/dev/null") return null;
  return u.replace(/^[ab]\//, "");
}

/** Split `diff --git a/x b/y` handling quoted paths and spaces when a==b. */
function parseGitHeader(line: string): { a: string; b: string } | null {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*")\s+(.*)$/.exec(rest);
    if (!m) return null;
    return { a: stripPrefix(m[1]!) ?? "", b: stripPrefix(m[2]!) ?? "" };
  }
  // Unquoted: if both halves are identical paths, split in the middle.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " ") {
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (a.slice(2) === b.slice(2)) return { a: a.slice(2), b: b.slice(2) };
  }
  const idx = rest.indexOf(" b/");
  if (idx < 0) return null;
  return { a: rest.slice(0, idx).replace(/^a\//, ""), b: rest.slice(idx + 3) };
}

export function isUnsafePath(p: string): boolean {
  if (!p) return true;
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.includes("\0")) return true;
  return p.split(/[\\/]/).some((seg) => seg === "..");
}

/**
 * Index a patch: one pass over lines, recording per-file metadata and offsets.
 * O(n) time; does not retain line arrays.
 */
export function indexPatch(text: string): ParsedPatchIndex {
  const files: DiffFileEntry[] = [];
  const issues: string[] = [];
  let cur: DiffFileEntry | null = null;
  let pos = 0;
  let inHunk = false;
  let remOld = 0;
  let remNew = 0;
  let sawHeaderLines = false;

  const finish = (end: number) => {
    if (!cur) return;
    cur.end = end;
    cur.size = end - cur.start;
    if (inHunk && (remOld > 0 || remNew > 0)) cur.issues.push("Truncated hunk: fewer lines than declared in @@ header");
    if (!cur.kind) cur.kind = "modified";
    if (cur.gitlink) cur.kind = "submodule";
    else if (cur.binary && cur.kind === "modified") cur.kind = "binary";
    for (const p of [cur.oldPath, cur.newPath]) if (p && isUnsafePath(p)) cur.issues.push(`Unsafe path "${p}"`);
    cur.generated = GENERATED_RE.test(cur.path);
    files.push(cur);
    cur = null;
  };

  const len = text.length;
  while (pos < len) {
    let nl = text.indexOf("\n", pos);
    if (nl < 0) nl = len;
    const line = text.charCodeAt(nl - 1) === 13 ? text.slice(pos, nl - 1) : text.slice(pos, nl);
    const lineStart = pos;
    pos = nl + 1;

    if (line.startsWith("diff --git ")) {
      finish(lineStart);
      const h = parseGitHeader(line);
      if (!h) issues.push(`Malformed diff header at offset ${lineStart}`);
      cur = {
        index: files.length,
        oldPath: h?.a ?? null,
        newPath: h?.b ?? null,
        path: h?.b ?? h?.a ?? "(unknown)",
        kind: "modified",
        binary: false,
        gitlink: false,
        oldMode: null,
        newMode: null,
        similarity: null,
        oldOid: null,
        newOid: null,
        additions: 0,
        deletions: 0,
        hunkCount: 0,
        start: lineStart,
        end: lineStart,
        size: 0,
        generated: false,
        issues: h ? [] : ["Malformed diff --git header"],
      };
      inHunk = false;
      sawHeaderLines = true;
      continue;
    }
    if (!cur) {
      if (line.trim() && !sawHeaderLines) {
        // Tolerate leading commentary (e.g. `git format-patch` preamble), but flag it.
        if (!issues.includes("Content before first diff header")) issues.push("Content before first diff header");
      }
      continue;
    }
    const c: DiffFileEntry = cur;

    if (inHunk) {
      const ch = line[0];
      if (ch === "+" && remNew > 0) { c.additions++; remNew--; continue; }
      if (ch === "-" && remOld > 0) { c.deletions++; remOld--; continue; }
      if ((ch === " " || line === "") && (remOld > 0 || remNew > 0)) { remOld--; remNew--; if (remOld <= 0 && remNew <= 0) { remOld = Math.max(0, remOld); remNew = Math.max(0, remNew); } continue; }
      if (ch === "\\") continue; // "\ No newline at end of file"
      if (remOld > 0 || remNew > 0) {
        if (!line.startsWith("@@")) { c.issues.push(`Unexpected line inside hunk: "${line.slice(0, 40)}"`); continue; }
        c.issues.push("Truncated hunk: fewer lines than declared in @@ header");
      }
      inHunk = false;
    }

    if (line.startsWith("@@")) {
      const m = HUNK_RE.exec(line);
      if (!m) { c.issues.push(`Malformed hunk header "${line.slice(0, 60)}"`); continue; }
      c.hunkCount++;
      remOld = m[2] === undefined ? 1 : Number(m[2]);
      remNew = m[4] === undefined ? 1 : Number(m[4]);
      inHunk = true;
      continue;
    }
    if (line.startsWith("new file mode ")) { c.kind = "added"; c.newMode = line.slice(14).trim(); c.gitlink ||= c.newMode === "160000"; continue; }
    if (line.startsWith("deleted file mode ")) { c.kind = "deleted"; c.oldMode = line.slice(18).trim(); c.path = c.oldPath ?? c.path; c.gitlink ||= c.oldMode === "160000"; continue; }
    if (line.startsWith("old mode ")) { c.oldMode = line.slice(9).trim(); continue; }
    if (line.startsWith("new mode ")) { c.newMode = line.slice(9).trim(); if (c.kind === "modified") c.kind = "mode-change"; continue; }
    if (line.startsWith("similarity index ")) { c.similarity = parseInt(line.slice(17), 10); continue; }
    if (line.startsWith("rename from ")) { c.kind = "renamed"; c.oldPath = unquote(line.slice(12)); continue; }
    if (line.startsWith("rename to ")) { c.kind = "renamed"; c.newPath = unquote(line.slice(10)); c.path = c.newPath; continue; }
    if (line.startsWith("copy from ")) { c.kind = "copied"; c.oldPath = unquote(line.slice(10)); continue; }
    if (line.startsWith("copy to ")) { c.kind = "copied"; c.newPath = unquote(line.slice(8)); c.path = c.newPath; continue; }
    if (line.startsWith("index ")) {
      const m = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?/.exec(line);
      if (m) { c.oldOid = m[1]!; c.newOid = m[2]!; if (m[3]) { c.oldMode ??= m[3]; c.newMode ??= m[3]; c.gitlink ||= m[3] === "160000"; } }
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") { c.binary = true; continue; }
    if (line.startsWith("--- ")) { const p = stripPrefix(line.slice(4)); if (p === null) c.kind = "added"; continue; }
    if (line.startsWith("+++ ")) { const p = stripPrefix(line.slice(4)); if (p === null) { c.kind = "deleted"; c.path = c.oldPath ?? c.path; } continue; }
    if (line.startsWith("Subproject commit ")) { c.gitlink = true; continue; }
    if (line.trim() === "") continue;
    c.issues.push(`Unrecognised header line "${line.slice(0, 60)}"`);
  }
  finish(len);
  if (!files.length && text.trim()) issues.push("No diff --git entries found");

  let additions = 0, deletions = 0;
  for (const f of files) { additions += f.additions; deletions += f.deletions; }
  return { files, issues, additions, deletions };
}

/** Materialise hunks for a single file section (called lazily for visible files). */
export function parseFileHunks(section: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let o = 0, n = 0;
  for (const raw of section.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("@@")) {
      const m = HUNK_RE.exec(line);
      if (!m) continue;
      cur = {
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5] ?? "",
        lines: [],
        hash: "",
      };
      o = cur.oldStart;
      n = cur.newStart;
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    const ch = line[0];
    if (ch === "+") cur.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: n++ });
    else if (ch === "-") cur.lines.push({ kind: "del", text: line.slice(1), oldNo: o++, newNo: null });
    else if (ch === " ") cur.lines.push({ kind: "context", text: line.slice(1), oldNo: o++, newNo: n++ });
    else if (ch === "\\") cur.lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    else if (line === "" ) {
      // blank context line where trailing space was stripped — only if hunk still expects lines
      const used = cur.lines.filter((l) => l.kind !== "meta");
      const oldUsed = used.filter((l) => l.kind !== "add").length;
      const newUsed = used.filter((l) => l.kind !== "del").length;
      if (oldUsed < cur.oldLines || newUsed < cur.newLines) cur.lines.push({ kind: "context", text: "", oldNo: o++, newNo: n++ });
    }
  }
  for (const h of hunks) h.hash = fnv1a(h.lines.filter((l) => l.kind === "add" || l.kind === "del").map((l) => (l.kind === "add" ? "+" : "-") + l.text).join("\n"));
  return hunks;
}

/** Side-by-side row pairing: deletions and additions in a run are paired. */
export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

export function toSplitRows(h: Hunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    const k = Math.max(dels.length, adds.length);
    for (let i = 0; i < k; i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const l of h.lines) {
    if (l.kind === "del") dels.push(l);
    else if (l.kind === "add") adds.push(l);
    else {
      flush();
      if (l.kind === "context") rows.push({ left: l, right: l });
    }
  }
  flush();
  return rows;
}

/** 32-bit FNV-1a hex. Fast non-cryptographic content key for cache/dedup. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
