import { getBlob, loadAll, restoreRecords, type StoredRecord } from "./db";
import { exportDiffChunks, loadIndex, restoreDiffChunks } from "./importStore";
import { COLLECTIONS, useApp } from "./store";
import { BACKGROUND_BLOB } from "./theme";

const excluded = new Set(["prs", "repos", "summaries", "syncBase", "syncConflicts"]);
const safeKey = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length < 512 && !["__proto__", "constructor", "prototype"].includes(value) && !value.includes("\0");

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function exportBackup(): Promise<string> {
  const records = (await loadAll()).filter((record) => !excluded.has(record.collection));
  const [background, diffChunks] = await Promise.all([
    getBlob(BACKGROUND_BLOB),
    exportDiffChunks(records.filter((record) => record.collection === "diffs").map((record) => record.id)),
  ]);
  return JSON.stringify({ version: 1, records, background, diffChunks }, null, 1);
}

export async function restoreBackup(text: string): Promise<{ restored: number; skipped: number }> {
  const data: unknown = JSON.parse(text);
  const modern = object(data) && data.version === 1 ? data : null;
  const entries = modern?.records ?? data;
  if (!Array.isArray(entries)) throw new Error("Choose a Nonlinear data export.");
  const records: StoredRecord[] = [];
  const seen = new Set<string>();
  const current = useApp.getState().settings_();
  for (const entry of entries) {
    if (!object(entry) || !safeKey(entry.collection) || !safeKey(entry.id) || !Object.hasOwn(COLLECTIONS, entry.collection)) throw new Error("The export contains an invalid record.");
    if (excluded.has(entry.collection)) continue;
    const { collection, id } = entry;
    if ((!object(entry.value) && !Array.isArray(entry.value)) || !Number.isSafeInteger(entry.updatedAt)) throw new Error(`Invalid record in ${collection}.`);
    const key = `${collection}:${id}`;
    if (seen.has(key)) throw new Error("The export contains duplicate records.");
    seen.add(key);
    let value: unknown = entry.value;
    if (collection === "settings") {
      if (id !== "main" || !object(value)) throw new Error("Invalid settings in export.");
      const settings = Object.fromEntries(Object.entries(value).filter(([field, val]) =>
        Object.hasOwn(current, field) && (current[field as keyof typeof current] == null || typeof val === typeof current[field as keyof typeof current])));
      value = { ...current, ...settings, deviceId: current.deviceId, me: current.me, githubAvatar: current.githubAvatar, myTeams: current.myTeams,
        authMode: current.authMode, apiBase: current.apiBase, publicOnly: current.publicOnly, tokenCanWrite: current.tokenCanWrite,
        syncUrl: current.syncUrl, syncEnabled: current.syncEnabled, lastSyncAt: current.lastSyncAt, lastSyncError: current.lastSyncError,
        lspServers: current.lspServers, sshHosts: current.sshHosts, localRepos: current.localRepos,
        backgroundImage: modern?.background && typeof settings.backgroundImage === "string" ? settings.backgroundImage : current.backgroundImage,
      };
    }
    records.push({ collection, id, value, updatedAt: entry.updatedAt as number });
  }

  const diffIds = new Set(records.filter((record) => record.collection === "diffs").map((record) => record.id));
  const chunks: [string, string][] = [];
  const indexes = new Set<string>();
  if (modern && !Array.isArray(modern.diffChunks)) throw new Error("Invalid diff archive.");
  for (const pair of (modern?.diffChunks ?? []) as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") throw new Error("Invalid diff archive.");
    const [key, value] = pair as [string, string];
    const match = /^(index|file):(diff_[a-z0-9]+)(?:\|[^\0]*\|\d+)?$/.exec(key);
    if (!match || !diffIds.has(match[2]!)) throw new Error("Invalid diff archive key.");
    if (match[1] === "index") {
      const index: unknown = JSON.parse(value);
      if (!object(index) || index.id !== match[2] || !Array.isArray(index.groups) || !object(index.totals)) throw new Error("Invalid diff index.");
      indexes.add(match[2]!);
    }
    chunks.push([key, value]);
  }
  const background = modern?.background;
  if (background !== undefined && (typeof background !== "string" || !/^data:image\/[a-z+.-]+;base64,[a-z0-9+/=]+$/i.test(background))) throw new Error("Invalid background image.");
  const available = new Set([...indexes, ...(await Promise.all([...diffIds].map(async (id) => (await loadIndex(id)) ? id : "")))]);
  const restore = records.filter((record) => record.collection !== "diffs" || available.has(record.id));
  await restoreDiffChunks(chunks);
  await restoreRecords(restore, typeof background === "string" ? [[BACKGROUND_BLOB, background]] : []);
  await useApp.getState().load();
  return { restored: restore.length, skipped: records.length - restore.length };
}
