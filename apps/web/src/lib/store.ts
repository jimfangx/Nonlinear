/**
 * App state: one zustand store over typed collections, persisted to IndexedDB
 * on every write (local-first), and recorded as sync ops for user-owned kinds.
 */
import { create } from "zustand";
import {
  DEFAULT_COLUMNS,
  DEFAULT_POLICY,
  DEFAULT_BUDGET,
  DEFAULT_MODELS,
  newId,
  type CardPlacement,
  type ClassificationPolicy,
  type Column,
  type FeatureCard,
  type Intention,
  type LedgerEntry,
  type LocalEdge,
  type LocalPRAttrs,
  type ModelInfo,
  type PRReviewProgress,
  type PRSnapshot,
  type PREvent,
  type PrivateNote,
  type Release,
  type ReleasePin,
  type RepoInfo,
  type BudgetPolicy,
  type RepoAIPolicy,
  type Zoom,
  type EntityKind,
  type Op,
} from "@nonlinear/core";
import { deleteRecord, loadAll, outboxAdd, putRecord } from "./db";

export interface RepositoryView {
  id: string;
  name: string;
  repos: string[]; // RepoKey
  category: string; // default filter
  groupBy: "none" | "repo" | "chain" | "release";
  sort: "updated" | "created" | "repo";
  releaseLens: string | null;
  createdAt: number;
}

export interface TimelineView {
  id: string;
  name: string;
  root: string; // RepoKey
  baseRef: string;
  rootSha: string | null; // selected root commit (null = tip of baseRef)
  visiblePaths: string[] | null;
  zoom: Zoom;
  parentTimelineId: string | null;
  pathPrefix: string[]; // path chain from top-level root for nested views
  createdAt: number;
  /** where git data comes from (default GitHub API) */
  source?: import("./sources").Source;
}

export interface ChainRecord {
  id: string;
  label: string;
  members: string[]; // PR keys, display order hint
  createdAt: number;
}

export interface DraftComment {
  id: string;
  prKey: string;
  headSha: string;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  body: string;
  createdAt: number;
}

export interface SummaryRecord {
  key: string;
  prKey: string;
  file: string | null;
  diffHash: string;
  modelId: string;
  promptVersion: string;
  text: string;
  costUsd: number;
  createdAt: number;
}

export interface SyncConflict {
  key: string; // `${collection}:${id}`
  collection: string;
  id: string;
  base: unknown;
  local: unknown;
  remote: unknown;
  remoteDevice: string;
  at: number;
}

export interface DiffImportMeta {
  id: string;
  name: string;
  rootRepo: string | null;
  sourceBytes: number;
  contentHash: string;
  importedAt: number;
  totals: { files: number; additions: number; deletions: number };
}

export interface Settings {
  theme: "system" | "light" | "dark";
  publicOnly: boolean;
  /** GitHub REST base (GitHub Enterprise or a local mock for tests) */
  apiBase: string;
  me: string | null;
  myTeams: string[];
  authMode: "anonymous" | "oauth" | "pat";
  tokenCanWrite: boolean;
  syncUrl: string;
  syncEnabled: boolean;
  deviceId: string;
  lastSyncAt: number | null;
  lastSyncError: string | null;
  policy: ClassificationPolicy;
  budgets: Partial<Record<string, BudgetPolicy>>;
  models: ModelInfo[];
  defaultModel: string;
  escalationModel: string;
  aiPolicies: RepoAIPolicy[];
  aiEnabled: boolean;
  columns: Column[];
  keybindings: Record<string, string>;
  layout: Record<string, unknown>;
  sshHosts: { alias: string; root: string; user?: string; allowed: boolean }[];
  /** Language → language-server registry (any language; user-editable). */
  lspServers: LspServer[];
  /** repoKey → absolute local working-tree path (desktop) */
  localRepos: Record<string, string>;
}

export interface LspServer {
  name: string;
  extensions: string[];
  languageId: string;
  command: string;
  args: string[];
  enabled: boolean;
}

export const DEFAULT_LSP: LspServer[] = [
  { name: "Metals (Scala/Chisel)", extensions: ["scala", "sc", "sbt"], languageId: "scala", command: "metals", args: [], enabled: true },
  { name: "clangd (C/C++)", extensions: ["c", "h", "cc", "cpp", "cxx", "hpp", "hh"], languageId: "cpp", command: "clangd", args: ["--background-index"], enabled: true },
  { name: "Pyright (Python)", extensions: ["py"], languageId: "python", command: "pyright-langserver", args: ["--stdio"], enabled: true },
  { name: "rust-analyzer", extensions: ["rs"], languageId: "rust", command: "rust-analyzer", args: [], enabled: true },
  { name: "TypeScript/JavaScript", extensions: ["ts", "tsx", "js", "jsx", "mjs"], languageId: "typescript", command: "typescript-language-server", args: ["--stdio"], enabled: true },
  { name: "Verible (Verilog/SystemVerilog)", extensions: ["v", "vh", "sv", "svh"], languageId: "systemverilog", command: "verible-verilog-ls", args: [], enabled: true },
  { name: "gopls (Go)", extensions: ["go"], languageId: "go", command: "gopls", args: [], enabled: true },
  { name: "Eclipse JDT LS (Java)", extensions: ["java"], languageId: "java", command: "jdtls", args: [], enabled: true },
];

export const DEFAULT_KEYS: Record<string, string> = {
  next: "j",
  prev: "k",
  nextHunk: "n",
  prevHunk: "p",
  markReviewed: "r",
  flag: "x",
  comment: "c",
  impact: "g",
  chainPrev: "[",
  chainNext: "]",
  palette: "mod+k",
};

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  publicOnly: true,
  apiBase: "https://api.github.com",
  me: null,
  myTeams: [],
  authMode: "anonymous",
  tokenCanWrite: false,
  syncUrl: "",
  syncEnabled: false,
  deviceId: newId("dev"),
  lastSyncAt: null,
  lastSyncError: null,
  policy: DEFAULT_POLICY,
  budgets: { openai: DEFAULT_BUDGET, anthropic: DEFAULT_BUDGET },
  models: DEFAULT_MODELS,
  defaultModel: "gpt-6.1-terra",
  escalationModel: "gpt-6.1-sol",
  aiPolicies: [],
  aiEnabled: false,
  columns: DEFAULT_COLUMNS,
  keybindings: DEFAULT_KEYS,
  layout: {},
  sshHosts: [],
  lspServers: DEFAULT_LSP,
  localRepos: {},
};

/** Collections and which are synced (user-owned) vs local cache only. */
export const COLLECTIONS = {
  views: { synced: true, kind: "view" },
  timelines: { synced: true, kind: "timeline" },
  releases: { synced: true, kind: "release" },
  pins: { synced: true, kind: "release-pin" },
  cards: { synced: true, kind: "card" },
  placements: { synced: true, kind: "placement" },
  notes: { synced: true, kind: "note" },
  reviews: { synced: true, kind: "review" },
  localEdges: { synced: true, kind: "chain-edge" },
  chains: { synced: true, kind: "chain-edge" },
  prLocal: { synced: true, kind: "pref" },
  prEvents: { synced: false, kind: "pref" },
  syncBase: { synced: false, kind: "pref" },
  syncConflicts: { synced: false, kind: "pref" },
  drafts: { synced: false, kind: "pref" },
  intentions: { synced: false, kind: "pref" },
  prs: { synced: false, kind: "pref" },
  repos: { synced: false, kind: "pref" },
  summaries: { synced: false, kind: "pref" },
  ledger: { synced: false, kind: "pref" },
  diffs: { synced: false, kind: "pref" },
  settings: { synced: false, kind: "pref" },
} as const satisfies Record<string, { synced: boolean; kind: EntityKind }>;

export type CollectionName = keyof typeof COLLECTIONS;

export interface Collections {
  views: Record<string, RepositoryView>;
  timelines: Record<string, TimelineView>;
  releases: Record<string, Release>;
  pins: Record<string, ReleasePin>;
  cards: Record<string, FeatureCard>;
  placements: Record<string, CardPlacement>;
  notes: Record<string, PrivateNote>;
  reviews: Record<string, PRReviewProgress>;
  localEdges: Record<string, LocalEdge>;
  chains: Record<string, ChainRecord>;
  prLocal: Record<string, LocalPRAttrs>;
  prEvents: Record<string, PREvent[]>;
  /** last value agreed with the server for strict (3-way) entities, JSON */
  syncBase: Record<string, string>;
  syncConflicts: Record<string, SyncConflict>;
  drafts: Record<string, DraftComment>;
  intentions: Record<string, Intention>;
  prs: Record<string, PRSnapshot>;
  repos: Record<string, RepoInfo>;
  summaries: Record<string, SummaryRecord>;
  ledger: Record<string, LedgerEntry>;
  diffs: Record<string, DiffImportMeta>;
  settings: Record<string, Settings>;
}

export interface AppState extends Collections {
  loaded: boolean;
  online: boolean;
  rateLimit: { remaining: number; limit: number; resetAt: number } | null;
  toasts: { id: string; kind: "info" | "error" | "warn" | "success"; text: string }[];
  load(): Promise<void>;
  put<C extends CollectionName>(c: C, id: string, value: Collections[C][string]): void;
  patch<C extends CollectionName>(c: C, id: string, p: Partial<Collections[C][string]>): void;
  remove(c: CollectionName, id: string): void;
  putMany<C extends CollectionName>(c: C, entries: [string, Collections[C][string]][]): void;
  settings_(): Settings;
  setSettings(p: Partial<Settings>): void;
  toast(kind: AppState["toasts"][number]["kind"], text: string): void;
  dismiss(id: string): void;
}

const empty = (): Collections => ({
  views: {}, timelines: {}, releases: {}, pins: {}, cards: {}, placements: {}, notes: {}, reviews: {}, localEdges: {}, chains: {},
  prLocal: {}, prEvents: {}, syncBase: {}, syncConflicts: {}, drafts: {}, intentions: {}, prs: {}, repos: {}, summaries: {}, ledger: {}, diffs: {}, settings: {},
});

function recordOp(c: CollectionName, id: string, action: Op["action"], payload: unknown, deviceId: string) {
  const meta = COLLECTIONS[c];
  if (!meta.synced) return;
  const op: Op & { collection: string } = {
    opId: newId("op"),
    userId: "me",
    deviceId,
    entityKind: meta.kind,
    entityId: `${c}:${id}`,
    baseRevision: 0,
    timestamp: Date.now(),
    action,
    payload: (payload as Record<string, unknown>) ?? null,
    schemaVersion: 1,
    collection: c,
  };
  void outboxAdd(op);
}

export const useApp = create<AppState>((set, get) => ({
  ...empty(),
  loaded: false,
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  rateLimit: null,
  toasts: [],

  async load() {
    const recs = await loadAll();
    const c = empty();
    for (const r of recs) {
      const coll = (c as unknown as Record<string, Record<string, unknown>>)[r.collection];
      if (coll) coll[r.id] = r.value;
    }
    if (!c.settings.main) c.settings.main = DEFAULT_SETTINGS;
    else c.settings.main = { ...DEFAULT_SETTINGS, ...c.settings.main, keybindings: { ...DEFAULT_KEYS, ...c.settings.main.keybindings } };
    set({ ...c, loaded: true });
  },

  put(c, id, value) {
    set((s) => ({ [c]: { ...s[c], [id]: value } }) as Partial<AppState>);
    void putRecord(c, id, value);
    recordOp(c, id, "set", value, get().settings_().deviceId);
  },

  putMany(c, entries) {
    if (!entries.length) return;
    set((s) => ({ [c]: { ...s[c], ...Object.fromEntries(entries) } }) as Partial<AppState>);
    for (const [id, v] of entries) void putRecord(c, id, v);
  },

  patch(c, id, p) {
    const cur = (get()[c] as Record<string, object>)[id];
    if (!cur) return;
    const next = { ...cur, ...p };
    set((s) => ({ [c]: { ...s[c], [id]: next } }) as Partial<AppState>);
    void putRecord(c, id, next);
    recordOp(c, id, "patch", p, get().settings_().deviceId);
  },

  remove(c, id) {
    set((s) => {
      const copy = { ...(s[c] as Record<string, unknown>) };
      delete copy[id];
      return { [c]: copy } as Partial<AppState>;
    });
    void deleteRecord(c, id);
    recordOp(c, id, "delete", null, get().settings_().deviceId);
  },

  settings_() {
    return get().settings.main ?? DEFAULT_SETTINGS;
  },

  setSettings(p) {
    const next = { ...get().settings_(), ...p };
    get().put("settings", "main", next);
  },

  toast(kind, text) {
    const id = newId("t");
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }].slice(-5) }));
    setTimeout(() => get().dismiss(id), kind === "error" ? 9000 : 4500);
  },

  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

if (typeof window !== "undefined") {
  window.addEventListener("online", () => useApp.setState({ online: true }));
  window.addEventListener("offline", () => useApp.setState({ online: false }));
}

export const useSettings = () => useApp((s) => s.settings.main ?? DEFAULT_SETTINGS);

// E2E test hook (opt-in per browser profile): localStorage["nl:test"] = "1"
try {
  if (typeof window !== "undefined" && window.localStorage?.getItem("nl:test")) (window as unknown as { __nl: typeof useApp }).__nl = useApp;
} catch {
  /* storage blocked */
}
