import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { approvePair, completeConnectFromUrl, denyPair, pendingPairs, recoveryKey, type PendingPair } from "../lib/cloud";
import { useApp, useSettings } from "../lib/store";
import { Modal, download } from "./ui";

/**
 * Shows the recovery key until the user confirms they saved it: right after the first Connect
 * creates the sync key, and once on devices whose key was created before this prompt existed.
 */
function RecoveryKeyPrompt() {
  const s = useSettings();
  const set = useApp((x) => x.setSettings);
  const toast = useApp((x) => x.toast);
  const [key, setKey] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [later, setLater] = useState(false);
  const needed = s.syncEnabled && !s.recoveryKeySavedAt && !later;
  useEffect(() => {
    if (!needed) return;
    let live = true;
    void recoveryKey().then((k) => live && setKey(k));
    return () => { live = false; };
  }, [needed]);
  if (!needed || !key) return null;
  return (
    <Modal
      title="Save your recovery key"
      onClose={() => setLater(true)}
      footer={
        <>
          <button className="btn" onClick={() => setLater(true)}>Remind me later</button>
          <span className="spacer" />
          <button className="btn primary" disabled={!saved} onClick={() => { set({ recoveryKeySavedAt: Date.now() }); toast("success", "Recovery key saved. You can view it again in Settings → Nonlinear Cloud."); }}>Done</button>
        </>
      }
    >
      <p>Your synced data is end-to-end encrypted. If you lose every connected device, this key is the only way to read it again. Nonlinear's server can't recover it.</p>
      <code className="mono panel pad" style={{ display: "block", userSelect: "all", fontSize: 14, wordBreak: "break-all" }}>{key}</code>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={() => void navigator.clipboard.writeText(key).then(() => toast("info", "Copied"))}>Copy</button>
        <button className="btn sm" onClick={() => download("nonlinear-recovery-key.txt", key + "\n")}>Download</button>
      </div>
      <label className="row small" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I've saved it in my password manager or another safe place
      </label>
    </Modal>
  );
}

/** Finishes "Connect" after the GitHub redirect and surfaces device-pairing approvals. */
export function CloudGlue() {
  const nav = useNavigate();
  const s = useSettings();
  const toast = useApp((x) => x.toast);
  const [pending, setPending] = useState<PendingPair[]>([]);

  useEffect(() => {
    completeConnectFromUrl()
      .then((st) => {
        if (!st) return;
        toast(st.kind === "connected" ? "success" : "info", st.kind === "connected" ? `Connected as @${st.login}` : `Signed in${"login" in st ? ` as @${st.login}` : ""}. Pair this device to decrypt your synced data.`);
        nav("/settings");
      })
      .catch((e) => toast("error", (e as Error).message));
  }, []);

  useEffect(() => {
    if (!s.syncEnabled) return;
    const tick = () => void pendingPairs().then(setPending).catch(() => undefined);
    tick();
    const t = setInterval(tick, 15_000);
    return () => clearInterval(t);
  }, [s.syncEnabled]);

  const p = pending[0];
  if (!p) return <RecoveryKeyPrompt />;
  const done = () => setPending((xs) => xs.slice(1));
  return (
    <Modal
      title="Approve new device?"
      onClose={done}
      footer={
        <>
          <button className="btn danger" onClick={() => void denyPair(p).finally(done)}>
            Deny
          </button>
          <button className="btn primary" onClick={() => void approvePair(p).then(() => toast("success", `Approved ${p.label}`)).catch((e) => toast("error", e.message)).finally(done)}>
            Approve
          </button>
        </>
      }
    >
      <p>
        <b>{p.label}</b> wants to join your Nonlinear Cloud sync.
      </p>
      <p>
        Only approve if that device shows the code <b className="mono" style={{ fontSize: 18 }}>{p.code}</b>.
      </p>
      <p className="faint small">Approving sends your sync key to that device, encrypted to its key. The server never sees it.</p>
    </Modal>
  );
}
