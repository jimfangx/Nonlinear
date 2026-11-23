import { useEffect, useRef } from "react";
import { useApp, DEFAULT_KEYS } from "./store";

export type Action = keyof typeof DEFAULT_KEYS;

export function matches(e: KeyboardEvent, binding: string): boolean {
  const parts = binding.toLowerCase().split("+");
  const key = parts.pop()!;
  const mod = parts.includes("mod");
  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
  if (mod && !(isMac ? e.metaKey : e.ctrlKey)) return false;
  if ((!mod && (e.metaKey || e.ctrlKey)) || (mod && e.metaKey && e.ctrlKey)) return false;
  if (key !== "/" && parts.includes("shift") !== e.shiftKey) return false;
  if (parts.includes("alt") !== e.altKey) return false;
  return e.key.toLowerCase() === key;
}

/** Fixed alternative bindings that always work in addition to the configurable one. */
const ALIASES: Partial<Record<Action, string[]>> = { palette: ["mod+p"] };

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

/** Bind configurable actions while the component is mounted. */
export function useActions(handlers: Partial<Record<Action, (e: KeyboardEvent) => void>>, deps: unknown[] = []): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const kb = useApp.getState().settings_().keybindings;
      for (const [action, fn] of Object.entries(ref.current)) {
        const primary = kb[action] ?? DEFAULT_KEYS[action as Action];
        if (!fn) continue;
        for (const b of [primary, ...(ALIASES[action as Action] ?? [])]) {
          if (!b) continue;
          if (!b.includes("mod") && (typing(e) || (action !== "entry" && document.querySelector(".overlay:not([inert]), #workspace-content[inert]")))) continue;
          if (matches(e, b)) {
            e.preventDefault();
            fn(e);
            return;
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function keyLabel(action: Action): string {
  const b = useApp.getState().settings_().keybindings[action] ?? DEFAULT_KEYS[action] ?? "";
  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
  return b.replace("mod", isMac ? "⌘" : "Ctrl").replace("+", isMac ? "" : "+").toUpperCase();
}
