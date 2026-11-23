import { createPortal } from "react-dom";
import { NavIcon } from "./NavIcon";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useApp, useSettings, type AIChat } from "../lib/store";
import { aiAllowedFor, askModel, ASK_SYSTEM, buildAskPrompt, estimate, model } from "../lib/ai";
import { renderMarkdown } from "../lib/markdown";
import { isDesktop, invoke } from "../lib/platform";
import { Modal, timeAgo } from "./ui";

export interface AskTarget {
  repoKey: string;
  prKey: string;
  prTitle: string;
  prUrl: string;
  path: string;
  /** label for the selection, e.g. "lines 120–134" */
  label: string;
  selected: string;
  context: string;
}

const SUGGESTIONS = ["What does this change do?", "Is there a bug or edge case here?", "How could this be simpler?", "What should I test?"];
const PR_SUGGESTIONS = ["Summarize the risky parts of this PR", "What should I review first?", "What tests are missing?", "Is anything here likely to break other code?"];

const NEW = "__new";

/** Conversations about this PR, most recent first. */
export function useChats(prKey: string): AIChat[] {
  return useApp(useShallow((s) => Object.values(s.aiChats).filter((c) => c.prKey === prKey).sort((a, b) => b.updatedAt - a.updatedAt)));
}

/**
 * Ask a model about specific diff lines or the whole PR. Shows the exact prompt and
 * estimated cost before sending. Conversations are saved per PR on this device and
 * can be reopened from the picker.
 */
export function AskAI({ chatId, target, docked, dock, onDock, onClose, onSwitch }: {
  chatId: string;
  target: AskTarget;
  docked: boolean;
  dock: HTMLElement | null;
  onDock: () => void;
  onClose: () => void;
  /** open another saved conversation, or (null) start a new one about the whole PR */
  onSwitch: (chat: AIChat | null) => void;
}) {
  const s = useSettings();
  const toast = useApp((x) => x.toast);
  const [question, setQuestion] = useState("");
  const [modelId, setModelId] = useState(s.defaultModel);
  const saved = useApp((x) => x.aiChats[chatId]);
  const history = saved?.turns ?? [];
  const chats = useChats(target.prKey);
  const wholePR = !target.path;
  const [pending, setPending] = useState("");
  const inFlight = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const busy = !!pending;
  useEffect(() => {
    const element = transcript.current;
    if (element) element.scrollTop = element.scrollHeight;
    if (docked && !busy) textarea.current?.focus();
  }, [docked, busy, history.length]);
  const [mcp, setMcp] = useState<{ command: string; args: string[] } | null>(null);
  const [sharing, setSharing] = useState(false);
  const share = async (enable: boolean) => {
    setSharing(true);
    try {
      const config = await invoke<{ command: string; args: string[] }>("review_mcp_share", { context: enable ? {
        ...target, changesUrl: target.prUrl + "/files", selected: target.selected.slice(0, 8000), context: target.context.slice(0, 12000),
      } : null });
      setMcp(enable ? config : null);
      toast("info", enable ? "Review selection shared with local MCP clients for 30 minutes." : "MCP sharing stopped.");
    } catch (error) {
      toast("error", String(error));
    } finally {
      setSharing(false);
    }
  };
  const allowed = aiAllowedFor(target.repoKey, target.path);
  const user = useMemo(() => buildAskPrompt({ prTitle: target.prTitle, prUrl: target.prUrl, path: target.path, selected: target.selected, context: target.context, question: question || "…", history }), [target, question, history]);
  const m = model(modelId);
  const est = m ? estimate(m, ASK_SYSTEM, user, 900) : null;
  const send = async (q = question) => {
    const text = q.trim();
    if (!text || !m || !allowed.ok || inFlight.current) return;
    inFlight.current = true;
    setError("");
    setPending(text);
    setQuestion("");
    onDock();
    try {
      const prompt = buildAskPrompt({ prTitle: target.prTitle, prUrl: target.prUrl, path: target.path, selected: target.selected, context: target.context, question: text, history });
      const res = await askModel({ modelId, system: ASK_SYSTEM, user: prompt, maxOut: 900, label: `${target.prKey}:${target.path}:ask` });
      const st = useApp.getState();
      const now = Date.now();
      const turn = { q: text, a: res.text, cost: res.costUsd, model: m.label, at: now };
      const cur = st.aiChats[chatId];
      st.put("aiChats", chatId, cur ? { ...cur, turns: [...cur.turns, turn], updatedAt: now }
        : { id: chatId, prKey: target.prKey, title: text.slice(0, 80), target, turns: [turn], createdAt: now, updatedAt: now });
    } catch (e) {
      setError((e as Error).message);
      setQuestion((current) => current || text);
    } finally {
      inFlight.current = false;
      setPending("");
    }
  };
  const title = wholePR ? <>Ask AI · whole PR</> : <>Ask AI · <span className="mono small">{target.path}</span> · {target.label}</>;
  const picker = (
    <div className="row ask-picker">
      <select className="input grow" aria-label="Conversation" value={chatId} onChange={(e) => {
        const v = e.target.value;
        onSwitch(v === NEW ? null : chats.find((c) => c.id === v) ?? null);
      }}>
        {!saved && <option value={chatId}>New conversation{wholePR ? " · whole PR" : ` · ${target.path.split("/").pop()} ${target.label}`}</option>}
        {chats.map((c) => (
          <option key={c.id} value={c.id}>{c.title} · {c.target.path ? `${c.target.path.split("/").pop()} ${c.target.label}` : "whole PR"} · {timeAgo(c.updatedAt)}</option>
        ))}
        <option value={NEW}>+ New conversation about the whole PR</option>
      </select>
      {saved && <button type="button" className="btn ghost sm" aria-label="Delete this conversation" title="Delete this conversation" onClick={() => {
        useApp.getState().remove("aiChats", chatId);
        onSwitch(chats.find((c) => c.id !== chatId) ?? null);
      }}><NavIcon name="trash" /></button>}
    </div>
  );
  const body = <div className="col ask-ai" data-keep-selection>
      <div ref={transcript} className="col ask-transcript" aria-live="polite">
        {!allowed.ok && <div className="banner warn">{allowed.reason}</div>}
        {isDesktop() && <div className="row">
          <button type="button" className="btn sm" disabled={sharing || !allowed.ok} onClick={() => void share(true)}>Share with MCP</button>
          <button type="button" className="btn ghost sm" disabled={sharing} onClick={() => void share(false)}>Stop MCP sharing</button>
        </div>}
        {mcp && <details className="small" open>
          <summary>MCP client configuration</summary>
          <pre className="mono small ask-selection">{JSON.stringify({ mcpServers: { nonlinear: mcp } }, null, 2)}</pre>
        </details>}
        {wholePR
          ? <div className="faint small">Asking about the whole PR: the model sees its changes (up to about 40,000 characters, without files excluded in Settings → AI).</div>
          : docked
            ? <details className="small"><summary>Selected diff</summary><pre className="mono small ask-selection">{target.selected.slice(0, 3000)}</pre></details>
            : <pre className="mono small ask-selection">{target.selected.slice(0, 3000)}</pre>}
        {history.map((h, i) => (
          <div key={i} className="col" style={{ gap: 4 }}>
            <div className="ask-q"><b>You:</b> {h.q}</div>
            <div className="md panel pad" dangerouslySetInnerHTML={{ __html: renderMarkdown(h.a) }} />
            <div className="faint small">{h.model} · ${h.cost.toFixed(4)} · AI output is untrusted and is not a review.</div>
          </div>
        ))}
        {pending && <div className="ask-q"><b>You:</b> {pending}<div className="faint small" role="status">Asking…</div></div>}
        {error && <div className="banner err" role="alert">{error}</div>}
        {!history.length && !pending && (!docked || wholePR) && (
          <div className="row" style={{ flexWrap: "wrap" }}>
            {(wholePR ? PR_SUGGESTIONS : SUGGESTIONS).map((q) => <button key={q} className="btn sm" disabled={busy || !allowed.ok} onClick={() => void send(q)}>{q}</button>)}
          </div>
        )}
      </div>
        <form className="col ask-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <textarea ref={textarea} className="input" autoFocus={!docked} aria-label={wholePR ? "Question about this PR" : "Question about the selected lines"} placeholder={history.length ? "Ask a follow-up…" : wholePR ? "Ask about this PR…" : "Ask about these lines…"} value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
          <div className="row">
            <select className="input" value={modelId} onChange={(e) => setModelId(e.target.value)} aria-label="Model">
              {s.models.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
            {est && <span className="faint small">~{est.inputTokens.toLocaleString()} input tokens · est. ${est.usd.toFixed(4)}</span>}
            <span className="spacer" />
            <button className="btn primary" disabled={busy || !question.trim() || !allowed.ok}>{busy ? "Asking…" : "Ask (⌘↵)"}</button>
          </div>
          <details className="small">
            <summary>Preview exact prompt</summary>
            <pre className="mono small" style={{ whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto" }}>{ASK_SYSTEM}{"\n\n"}{user}</pre>
          </details>
        </form>
      </div>;
  if (!docked) return <Modal title={title} onClose={onClose} wide>{body}</Modal>;
  return dock ? createPortal(
    <aside className="review-ask-sidebar" aria-label="Ask AI chat" data-keep-selection>
      <div className="toolbar small"><div className="grow ellipsis" title={target.path || "whole PR"}>{title}</div>
        <button type="button" className="btn ghost sm" aria-label="Close AI chat" onClick={onClose}><NavIcon name="close" /></button>
      </div>
      {picker}
      {body}
    </aside>, dock,
  ) : null;
}
