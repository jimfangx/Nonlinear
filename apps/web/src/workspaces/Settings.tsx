import { exportBackup, restoreBackup } from "../lib/backup";
import { useShallow } from "zustand/react/shallow";
import { useEffect, useRef, useState } from "react";
import { fnv1a, monthOf, newSalt, parsePRKey, revalidate, type Intention, type RepoAIPolicy } from "@nonlinear/core";
import { useApp, useSettings, DEFAULT_KEYS, DEFAULT_LSP } from "../lib/store";
import { getSecret, setSecret, putBlob, getBlob, deleteBlob, eraseEverything } from "../lib/db";
import { BACKGROUND_BLOB, COLOR_THEMES } from "../lib/theme";
import { githubApi, githubAvatarUrl, resetClient, describeError, freshCapabilities, enrichPR, updatePRFields, writeChainBlock, FALLBACK_TOKEN_SECRET, oauthRestrictedOrgs } from "../lib/github";
import { resolveConflict, syncOnce } from "../lib/sync";
import { cloudUrl, connect, currentState, disconnect, recoveryKey, requestPairing, resetEncryption, applyRecoveryKey, DEFAULT_CLOUD_URL, type CloudState } from "../lib/cloud";
import { PROVIDERS, aiPolicyActive } from "../lib/ai";
import { isDesktop, desktop } from "../lib/platform";
import { askConfirm, download, timeAgo, Modal } from "../components/ui";

export function SettingsPage() {
  useEffect(() => {
    if (location.hash.includes("#intentions")) document.getElementById("intentions")?.scrollIntoView();
  }, []);
  return (
    <div className="page settings-page">
      <div className="settings-content">
        <h1 className="h1">Settings</h1>
        <AppearanceSection />
        <CloudSection />
        <ConflictsSection />
        <GitHubSection />
        <IntentionsSection />
        <PolicySection />
        <AISection />
        <KeysSection />
        <ColumnsSection />
        <LanguageServersSection />
        <SSHSection />
        <DataSection />
      </div>
    </div>
  );
}

function Section({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="panel pad col" style={{ marginBottom: 16 }}>
      <h2 className="h2">{title}</h2>
      {children}
    </section>
  );
}

/* ---------------- Appearance ---------------- */

function AppearanceSection() {
  const s = useSettings();
  const set = useApp((x) => x.setSettings);
  const toast = useApp((x) => x.toast);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!s.backgroundImage) { setPreview(null); return; }
    void getBlob(BACKGROUND_BLOB).then((d) => { if (active) setPreview(d ?? null); });
    return () => { active = false; };
  }, [s.backgroundImage]);
  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return toast("error", "Choose an image file.");
    if (file.size > 12 * 1024 * 1024) return toast("error", "Images up to 12 MB are supported.");
    const reader = new FileReader();
    reader.onload = async () => {
      await putBlob(BACKGROUND_BLOB, String(reader.result));
      set({ backgroundImage: `${file.name}:${Date.now()}` });
    };
    reader.readAsDataURL(file);
  };
  return (
    <Section title="Appearance" id="appearance">
      <div className="row">
        <span style={{ width: 110 }}>Mode</span>
        {(["system", "light", "dark"] as const).map((t) => (
          <label key={t} className="row small"><input type="radio" name="theme-mode" checked={s.theme === t} onChange={() => set({ theme: t })} /> {t[0]!.toUpperCase() + t.slice(1)}</label>
        ))}
      </div>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <span style={{ width: 110, flex: "none" }}>Color theme</span>
        <div className="theme-swatches" role="group" aria-label="Color theme">
          {COLOR_THEMES.map((t) => (
            <button key={t.id} type="button" className="theme-swatch" aria-pressed={s.colorTheme === t.id} onClick={() => set({ colorTheme: t.id })}>
              <i style={{ background: `linear-gradient(135deg, ${t.light.accent} 50%, ${t.dark.accent} 50%)` }} /> {t.label}
            </button>
          ))}
          <button type="button" className="theme-swatch" aria-pressed={s.colorTheme === "custom"} onClick={() => set({ colorTheme: "custom" })}>
            <i style={{ background: `linear-gradient(135deg, ${s.customAccentLight} 50%, ${s.customAccentDark} 50%)` }} /> Custom
          </button>
        </div>
      </div>
      {s.colorTheme === "custom" && <div className="row" style={{ marginLeft: 110 }}>
        <label className="row small">Light accent <input type="color" value={s.customAccentLight} onChange={(event) => set({ customAccentLight: event.target.value })} /></label>
        <label className="row small">Dark accent <input type="color" value={s.customAccentDark} onChange={(event) => set({ customAccentDark: event.target.value })} /></label>
      </div>}
      <div className="row" style={{ alignItems: "flex-start" }}>
        <span style={{ width: 110, flex: "none" }}>Background</span>
        <div className="col" style={{ gap: 8 }}>
          <div className="row">
            {preview && <div className="bg-preview" style={{ backgroundImage: `url("${preview}")` }}><div className="app-background-mask" style={{ opacity: s.backgroundDim }} /></div>}
            <label className="btn sm">
              {preview ? "Change image…" : "Choose image…"}
              <input type="file" accept="image/*" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            {preview && <button className="btn sm" onClick={() => { void deleteBlob(BACKGROUND_BLOB); set({ backgroundImage: null }); }}>Remove</button>}
          </div>
          {preview && (
            <label className="row small">
              Darkness
              <input type="range" min={0} max={0.95} step={0.05} value={s.backgroundDim} onChange={(e) => set({ backgroundDim: Number(e.target.value) })} aria-label="Background darkness" />
              <span className="mono">{Math.round(s.backgroundDim * 100)}%</span>
            </label>
          )}
          <span className="faint small">Stored only on this device. A dark mask keeps text readable.</span>
        </div>
      </div>
    </Section>
  );
}

/* ---------------- GitHub auth (§8) ---------------- */

function GitHubSection() {
  const s = useSettings();
  const set = useApp((x) => x.setSettings);
  const toast = useApp((x) => x.toast);
  const [pat, setPat] = useState("");
  const [device, setDevice] = useState<{ user_code: string; verification_uri: string } | null>(null);
  const [clientId, setClientId] = useState("");

  const finish = async (token: string, mode: "pat" | "oauth", scopes: string | null) => {
    await setSecret("github-token", token);
    if (isDesktop()) await desktop.keychainSet("github-token", token).catch(() => undefined);
    set({ authMode: mode, me: null, githubAvatar: null, myTeams: [], tokenCanWrite: false });
    resetClient();
    try {
      const c = await githubApi();
      const me = await c.viewer();
      const teams = await c.viewerTeams();
      const canWrite = mode === "pat" ? true : !!scopes && /public_repo/.test(scopes) && !/(^|[ ,])repo([ ,]|$)/.test(scopes);
      if (scopes && /(^|[ ,])repo([ ,]|$)/.test(scopes)) toast("warn", "This token has classic `repo` scope (private access). Nonlinear never requests it; consider a narrower token.");
      set({ me: me.login, githubAvatar: { login: me.login, apiBase: s.apiBase, url: githubAvatarUrl(me.avatar_url), checkedAt: Date.now() }, myTeams: teams, tokenCanWrite: canWrite });
      toast("success", `Signed in as @${me.login}`);
    } catch (e) {
      toast("error", describeError(e));
    }
  };

  return (
    <Section title="GitHub access">
      <div className="small muted">
        No GitHub App is installed into any organization. Start read-only; grant <code>public_repo</code> only when you want Nonlinear to write PR metadata/reviews on public repos. Nonlinear never requests classic <code>repo</code> or <code>admin:org</code>.
        Note: <code>public_repo</code> covers all public repositories your account can access; Nonlinear's repository selection is an app-side safety boundary, not an OAuth limit. Organizations may still restrict OAuth apps.
      </div>
      <div className="row">
        <span>
          Current mode: <b>{s.authMode}</b> {s.me && <>as <b>@{s.me}</b></>} · writes {s.tokenCanWrite ? "permitted (per-repo permission rechecked before each write)" : "disabled"}
        </span>
        <span className="spacer" />
        <button
          className="btn sm"
          onClick={async () => {
            if (s.apiBase.trim().replace(/\/+$/, "").endsWith("/gh")) {
              await disconnect();
              toast("info", "Disconnected from Nonlinear Cloud and GitHub.");
              return;
            }
            await setSecret("github-token", null);
            set({ authMode: "anonymous", me: null, githubAvatar: null, myTeams: [], tokenCanWrite: false });
            resetClient();
            toast("info", "Disconnected. Revoke the token on GitHub if you no longer need it.");
          }}
        >
          Disconnect
        </button>
      </div>
      <div className="row">
        <label className="row">
          <input type="checkbox" checked={s.publicOnly} onChange={(e) => { set({ publicOnly: e.target.checked }); resetClient(); }} /> <b>Public-only mode</b>
        </label>
        <span className="faint small">Hides and rejects private repository metadata/content even if a token could access it.</span>
      </div>
      <div className="row">
        <label className="row" style={{ flex: "none", whiteSpace: "nowrap" }}>
          <input type="checkbox" checked={s.signalReviewStart} onChange={(e) => set({ signalReviewStart: e.target.checked })} /> <b>Show on GitHub when I start reviewing</b>
        </label>
        <span className="faint small">On your first review action in a PR (marking lines, a note, or a draft comment), Nonlinear requests a review from you so others see “Awaiting review from @you”. GitHub's pending reviews are private to you, so this is the only visible signal.</span>
      </div>
      <label className="row small">
        API base
        <input className="input grow mono" aria-label="GitHub API base" value={s.apiBase} onChange={(e) => { set({ apiBase: e.target.value }); resetClient(); }} onBlur={(e) => { set({ apiBase: e.target.value.trim().replace(/\/+$/, "") }); resetClient(); }} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
        <span className="faint">GitHub Enterprise: https://HOST/api/v3</span>
      </label>
      <div className="panel pad col">
        <b>Sign in with GitHub</b>
        <div className="faint small">Use <b>Connect</b> under Nonlinear Cloud above (recommended), a fine-grained token below{isDesktop() ? ", or the desktop device flow" : ""}.</div>
        {isDesktop() && (
          <div className="row">
            <input aria-label="OAuth App client ID" className="input" placeholder="OAuth App client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} />
            <button
              className="btn"
              disabled={!clientId}
              onClick={async () => {
                try {
                  const d = await desktop.deviceLogin(clientId);
                  setDevice(d);
                  const poll = async () => {
                    const r = await desktop.devicePoll(clientId, d.device_code);
                    if (r.access_token) {
                      setDevice(null);
                      void finish(r.access_token, "oauth", r.scope ?? "");
                    } else if (r.error === "authorization_pending" || r.error === "slow_down") setTimeout(poll, (d.interval + 1) * 1000);
                    else {
                      setDevice(null);
                      toast("error", r.error ?? "Device flow failed");
                    }
                  };
                  setTimeout(poll, d.interval * 1000);
                } catch (e) {
                  toast("error", String(e));
                }
              }}
            >
              Device flow (desktop)
            </button>
            {device && (
              <span>
                Enter <b className="mono">{device.user_code}</b> at{" "}
                <a href={device.verification_uri} target="_blank" rel="noreferrer">
                  {device.verification_uri}
                </a>
              </span>
            )}
          </div>
        )}
      </div>
      {s.authMode === "oauth" && <FallbackTokenPanel />}
      <div className="panel pad col">
        <b>Fine-grained personal access token (optional, stricter scoping)</b>
        <div className="faint small">
          Restrict to selected repositories with <code>Pull requests: write</code>, <code>Issues: write</code>, <code>Contents: read</code> (and <code>Contents: write</code> only for submodule gitlink updates). May require organization approval. Stored only on this device{isDesktop() ? " (OS keychain)" : " (browser-local)"}; never synced.
        </div>
        <div className="row">
          <input aria-label="Fine-grained personal access token" className="input grow mono" type="password" placeholder="github_pat_…" value={pat} onChange={(e) => setPat(e.target.value)} autoComplete="off" />
          <button className="btn primary" disabled={pat.trim().length < 8} onClick={() => { void finish(pat.trim(), "pat", null); setPat(""); }}>
            Save token
          </button>
        </div>
      </div>
    </Section>
  );
}

/* ---------------- Pending intentions (§9 offline) ---------------- */

function IntentionsSection() {
  const intentions = useApp(useShallow((s) => Object.values(s.intentions).filter((i) => i.status !== "sent" && i.status !== "discarded")));
  const put = useApp((s) => s.put);
  const toast = useApp((s) => s.toast);
  const online = useApp((s) => s.online);
  const check = async (i: Intention) => {
    try {
      const pr = await enrichPR(i.prKey);
      const r = parsePRKey(i.prKey)!;
      const { caps } = await freshCapabilities(`${r.owner}/${r.repo}`.toLowerCase());
      put("intentions", i.id, revalidate(i, { headSha: pr.headSha, bodyHash: pr.body != null ? fnv1a(pr.body) : null, state: pr.state, canWrite: caps.has(i.kind === "comment" || i.kind === "review" ? "can-review" : "can-edit-metadata") }));
    } catch (e) {
      toast("error", describeError(e));
    }
  };
  const send = async (i: Intention) => {
    try {
      const r = parsePRKey(i.prKey)!;
      const c = await githubApi();
      const p = i.payload as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (i.kind === "comment") await c.createIssueComment(r.owner, r.repo, r.number, p.body);
      else if (i.kind === "chain-block") {
        const res = await writeChainBlock(i.prKey, p.baseBody, p.content);
        if ("kind" in res && res.kind === "conflict") throw new Error(res.reason);
      } else if (i.kind === "update-body" || i.kind === "labels" || i.kind === "reviewers" || i.kind === "milestone") await updatePRFields(i.prKey, p);
      else if (i.kind === "review") throw new Error("Re-open the PR in Review and submit again; review anchors must be rechecked.");
      else if (i.kind === "lgtm") await c.submitReview(r.owner, r.repo, r.number, { commit_id: p.commit_id, event: "APPROVE", body: p.body || "LGTM" });
      else if (i.kind === "review-start") await c.requestReviewers(r.owner, r.repo, r.number, [p.login]);
      put("intentions", i.id, { ...i, status: "sent" });
      toast("success", "Sent");
    } catch (e) {
      put("intentions", i.id, { ...i, status: "failed", error: describeError(e) });
    }
  };
  return (
    <Section title={`Pending GitHub intentions (${intentions.length})`} id="intentions">
      <div className="small muted">Writes made while offline are queued here. They are never posted automatically: re-check the target, review any drift, then confirm.</div>
      {intentions.map((i) => (
        <div key={i.id} className="panel pad small col" style={{ gap: 4 }}>
          <div className="row">
            <b>{i.kind}</b> on {i.prKey} <span className="chip">{i.status}</span>
            <span className="faint">{timeAgo(i.createdAt)}</span>
            <span className="spacer" />
            <button className="btn sm" disabled={!online} onClick={() => void check(i)}>
              Re-check
            </button>
            <button className="btn sm primary" disabled={!online || i.status !== "needs-confirmation"} onClick={() => void send(i)}>
              Confirm & send
            </button>
            <button className="btn sm danger" onClick={() => put("intentions", i.id, { ...i, status: "discarded" })}>
              Discard
            </button>
          </div>
          <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(i.payload, null, 1).slice(0, 600)}</pre>
          {i.drift?.map((d, k) => (
            <div key={k} className="banner warn">
              {d}
            </div>
          ))}
          {i.error && <div className="banner err">{i.error}</div>}
        </div>
      ))}
    </Section>
  );
}

/* ---------------- Inbox policy ---------------- */

function PolicySection() {
  const s = useSettings();
  const set = useApp((x) => x.setSettings);
  const p = s.policy;
  return (
    <Section title="Inbox classification policy">
      <label className="row small">
        <input type="checkbox" checked={p.includeTeamRequests} onChange={(e) => set({ policy: { ...p, includeTeamRequests: e.target.checked } })} /> Team review requests count as “Needs my review” (teams: {s.myTeams.join(", ") || "none detected"})
      </label>
      <label className="row small">
        <input type="checkbox" checked={p.allowNoCI} onChange={(e) => set({ policy: { ...p, allowNoCI: e.target.checked } })} /> PRs with no CI can be “Ready to merge”
      </label>
      <label className="row small">
        Required approvals <input aria-label="Required approvals" className="input" type="number" min={0} max={10} value={p.requiredApprovals} onChange={(e) => set({ policy: { ...p, requiredApprovals: Number(e.target.value) } })} style={{ width: 70 }} />
      </label>
    </Section>
  );
}

/* ---------------- AI (§5.2, §11) ---------------- */

function AISection() {
  const s = useSettings();
  const set = useApp((x) => x.setSettings);
  const ledger = useApp(useShallow((x) => Object.values(x.ledger)));
  const views = useApp((x) => x.views);
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const [keyIn, setKeyIn] = useState<Record<string, string>>({});
  useEffect(() => {
    void Promise.all(PROVIDERS.map(async (p) => [p.id, !!(await getSecret(`ai-key:${p.id}`))] as const)).then((xs) => setKeys(Object.fromEntries(xs)));
  }, []);
  const month = monthOf(Date.now());
  const repos = [...new Set(Object.values(views).flatMap((v) => v.repos))].sort();
  const setPolicy = (repo: string, p: Partial<RepoAIPolicy>) => {
    const cur = s.aiPolicies.find((x) => x.repo === repo) ?? { repo, allowRemote: true, excludePatterns: [], requirePreview: true };
    set({ aiPolicies: [...s.aiPolicies.filter((x) => x.repo !== repo), { ...cur, ...p }] });
  };
  return (
    <Section title="AI summaries">
      <label className="row">
        <input type="checkbox" checked={s.aiEnabled} onChange={(e) => set({ aiEnabled: e.target.checked })} /> Enable AI features (off by default). When on, AI can be used on every repository; you see the exact prompt and its cost before anything is sent.
      </label>
      <h3 className="h3">Provider keys (stored locally, never synced)</h3>
      {PROVIDERS.map((p) => (
        <div key={p.id} className="row small">
          <span style={{ width: 220 }}>{p.label}</span>
          <span className={`chip ${keys[p.id] ? "ok" : ""}`}>{keys[p.id] ? "key set" : p.id === "ollama" || p.id === "claude-code" || p.id === "codex-cli" ? "no key needed" : "no key"}</span>
          {p.id !== "ollama" && p.id !== "claude-code" && p.id !== "codex-cli" && (
            <>
              <input aria-label={`${p.label} API key`} className="input grow" type="password" autoComplete="off" value={keyIn[p.id] ?? ""} onChange={(e) => setKeyIn({ ...keyIn, [p.id]: e.target.value })} />
              <button className="btn sm" onClick={async () => { await setSecret(`ai-key:${p.id}`, keyIn[p.id] || null); setKeys({ ...keys, [p.id]: !!keyIn[p.id] }); setKeyIn({ ...keyIn, [p.id]: "" }); }}>
                {keyIn[p.id] ? "Save" : "Clear"}
              </button>
            </>
          )}
        </div>
      ))}
      <div className="faint small">Claude Code and Codex CLI are optional local adapters (desktop only): they run your installed CLI non-interactively and are not billed to the app budget. Antigravity has no supported public API and is not offered.</div>
      <div className="row small">
        Default model
        <select aria-label="Default model" className="input" value={s.defaultModel} onChange={(e) => set({ defaultModel: e.target.value })}>
          {s.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.tier})
            </option>
          ))}
        </select>
        Escalation
        <select aria-label="Escalation model" className="input" value={s.escalationModel} onChange={(e) => set({ escalationModel: e.target.value })}>
          {s.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <details>
        <summary className="small">Model prices (USD / 1M tokens; refresh from provider before relying on them)</summary>
        <table className="grid small">
          <tbody>
            {s.models.map((m, i) => (
              <tr key={m.id}>
                <td>{m.label}</td>
                <td className="mono">{m.id}</td>
                <td>
                  in <input aria-label={`${m.label} input price per million tokens`} className="input" style={{ width: 70 }} type="number" step="0.01" value={m.inputPerM} onChange={(e) => set({ models: s.models.map((x, j) => (j === i ? { ...x, inputPerM: Number(e.target.value) } : x)) })} />
                </td>
                <td>
                  out <input aria-label={`${m.label} output price per million tokens`} className="input" style={{ width: 70 }} type="number" step="0.01" value={m.outputPerM} onChange={(e) => set({ models: s.models.map((x, j) => (j === i ? { ...x, outputPerM: Number(e.target.value) } : x)) })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <h3 className="h3">Monthly budgets ({month})</h3>
      {(["openai", "anthropic", "gemini", "openrouter"] as const).map((prov) => {
        const b = s.budgets[prov] ?? { monthlyUsd: 100, softWarnUsd: 70, hardStopUsd: 95 };
        const spent = ledger.filter((e) => e.provider === prov && e.month === month && e.status !== "released").reduce((n, e) => n + (e.actualUsd ?? e.estimatedUsd), 0);
        return (
          <div key={prov} className="row small">
            <span style={{ width: 90 }}>{prov}</span>
            <span className={`chip ${spent >= b.hardStopUsd ? "err" : spent >= b.softWarnUsd ? "warn" : "ok"}`}>${spent.toFixed(2)} spent</span>
            budget <input aria-label={`${prov} monthly budget USD`} className="input" style={{ width: 70 }} type="number" value={b.monthlyUsd} onChange={(e) => set({ budgets: { ...s.budgets, [prov]: { ...b, monthlyUsd: Number(e.target.value) } } })} />
            warn <input aria-label={`${prov} soft warning USD`} className="input" style={{ width: 70 }} type="number" value={b.softWarnUsd} onChange={(e) => set({ budgets: { ...s.budgets, [prov]: { ...b, softWarnUsd: Number(e.target.value) } } })} />
            stop <input aria-label={`${prov} hard stop USD`} className="input" style={{ width: 70 }} type="number" value={b.hardStopUsd} onChange={(e) => set({ budgets: { ...s.budgets, [prov]: { ...b, hardStopUsd: Number(e.target.value) } } })} />
          </div>
        );
      })}
      <h3 className="h3">Per-repository exclusions (optional)</h3>
      <div className="faint small">Tick a repository to keep matching files out of every AI prompt. Use <code>*</code> to turn AI off for that repository entirely.</div>
      {repos.map((r) => {
        const p = s.aiPolicies.find((x) => x.repo === r);
        const active = aiPolicyActive(p);
        return (
          <div key={r} className="row small">
            <label className="row" style={{ width: 300 }}>
              <input type="checkbox" checked={active} onChange={(e) => setPolicy(r, { restrict: e.target.checked })} aria-label={`Exclude files from AI in ${r}`} /> {r}
            </label>
            <input aria-label={`${r} AI exclude patterns`} className="input grow" disabled={!active} placeholder={active ? "e.g. *.secret, vendor/*, or * for the whole repository" : "Tick to exclude files"} value={p?.excludePatterns.join(", ") ?? ""} onChange={(e) => setPolicy(r, { excludePatterns: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
          </div>
        );
      })}
    </Section>
  );
}

/* ---------------- Nonlinear Cloud: one-click connect (§8, §10) ---------------- */

function CloudSection() {
  const s = useSettings();
  const set = useApp((x) => x.setSettings);
  const toast = useApp((x) => x.toast);
  const [state, setState] = useState<CloudState>({ kind: "disconnected" });
  const [busy, setBusy] = useState(false);
  const [writes, setWrites] = useState(true);
  const [rk, setRk] = useState("");
  const [shownRk, setShownRk] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ code: string; cancel: () => void } | null>(null);
  const [advanced, setAdvanced] = useState(!DEFAULT_CLOUD_URL);
  const url = cloudUrl();

  useEffect(() => {
    void currentState().then(setState);
  }, [s.syncEnabled, s.me]);
  useEffect(() => () => pairing?.cancel(), [pairing]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Nonlinear Cloud" id="cloud">
      <div className="small muted">
        Sign in with GitHub and sync your views, releases, pins, cards, notes and review progress across devices — end-to-end encrypted (the server stores only ciphertext). No GitHub App is installed in any organization; tokens, code, diffs and AI keys stay on your devices or encrypted server-side.
      </div>
      {state.kind === "disconnected" && (
        <div className="row">
          <button className="btn primary" disabled={busy || !url} onClick={() => run(async () => { const st = await connect(writes); if (st) setState(st); })}>
            Connect with GitHub
          </button>
          <label className="row small">
            <input type="checkbox" checked={writes} onChange={(e) => setWrites(e.target.checked)} /> also allow writes to public repos (<code>public_repo</code>)
          </label>
          {!url && <span className="faint small">No cloud service configured for this build — set one under Advanced.</span>}
        </div>
      )}
      {state.kind === "connected" && (
        <div className="col">
          <div className="row">
            <span className="chip ok">● Connected as @{state.login}</span>
            <span className="small faint">{s.lastSyncAt ? `last sync ${timeAgo(s.lastSyncAt)}` : "first sync pending"}</span>
            {s.lastSyncError && <span className="chip err">{s.lastSyncError}</span>}
            <span className="spacer" />
            <button className="btn sm" onClick={() => run(async () => { const r = await syncOnce(); set({ lastSyncAt: Date.now(), lastSyncError: null }); toast("success", `Pushed ${r.pushed}, pulled ${r.pulled}`); })}>
              Sync now
            </button>
            <button className="btn sm" onClick={() => run(async () => setShownRk(await recoveryKey()))}>
              Show recovery key
            </button>
            <button className="btn sm danger" onClick={async () => { if (!s.recoveryKeySavedAt && !(await askConfirm({ title: "Disconnect without a saved recovery key?", body: "Disconnecting removes this device's encryption key. You haven't confirmed saving your recovery key, so if no other device is connected you won't be able to read your synced data again.", confirmLabel: "Disconnect anyway", danger: true }))) return; void run(async () => { await disconnect(); setState({ kind: "disconnected" }); toast("info", "Disconnected from Nonlinear Cloud. Local data is kept."); }); }}>
              Disconnect
            </button>
          </div>
          <div className="faint small">To add another device, open Nonlinear there and click Connect; approve it here when asked.</div>
        </div>
      )}
      {state.kind === "needs-key" && (
        <div className="col">
          <div className="banner info">
            Signed in as @{state.login}. This account already has encrypted data from another device. Approve this device from one that's connected, or enter your recovery key.
          </div>
          {pairing ? (
            <div className="row">
              <span>
                Waiting for approval… Confirm the other device shows code <b className="mono" style={{ fontSize: 16 }}>{pairing.code}</b>.
              </span>
              <button className="btn sm" onClick={() => { pairing.cancel(); setPairing(null); }}>
                Cancel
              </button>
            </div>
          ) : (
            <button className="btn primary" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => run(async () => setPairing(await requestPairing(() => { setPairing(null); setState({ kind: "connected", login: state.login }); toast("success", "Device paired. Syncing…"); })))}>
              Approve from another device
            </button>
          )}
          <div className="row">
            <input aria-label="Recovery key" className="input grow mono" placeholder="NL1-…" value={rk} onChange={(e) => setRk(e.target.value)} autoComplete="off" />
            <button className="btn" disabled={!rk || busy} onClick={() => run(async () => { if (await applyRecoveryKey(rk)) { setRk(""); setState({ kind: "connected", login: state.login }); toast("success", "Recovery key accepted"); } else toast("error", "That recovery key doesn't match this account."); })}>
              Use recovery key
            </button>
          </div>
          <details>
            <summary className="small faint">Lost all devices and the recovery key?</summary>
            <button className="btn sm danger" onClick={async () => { if (await askConfirm({ title: "Reset cloud encryption?", body: "Nonlinear creates a new encryption key and deletes the cloud copy encrypted with the old key. Everything on this device is then re-encrypted with the new key and uploaded, and you'll get a new recovery key to save.", confirmLabel: "Reset and re-upload", danger: true })) void run(async () => { const { uploaded } = await resetEncryption(); setState({ kind: "connected", login: state.login }); toast("success", `New encryption key created. Uploaded ${uploaded} item${uploaded === 1 ? "" : "s"} from this device.`); }); }}>
              Reset cloud encryption
            </button>
          </details>
        </div>
      )}
      {shownRk && (
        <div className="banner warn col" style={{ gap: 6 }}>
          <div>Recovery key — store it in your password manager. Anyone with it and your GitHub login can read your synced data.</div>
          <code className="mono" style={{ userSelect: "all", fontSize: 13 }}>{shownRk}</code>
          <div className="row">
            <button className="btn sm" onClick={() => void navigator.clipboard.writeText(shownRk).then(() => toast("info", "Copied"))}>Copy</button>
            <button className="btn sm" onClick={() => download("nonlinear-recovery-key.txt", shownRk + "\n")}>Download</button>
            <button className="btn sm" onClick={() => setShownRk(null)}>Hide</button>
          </div>
        </div>
      )}
      <details open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
        <summary className="small faint">Advanced: self-hosted service</summary>
        <div className="row small" style={{ marginTop: 6 }}>
          Service URL
          <input aria-label="Self-hosted service URL" className="input grow mono" placeholder={DEFAULT_CLOUD_URL || "https://nonlinear-sync.example.workers.dev"} value={s.syncUrl} onChange={(e) => set({ syncUrl: e.target.value })} onBlur={(e) => set({ syncUrl: e.target.value.trim().replace(/\/+$/, "") })} disabled={state.kind !== "disconnected"} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
        </div>
        <div className="faint small">Deploy your own copy from <code>services/sync</code> (Cloudflare Workers + D1). Leave empty to use this build's default.</div>
      </details>
    </Section>
  );
}

/* ---------------- Sync conflicts (§10: never silent LWW for pins/chains) ---------------- */

function describeEntity(coll: string, v: unknown, releases: Record<string, { name: string }>): string {
  if (v === null || v === undefined) return "(deleted)";
  const o = v as Record<string, unknown>;
  if (coll === "pins") return `${releases[o.releaseId as string]?.name ?? o.releaseId}: ${(o.pathChain as string[]).join("/")} → ${(o.sha as string).slice(0, 10)}`;
  if (coll === "localEdges") return `${o.from} → ${o.to}${o.removed ? " (removed)" : ""}`;
  if (coll === "chains") return `chain ${(o.members as string[]).join(" → ")}`;
  return JSON.stringify(v).slice(0, 200);
}

function ConflictsSection() {
  const conflicts = useApp(useShallow((x) => Object.values(x.syncConflicts)));
  const releases = useApp((x) => x.releases);
  const toast = useApp((x) => x.toast);
  if (!conflicts.length) return null;
  return (
    <Section title={`Sync conflicts (${conflicts.length})`} id="conflicts">
      <div className="small muted">Another device changed the same release pin or chain while this device had unsynced edits. Nothing was overwritten; choose which version to keep.</div>
      {conflicts.map((c) => (
        <div key={c.key} className="panel pad small col" style={{ gap: 4 }}>
          <div className="faint">
            {c.collection} · from device {c.remoteDevice.slice(0, 10)}
          </div>
          <table className="grid">
            <tbody>
              <tr><th style={{ width: 90 }}>Base</th><td className="mono">{describeEntity(c.collection, c.base, releases)}</td></tr>
              <tr><th>This device</th><td className="mono">{describeEntity(c.collection, c.local, releases)}</td></tr>
              <tr><th>Other device</th><td className="mono">{describeEntity(c.collection, c.remote, releases)}</td></tr>
            </tbody>
          </table>
          <div className="row">
            <button className="btn sm primary" onClick={() => void resolveConflict(c.key, "mine").then(() => toast("info", "Kept this device's version; it will sync to others."))}>
              Keep mine
            </button>
            <button className="btn sm" onClick={() => void resolveConflict(c.key, "theirs").then(() => toast("info", "Adopted the other device's version."))}>
              Take theirs
            </button>
          </div>
        </div>
      ))}
    </Section>
  );
}

/* ---------------- Keybindings ---------------- */

function KeysSection() {
  const s = useSettings();
  const set = useApp((x) => x.setSettings);
  return (
    <Section title="Keyboard shortcuts">
      <div className="row" style={{ flexWrap: "wrap" }}>
        {Object.keys(DEFAULT_KEYS).map((a) => (
          <label key={a} className="row small" style={{ width: 220 }}>
            <span style={{ width: 110 }}>{a}</span>
            <input aria-label={`Shortcut for ${a}`} className="input mono" style={{ width: 90 }} value={s.keybindings[a] ?? ""} onChange={(e) => set({ keybindings: { ...s.keybindings, [a]: e.target.value } })} />
          </label>
        ))}
      </div>
      <button className="btn sm" onClick={() => set({ keybindings: DEFAULT_KEYS })}>
        Reset defaults
      </button>
    </Section>
  );
}

function ColumnsSection() {
  const s = useSettings();
  const set = useApp((x) => x.setSettings);
  const [name, setName] = useState("");
  return (
    <Section title="Board columns">
      <div className="row" style={{ flexWrap: "wrap" }}>
        {s.columns.map((c, i) => (
          <span key={c.id} className="chip">
            <input aria-label={`Column name ${c.name}`} className="input" style={{ height: 20, width: 130 }} value={c.name} onChange={(e) => set({ columns: s.columns.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
            <button className="btn ghost sm" disabled={i === 0} onClick={() => { const cs = [...s.columns]; [cs[i - 1], cs[i]] = [cs[i]!, cs[i - 1]!]; set({ columns: cs }); }}>
              ←
            </button>
            <button className="btn ghost sm" onClick={() => s.columns.length > 1 && set({ columns: s.columns.filter((_, j) => j !== i) })}>
              ✕
            </button>
          </span>
        ))}
        <input aria-label="New column name" className="input" placeholder="New column" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { set({ columns: [...s.columns, { id: name.toLowerCase().replace(/\W+/g, "-"), name }] }); setName(""); } }} />
      </div>
    </Section>
  );
}

function LanguageServersSection() {
  const s = useSettings();
  const set = useApp((x) => x.setSettings);
  const views = useApp((x) => x.views);
  const repos = [...new Set(Object.values(views).flatMap((v) => v.repos))].sort();
  const upd = (i: number, p: Partial<(typeof s.lspServers)[number]>) => set({ lspServers: s.lspServers.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  return (
    <Section title="Language servers (desktop)">
      <div className="small muted">
        Any LSP server can back go-to-definition, references and confirmed impact analysis — one per language, matched by file extension. Servers run locally against the mapped working tree, with no shell. Without a server, Nonlinear falls back to tree-sitter, then heuristics, and labels which engine was used.
      </div>
      <table className="grid small">
        <thead>
          <tr><th>On</th><th>Name</th><th>Extensions</th><th>Command</th><th>Args</th><th /></tr>
        </thead>
        <tbody>
          {s.lspServers.map((l, i) => (
            <tr key={i}>
              <td><input type="checkbox" checked={l.enabled} onChange={(e) => upd(i, { enabled: e.target.checked })} aria-label={`Enable ${l.name}`} /></td>
              <td><input aria-label={`Server ${i + 1} name`} className="input" value={l.name} onChange={(e) => upd(i, { name: e.target.value })} /></td>
              <td><input aria-label={`${l.name} file extensions`} className="input mono" style={{ width: 150 }} value={l.extensions.join(" ")} onChange={(e) => upd(i, { extensions: e.target.value.split(/[\s,]+/).filter(Boolean).map((x) => x.replace(/^\./, "").toLowerCase()) })} /></td>
              <td><input aria-label={`${l.name} command`} className="input mono" value={l.command} onChange={(e) => upd(i, { command: e.target.value.trim() })} /></td>
              <td><input aria-label={`${l.name} arguments`} className="input mono" value={l.args.join(" ")} onChange={(e) => upd(i, { args: e.target.value.split(" ").filter(Boolean) })} /></td>
              <td><button className="btn ghost sm" onClick={() => set({ lspServers: s.lspServers.filter((_, j) => j !== i) })} aria-label="Remove">✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button className="btn sm" onClick={() => set({ lspServers: [...s.lspServers, { name: "New server", extensions: [], languageId: "plaintext", command: "", args: [], enabled: true }] })}>+ Add server</button>
        <button className="btn sm" onClick={() => set({ lspServers: DEFAULT_LSP })}>Reset defaults</button>
      </div>
      <h3 className="h3">Local working trees</h3>
      {repos.map((r) => (
        <label key={r} className="row small">
          <span style={{ width: 260 }} className="mono">{r}</span>
          <input aria-label={`Local working tree for ${r}`} className="input grow mono" placeholder="/path/to/repository" value={s.localRepos[r] ?? ""} disabled={!isDesktop()} onChange={(e) => set({ localRepos: { ...s.localRepos, [r]: e.target.value } })} />
        </label>
      ))}
      {!isDesktop() && <div className="faint small">Language servers and local working trees require the desktop app.</div>}
    </Section>
  );
}

function SSHSection() {
  const s = useSettings();
  const set = useApp((x) => x.setSettings);
  const [alias, setAlias] = useState("");
  const [root, setRoot] = useState("");
  return (
    <Section title="Remote compute (SSH, desktop only)">
      <div className="small muted">Register an SSH alias from your ~/.ssh/config and a working-tree root. Nonlinear runs a versioned unprivileged helper over SSH (no sudo), sends only the paths/revisions you select, and applies time/output limits. Imported JSON or PR text can never trigger remote commands.</div>
      {s.sshHosts.map((h, i) => (
        <div key={i} className="row small">
          <b className="mono">{h.alias}</b>
          <span className="mono faint grow">{h.root}</span>
          <label className="row">
            <input type="checkbox" checked={h.allowed} onChange={(e) => set({ sshHosts: s.sshHosts.map((x, j) => (j === i ? { ...x, allowed: e.target.checked } : x)) })} /> execution permitted
          </label>
          <button className="btn ghost sm" onClick={() => set({ sshHosts: s.sshHosts.filter((_, j) => j !== i) })}>
            ✕
          </button>
        </div>
      ))}
      <div className="row">
        <input aria-label="SSH alias" className="input" placeholder="ssh alias" value={alias} onChange={(e) => setAlias(e.target.value)} disabled={!isDesktop()} />
        <input aria-label="Remote working tree root" className="input grow" placeholder="/path/to/repository" value={root} onChange={(e) => setRoot(e.target.value)} disabled={!isDesktop()} />
        <button className="btn" disabled={!isDesktop() || !/^[A-Za-z0-9_.-]+$/.test(alias) || !root.startsWith("/")} onClick={() => { set({ sshHosts: [...s.sshHosts, { alias, root, allowed: false }] }); setAlias(""); setRoot(""); }}>
          Pair host
        </button>
      </div>
      {!isDesktop() && <div className="faint small">Unavailable in the web app: browsers cannot run SSH. Use the desktop app.</div>}
    </Section>
  );
}

function DataSection() {
  const toast = useApp((x) => x.toast);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [erasing, setErasing] = useState(false);
  const restore = async (file: File) => {
    setBusy(true);
    try {
      const { restored, skipped } = await restoreBackup(await file.text());
      toast("success", `Restored ${restored} records${skipped ? `; ${skipped} diff imports lacked patch data` : ""}.`);
    } catch (error) {
      toast("error", error instanceof Error ? error.message : "Unable to restore the export.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Local data">
      <div className="row">
        <button className="btn" disabled={busy} onClick={() => void exportBackup()
          .then((json) => download("nonlinear-export.json", json, "application/json"))
          .catch((error) => toast("error", String(error)))}>
          Export my data (JSON)
        </button>
        <button className="btn" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Restoring…" : "Import my data (JSON)"}</button>
        <input ref={input} aria-label="Choose Nonlinear data export" type="file" accept=".json,application/json" hidden onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void restore(file);
        }} />
        <button className="btn danger" onClick={() => setErasing(true)}>Delete local data…</button>
      </div>
      {erasing && <EraseDialog onClose={() => setErasing(false)} />}
    </Section>
  );
}

/** Personal access token used only where an organization blocks the OAuth app. */
function FallbackTokenPanel() {
  const s = useSettings();
  const toast = useApp((x) => x.toast);
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void getSecret(FALLBACK_TOKEN_SECRET).then((t) => setSaved(!!t)); }, []);
  const save = async () => {
    const token = value.trim();
    setBusy(true);
    try {
      // Check the token against GitHub directly, and that it belongs to the signed-in account.
      const r = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
      if (!r.ok) throw new Error(r.status === 401 ? "GitHub rejected this token." : `GitHub returned ${r.status}.`);
      const me = (await r.json()) as { login: string };
      if (s.me && me.login.toLowerCase() !== s.me.toLowerCase()) throw new Error(`This token belongs to @${me.login}, but you're signed in as @${s.me}. Use a token from the same account.`);
      await setSecret(FALLBACK_TOKEN_SECRET, token);
      resetClient();
      setSaved(true);
      setValue("");
      toast("success", `Fallback token saved for @${me.login}.`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    await setSecret(FALLBACK_TOKEN_SECRET, null);
    oauthRestrictedOrgs.clear();
    resetClient();
    setSaved(false);
    toast("info", "Fallback token removed.");
  };
  const used = [...oauthRestrictedOrgs];
  return (
    <div className="panel pad col">
      <b>Fallback token for organizations that block the OAuth app</b>
      <div className="faint small">
        Some organizations only allow OAuth apps an owner has approved, so comments and reviews there fail even though your account has access. If you add a personal access token from the same account, Nonlinear uses it for just those organizations and keeps using the OAuth sign-in everywhere else.
        A classic token with <code>public_repo</code> works in most organizations; a fine-grained token may need the organization's approval too. Stored only on this device{isDesktop() ? " (OS keychain)" : " (browser-local)"}; never synced or sent to the sync server.
      </div>
      {saved ? (
        <div className="row">
          <span className="chip ok">Saved</span>
          <span className="faint small">{used.length ? `Used this session for: ${used.join(", ")}` : "Not needed yet this session."}</span>
          <span className="spacer" />
          <button className="btn sm" onClick={() => void remove()}>Remove</button>
        </div>
      ) : (
        <div className="row">
          <input aria-label="Fallback personal access token" className="input grow mono" type="password" placeholder="ghp_… or github_pat_…" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
          <button className="btn" disabled={busy || value.trim().length < 8} onClick={() => void save()}>{busy ? "Checking…" : "Save fallback token"}</button>
        </div>
      )}
    </div>
  );
}

/** Secret names this app stores (keychain on desktop, IndexedDB on web). */
function secretKeyNames(): string[] {
  return ["github-token", "github-pat-fallback", "sync-key", "sync-session", "sync-cursor", "nonlinear-selftest", ...PROVIDERS.map((p) => `ai-key:${p.id}`)];
}

function EraseDialog({ onClose }: { onClose: () => void }) {
  const [secrets, setSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useApp((x) => x.toast);
  const localRepos = useSettings().localRepos;
  const desktopApp = isDesktop();
  const erase = async () => {
    setBusy(true);
    try {
      const report = await eraseEverything({ secretKeys: secrets ? secretKeyNames() : [], localRepos: Object.values(localRepos) });
      const freed = report.bytes > 0 ? ` · ${(report.bytes / 1024 / 1024).toFixed(1)} MB freed` : "";
      toast(report.errors.length ? "warn" : "info", report.errors.length ? `Erased, with ${report.errors.length} problem(s): ${report.errors[0]}` : `Everything erased${freed}. Reloading…`);
      setTimeout(() => location.reload(), report.errors.length ? 2500 : 700);
    } catch (error) {
      toast("error", String(error));
      setBusy(false);
    }
  };
  return (
    <Modal title="Delete all local data" onClose={busy ? () => undefined : onClose}
      footer={<>
        <span className="spacer" />
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn danger" onClick={() => void erase()} disabled={busy}>{busy ? "Erasing…" : "Erase everything"}</button>
      </>}>
      <div className="col">
        <p style={{ margin: 0 }}>This removes everything Nonlinear keeps on this {desktopApp ? "Mac" : "browser"}:</p>
        <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
          <li>Views, releases, pins, cards, review progress, private notes, drafts and settings</li>
          <li>Cached pull requests, imported diffs, staged safe-mode changes and queued writes</li>
          <li>Saved release notes and other small preferences kept in browser storage</li>
          {desktopApp && <li>The database file (shrunk on disk), repository mirrors, checkouts made for review, timeline caches and the app's web cache</li>}
          {desktopApp && <li>Leftover data from older builds of the app</li>}
        </ul>
        <label className="row" style={{ alignItems: "flex-start" }}>
          <input type="checkbox" checked={secrets} onChange={(e) => setSecrets(e.target.checked)} style={{ marginTop: 3 }} />
          <span>Also remove saved sign-in tokens and AI API keys {desktopApp ? "from the macOS Keychain" : ""}<br />
            <span className="faint small">You'll need to sign in to GitHub and Nonlinear Cloud again.</span></span>
        </label>
        <div className="faint small">
          Your own working trees are never touched. Data already synced to Nonlinear Cloud stays there{secrets ? "" : ", and this device downloads it again while it stays connected"}. This can't be undone; export your data first if you might want it back.
        </div>
      </div>
    </Modal>
  );
}
