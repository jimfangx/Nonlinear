import { useMemo, useState } from "react";
import { indexPatch } from "@nonlinear/core";
import { FileDiff, type DiffCodeLayout } from "./FileDiff";
import { DiffStat, Split } from "./ui";

export function CommitDiff({ text, layout = "wrap" }: { text: string; layout?: DiffCodeLayout }) {
  const index = useMemo(() => indexPatch(text), [text]);
  const [selected, setSelected] = useState(0);
  const file = index.files[selected];
  if (!file) return <div className="empty small">No file changes in this commit.</div>;
  return <div style={{ height: "min(55vh, 520px)" }}>
    <Split id="commit-diff" initial={0.28} className="workspace-split">
      <div className="col review-file-list diff-file-list">
        <div className="review-file-list-head"><span>Files changed · {index.files.length}</span><DiffStat compact additions={index.additions} deletions={index.deletions} /></div>
        <div className="grow" style={{ overflow: "auto", padding: 4 }} aria-label="Changed files">
          {index.files.map((item, i) => <button type="button" key={item.path} title={item.path}
            className={`btn ghost tree-row ${i === selected ? "active" : ""}`} aria-pressed={i === selected}
            style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => setSelected(i)}>
            <span className="ellipsis">{item.path}</span>
          </button>)}
        </div>
      </div>
      <FileDiff key={file.path} path={file.path} section={text.slice(file.start, file.end)} mode="unified" layout={layout} />
    </Split>
  </div>;
}
