/// <reference lib="webworker" />
/**
 * Off-main-thread multi-repo diff import (§6). The worker reads the File
 * itself (the main thread never holds the JSON), indexes it with progress
 * events, spills each file's patch section to IndexedDB, and returns only the
 * index — bounded main-thread memory regardless of import size.
 */
import { importMultiRepoDiff, type MultiRepoDiff } from "@nonlinear/core";
import { spillImport } from "../lib/importStore";

export type WorkerIn = { kind: "import"; file?: File; text?: string; name: string; submodules?: [string, { owner: string; repo: string; url: string }][] };
export type WorkerOut =
  | { kind: "progress"; done: number; total: number; path: string }
  | { kind: "done"; diff: MultiRepoDiff; ms: number }
  | { kind: "error"; message: string };

const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const t0 = performance.now();
  const { file, name, submodules } = e.data;
  try {
    let text: string | null = e.data.text ?? (file ? await file.text() : null);
    if (text === null) throw new Error("No input");
    const full = importMultiRepoDiff(text, {
      name,
      submodules: submodules ? new Map(submodules) : undefined,
      onProgress: (done, total, path) => post({ kind: "progress", done, total, path }),
    });
    text = null; // release the source string before spilling
    post({ kind: "progress", done: full.groups.length, total: full.groups.length, path: "writing to disk" });
    const stripped = await spillImport(full);
    post({ kind: "done", diff: stripped, ms: performance.now() - t0 });
  } catch (err) {
    post({ kind: "error", message: (err as Error).message });
  }
};
