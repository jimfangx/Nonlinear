/**
 * Feature kanban (design §4): one shared card, many context-specific placements.
 */
import type { PRKey, RepoKey } from "../ids";

export interface Column {
  id: string;
  name: string;
}

export const DEFAULT_COLUMNS: Column[] = [
  { id: "backlog", name: "Backlog" },
  { id: "in-progress", name: "In progress" },
  { id: "blocked-upstream", name: "Blocked upstream" },
  { id: "needs-validation", name: "Needs validation" },
  { id: "ready-for-release", name: "Ready for release" },
  { id: "done", name: "Done" },
  { id: "deferred", name: "Deferred" },
];

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface FeatureCard {
  id: string;
  title: string;
  description: string;
  repos: RepoKey[];
  releases: string[];
  prs: PRKey[];
  chains: string[];
  links: { title: string; url: string }[];
  checklist: ChecklistItem[];
  /** card ids this card depends on */
  dependsOn: string[];
  notes: string;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
}

/** `repo:<repoKey>`, `release:<releaseId>`, `view:<viewId>`, or `all`. */
export type ViewContextId = string;

export interface CardPlacement {
  cardId: string;
  context: ViewContextId;
  column: string;
  /** fractional rank key; lexicographic order */
  rank: string;
  updatedAt: number;
}

export function contextTags(ctx: ViewContextId): { repos: RepoKey[]; releases: string[] } {
  if (ctx.startsWith("repo:")) return { repos: [ctx.slice(5)], releases: [] };
  if (ctx.startsWith("release:")) return { repos: [], releases: [ctx.slice(8)] };
  return { repos: [], releases: [] };
}

/** Cards visible in a context: those tagged with the context, or explicitly placed there. */
export function cardsInContext(cards: FeatureCard[], placements: CardPlacement[], ctx: ViewContextId): FeatureCard[] {
  const placed = new Set(placements.filter((p) => p.context === ctx).map((p) => p.cardId));
  return cards.filter((c) => {
    if (c.deleted) return false;
    if (ctx === "all" || placed.has(c.id)) return true;
    if (ctx.startsWith("repo:")) return c.repos.includes(ctx.slice(5));
    if (ctx.startsWith("release:")) return c.releases.includes(ctx.slice(8));
    return false;
  });
}

/** Placement for a card in a context, defaulting to first column at the end. */
export function placementOf(placements: CardPlacement[], cardId: string, ctx: ViewContextId, columns: Column[] = DEFAULT_COLUMNS): CardPlacement {
  return placements.find((p) => p.cardId === cardId && p.context === ctx) ?? { cardId, context: ctx, column: columns[0]!.id, rank: "n", updatedAt: 0 };
}

/* Fractional indexing over base-36 lowercase digits. Ranks never end in "0". */
const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A rank strictly between a and b (null = unbounded). Throws if a >= b. */
export function rankBetween(a: string | null, b: string | null): string {
  const lo = a ?? "";
  let hi = b;
  if (hi !== null && lo >= hi) throw new Error(`rankBetween: ${lo} >= ${hi}`);
  let out = "";
  for (let i = 0; ; i++) {
    const da = i < lo.length ? DIGITS.indexOf(lo[i]!) : 0;
    const db = hi === null ? DIGITS.length : i < hi.length ? DIGITS.indexOf(hi[i]!) : DIGITS.length;
    if (da === db) {
      out += DIGITS[da]!;
      continue;
    }
    const m = Math.floor((da + db) / 2);
    if (m > da) return out + DIGITS[m]!;
    out += DIGITS[da]!;
    hi = null; // out is now strictly below hi for any suffix
  }
}

export interface MoveResult {
  placements: CardPlacement[];
  moved: CardPlacement;
}

/** Move card within a context's column to `index` (0-based) — only that context's placement changes. */
export function moveCard(
  placements: CardPlacement[],
  cardId: string,
  ctx: ViewContextId,
  column: string,
  index: number,
  now = Date.now(),
): MoveResult {
  const others = placements
    .filter((p) => p.context === ctx && p.column === column && p.cardId !== cardId)
    .sort((x, y) => (x.rank < y.rank ? -1 : x.rank > y.rank ? 1 : x.cardId.localeCompare(y.cardId)));
  const i = Math.max(0, Math.min(index, others.length));
  const before = others[i - 1]?.rank ?? null;
  const after = others[i]?.rank ?? null;
  let rank: string;
  try {
    rank = rankBetween(before, after);
  } catch {
    rank = (before ?? "") + "n"; // identical ranks; append
  }
  const moved: CardPlacement = { cardId, context: ctx, column, rank, updatedAt: now };
  const rest = placements.filter((p) => !(p.cardId === cardId && p.context === ctx));
  return { placements: [...rest, moved], moved };
}

export function columnCards(cards: FeatureCard[], placements: CardPlacement[], ctx: ViewContextId, column: string, columns: Column[] = DEFAULT_COLUMNS): FeatureCard[] {
  return cardsInContext(cards, placements, ctx)
    .map((c) => ({ c, p: placementOf(placements, c.id, ctx, columns) }))
    .filter(({ p }) => p.column === column)
    .sort((x, y) => (x.p.rank < y.p.rank ? -1 : x.p.rank > y.p.rank ? 1 : x.c.id.localeCompare(y.c.id)))
    .map(({ c }) => c);
}

/** Create a card in a context: it automatically receives the context's tags (§4). */
export function newCardInContext(id: string, title: string, ctx: ViewContextId, now = Date.now()): FeatureCard {
  const t = contextTags(ctx);
  return { id, title, description: "", repos: t.repos, releases: t.releases, prs: [], chains: [], links: [], checklist: [], dependsOn: [], notes: "", createdAt: now, updatedAt: now };
}
