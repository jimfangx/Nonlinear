import { NavIcon } from "./NavIcon";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useApp, useSettings, type StagedWrite } from "../lib/store";
import { describeError, sendStaged, WriteBlocked } from "../lib/github";
import { discardStaged, hasRunner } from "../lib/safemode";
import { Modal, timeAgo } from "./ui";

/** Top-bar toggle. Turning safe mode off with staged changes opens the review first. */
export function SafeModeControl() {
  const s = useSettings();
  const setSettings = useApp((x) => x.setSettings);
  const staged = useApp(useShallow((x) => Object.values(x.staged).sort((a, b) => a.createdAt - b.createdAt)));
  const [reviewing, setReviewing] = useState(false);
  const toggle = () => {
    if (!s.safeMode) {
      setSettings({ safeMode: true });
      useApp.getState().toast("info", "Safe mode on: nothing will be written to GitHub. Changes are staged for your review.");
    } else if (staged.length) setReviewing(true);
    else setSettings({ safeMode: false });
  };
  return (
    <>
      <button
        type="button"
        className={`chip safe-mode ${s.safeMode ? "warn on" : ""}`}
        aria-pressed={s.safeMode}
        onClick={toggle}
        title={s.safeMode ? "Safe mode is on: GitHub writes are staged locally. Click to review and leave safe mode." : "Turn on safe mode: hold every GitHub write for review"}
      >
        <NavIcon name="shield" /> {s.safeMode ? "Safe mode" : "Safe mode off"}
        {staged.length > 0 && <span className="safe-count">{staged.length}</span>}
      </button>
      {!s.safeMode && staged.length > 0 && !reviewing && (
        <button type="button" className="chip warn" onClick={() => setReviewing(true)} title="Changes staged in safe mode are waiting for review">
          {staged.length} staged
        </button>
      )}
      <StagedReview open={reviewing} items={staged} onClose={() => setReviewing(false)} onDone={() => { setSettings({ safeMode: false }); setReviewing(false); }} />
    </>
  );
}

function StagedReview({ open, items, onClose, onDone }: { open: boolean; items: StagedWrite[]; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const online = useApp((x) => x.online);
  const toast = useApp((x) => x.toast);
  const send = async (item: StagedWrite) => {
    setBusy(item.id);
    try {
      await sendStaged(item);
      setErrors(({ [item.id]: _, ...rest }) => rest);
      return true;
    } catch (e) {
      setErrors((x) => ({ ...x, [item.id]: e instanceof WriteBlocked ? e.message : describeError(e) }));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const sendAll = async () => {
    let ok = 0;
    for (const item of items) if (await send(item)) ok++;
    if (ok) toast("success", `Sent ${ok} change${ok > 1 ? "s" : ""} to GitHub`);
  };
  return (
    <Modal
      open={open}
      wide
      title={`Review ${items.length} staged GitHub change${items.length === 1 ? "" : "s"}`}
      onClose={onClose}
      footer={
        <>
          <span className="faint small grow">{items.length ? "Nothing is sent until you choose Send." : "All staged changes are resolved."}</span>
          <button className="btn" onClick={onClose}>Stay in safe mode</button>
          {items.length > 0 && <button className="btn danger" disabled={!!busy} onClick={() => items.forEach((i) => discardStaged(i.id))}>Discard all</button>}
          {items.length > 0
            ? <button className="btn primary" disabled={!!busy || !online} onClick={() => void sendAll()}>Send all to GitHub</button>
            : <button className="btn primary" onClick={onDone}>Leave safe mode</button>}
        </>
      }
    >
      <div className="col">
        {!online && <div className="banner warn">You're offline. Staged changes can be sent once you reconnect.</div>}
        {items.map((item, n) => (
          <div key={item.id} className="panel pad col staged-item" style={{ gap: 6 }}>
            <div className="row">
              <span className="faint small">{n + 1}.</span>
              <b className="grow">{item.title}</b>
              <span className="faint small">{timeAgo(item.createdAt)}</span>
            </div>
            {item.preview && <pre className="mono small staged-preview">{item.preview.slice(0, 4000)}</pre>}
            {!hasRunner(item.id) && <div className="faint small">Staged before the app was reloaded; it will be replayed from the saved request.</div>}
            {errors[item.id] && <div className="banner err small">{errors[item.id]}</div>}
            <div className="row">
              {item.url && <a className="small" href={item.url} target="_blank" rel="noreferrer">Open on GitHub ↗</a>}
              <span className="spacer" />
              <button className="btn sm danger" disabled={busy === item.id} onClick={() => discardStaged(item.id)}>Discard</button>
              <button className="btn sm primary" disabled={!!busy || !online} onClick={() => void send(item)}>{busy === item.id ? "Sending…" : "Send"}</button>
            </div>
          </div>
        ))}
        {!items.length && <div className="empty small">Nothing left to review.</div>}
      </div>
    </Modal>
  );
}
