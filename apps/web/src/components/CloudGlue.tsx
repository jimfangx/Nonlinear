import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { approvePair, completeConnectFromUrl, denyPair, pendingPairs, type PendingPair } from "../lib/cloud";
import { useApp, useSettings } from "../lib/store";
import { Modal } from "./ui";

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
  if (!p) return null;
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
