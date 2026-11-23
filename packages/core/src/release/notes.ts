/**
 * Release notes for submodule bumps, in the spirit of release-drafter: for
 * each pinned submodule, collect the pull requests merged between the current
 * gitlink and the planned pin, group them by label into categories, and render
 * Markdown. Pure functions; fetching lives in the app.
 */

export interface NotesCategory {
  title: string;
  labels: string[];
  /** conventional-commit prefixes used when a change has no matching label */
  prefixes: string[];
}

export const DEFAULT_NOTE_CATEGORIES: NotesCategory[] = [
  { title: "🚀 Features", labels: ["feature", "enhancement", "feat", "new feature"], prefixes: ["feat"] },
  { title: "🐛 Bug fixes", labels: ["bug", "fix", "bugfix", "regression"], prefixes: ["fix"] },
  { title: "⚡ Performance", labels: ["performance", "perf"], prefixes: ["perf"] },
  { title: "📚 Documentation", labels: ["documentation", "docs"], prefixes: ["docs"] },
  { title: "🧰 Maintenance", labels: ["chore", "maintenance", "dependencies", "deps", "ci", "build", "refactor", "test", "tests"], prefixes: ["chore", "ci", "build", "refactor", "test", "style", "deps"] },
];

export const UNCATEGORIZED = "Other changes";

export interface NoteChange {
  /** PR number when known, else null (plain commit) */
  number: number | null;
  title: string;
  author: string | null;
  labels: string[];
  url: string;
  sha: string;
}

export interface SubmoduleNotes {
  path: string;
  repo: string | null; // owner/name of the child repository
  fromSha: string | null;
  toSha: string;
  commitCount: number;
  changes: NoteChange[];
  /** non-fatal problems (e.g. truncated compare) */
  warnings: string[];
}

/** PR number referenced by a merge or squash commit message, if any. */
export function prNumberFromMessage(message: string): number | null {
  const first = message.split("\n")[0] ?? "";
  const merge = /^Merge pull request #(\d+)\b/.exec(first);
  if (merge) return Number(merge[1]);
  const squash = /\(#(\d+)\)\s*$/.exec(first);
  if (squash) return Number(squash[1]);
  return null;
}

/** Category title for a change: labels first, then conventional-commit prefix. */
export function categorize(change: Pick<NoteChange, "title" | "labels">, categories: NotesCategory[] = DEFAULT_NOTE_CATEGORIES): string {
  const labels = change.labels.map((l) => l.toLowerCase());
  for (const c of categories) if (c.labels.some((l) => labels.includes(l))) return c.title;
  const prefix = /^(\w+)(\([^)]*\))?!?:/.exec(change.title.trim())?.[1]?.toLowerCase();
  if (prefix) for (const c of categories) if (c.prefixes.includes(prefix)) return c.title;
  return UNCATEGORIZED;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 10) : "(new)");

/** Render notes for all submodules as Markdown. */
export function renderReleaseNotes(releaseName: string, subs: SubmoduleNotes[], categories: NotesCategory[] = DEFAULT_NOTE_CATEGORIES): string {
  const out: string[] = [`# ${releaseName}`, ""];
  const changed = subs.filter((s) => s.fromSha !== s.toSha);
  if (!changed.length) return [...out, "_No submodule changes._", ""].join("\n");
  out.push(`Updates ${changed.length} submodule${changed.length > 1 ? "s" : ""}.`, "");
  out.push("| Submodule | From | To | Commits |", "|---|---|---|---|");
  for (const s of changed) {
    const link = (sha: string | null) => (s.repo && sha ? `[\`${short(sha)}\`](https://github.com/${s.repo}/commit/${sha})` : `\`${short(sha)}\``);
    out.push(`| \`${s.path}\` | ${link(s.fromSha)} | ${link(s.toSha)} | ${s.commitCount} |`);
  }
  out.push("");
  for (const s of changed) {
    const compare = s.repo && s.fromSha ? ` ([compare](https://github.com/${s.repo}/compare/${s.fromSha}...${s.toSha}))` : "";
    out.push(`## ${s.path}${s.repo ? ` · ${s.repo}` : ""}`, "", `\`${short(s.fromSha)}\` → \`${short(s.toSha)}\` · ${s.commitCount} commit${s.commitCount === 1 ? "" : "s"}${compare}`, "");
    for (const w of s.warnings) out.push(`> ⚠ ${w}`, "");
    if (!s.changes.length) {
      out.push("_No pull requests found in this range._", "");
      continue;
    }
    const groups = new Map<string, NoteChange[]>();
    for (const c of s.changes) {
      const t = categorize(c, categories);
      groups.set(t, [...(groups.get(t) ?? []), c]);
    }
    const order = [...categories.map((c) => c.title), UNCATEGORIZED];
    for (const title of order) {
      const items = groups.get(title);
      if (!items?.length) continue;
      out.push(`### ${title}`, "");
      for (const c of items) {
        const ref = c.number != null ? `[#${c.number}](${c.url})` : `[\`${c.sha.slice(0, 7)}\`](${c.url})`;
        out.push(`- ${c.title.replace(/\s*\(#\d+\)\s*$/, "")} ${ref}${c.author ? ` @${c.author}` : ""}`);
      }
      out.push("");
    }
    const authors = [...new Set(s.changes.map((c) => c.author).filter((a): a is string => !!a))].sort();
    if (authors.length) out.push(`**Contributors:** ${authors.map((a) => `@${a}`).join(", ")}`, "");
  }
  return out.join("\n");
}
