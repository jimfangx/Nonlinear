/**
 * Folder hierarchy for a list of changed file paths (Review → Files, tree view).
 * Single-child directory chains are compacted ("src/main/scala"), folders sort
 * before files, and `order` gives file indices in display order (for j/k).
 */

export interface FileTreeFolder {
  kind: "folder";
  /** full path of the folder, e.g. "src/main/scala" */
  path: string;
  /** label shown, possibly compacted, e.g. "main/scala" */
  name: string;
  depth: number;
  children: FileTreeNode[];
  /** indices of all files below this folder */
  files: number[];
}

export interface FileTreeLeaf {
  kind: "file";
  path: string;
  name: string;
  depth: number;
  index: number;
}

export type FileTreeNode = FileTreeFolder | FileTreeLeaf;

export interface FileTree {
  roots: FileTreeNode[];
  /** file indices in display order */
  order: number[];
}

interface Building {
  dirs: Map<string, Building>;
  files: { name: string; index: number }[];
}

export function buildFileTree(paths: readonly string[]): FileTree {
  const root: Building = { dirs: new Map(), files: [] };
  paths.forEach((path, index) => {
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop() ?? path;
    let node = root;
    for (const part of parts) {
      let next = node.dirs.get(part);
      if (!next) node.dirs.set(part, (next = { dirs: new Map(), files: [] }));
      node = next;
    }
    node.files.push({ name, index });
  });

  const order: number[] = [];
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const emit = (node: Building, prefix: string, depth: number): FileTreeNode[] => {
    const out: FileTreeNode[] = [];
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => collator.compare(a, b))) {
      // Compact chains of folders that contain exactly one folder and no files.
      let label = name;
      let path = prefix ? `${prefix}/${name}` : name;
      let cur = child;
      while (cur.files.length === 0 && cur.dirs.size === 1) {
        const [nextName, next] = cur.dirs.entries().next().value as [string, Building];
        label += `/${nextName}`;
        path += `/${nextName}`;
        cur = next;
      }
      const start = order.length;
      const children = emit(cur, path, depth + 1);
      out.push({ kind: "folder", path, name: label, depth, children, files: order.slice(start) });
    }
    for (const f of [...node.files].sort((a, b) => collator.compare(a.name, b.name))) {
      order.push(f.index);
      out.push({ kind: "file", path: prefix ? `${prefix}/${f.name}` : f.name, name: f.name, depth, index: f.index });
    }
    return out;
  };
  const roots = emit(root, "", 0);
  return { roots, order };
}

/** Flatten the tree to visible rows, skipping children of collapsed folders. */
export function visibleTreeRows(tree: FileTree, collapsed: ReadonlySet<string>): FileTreeNode[] {
  const out: FileTreeNode[] = [];
  const walk = (nodes: FileTreeNode[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.kind === "folder" && !collapsed.has(n.path)) walk(n.children);
    }
  };
  walk(tree.roots);
  return out;
}

/** Folder paths that contain `path` (to auto-expand around the selected file). */
export function ancestorFolders(tree: FileTree, fileIndex: number): string[] {
  const out: string[] = [];
  const walk = (nodes: FileTreeNode[]): boolean => {
    for (const n of nodes) {
      if (n.kind === "file" && n.index === fileIndex) return true;
      if (n.kind === "folder" && n.files.includes(fileIndex)) {
        out.push(n.path);
        return walk(n.children);
      }
    }
    return false;
  };
  walk(tree.roots);
  return out;
}
