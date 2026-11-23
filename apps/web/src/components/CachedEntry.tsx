import { useEffect, useId, useState } from "react";

export interface CachedOption {
  value: string;
  detail?: string;
}

export function CachedEntry({ value, onChange, onSelect, options, label, placeholder, search }: {
  value: string;
  onChange: (value: string) => void;
  onSelect: (value: string) => void;
  options: CachedOption[];
  label: string;
  placeholder?: string;
  /** Called (debounced) when the cached options have no good match for what's typed. */
  search?: (query: string) => Promise<CachedOption[]>;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = value.trim().toLowerCase();
  const local = options.filter(({ value: option, detail }) =>
    `${option} ${detail ?? ""}`.toLowerCase().includes(typed)
  ).slice(0, 10);
  // Cache miss: nothing cached matches, or nothing matches the typed text exactly → ask the search source.
  const miss = !!search && typed.length >= 2 && (local.length === 0 || (typed.includes("/") && !local.some((o) => o.value.toLowerCase() === typed)));
  const [remote, setRemote] = useState<{ query: string; results: CachedOption[] } | null>(null);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!miss || !expanded) { setSearching(false); return; }
    let live = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void search!(typed).then((results) => { if (live) setRemote({ query: typed, results }); })
        .catch(() => { if (live) setRemote({ query: typed, results: [] }); })
        .finally(() => { if (live) setSearching(false); });
    }, 350);
    return () => { live = false; window.clearTimeout(timer); };
  }, [typed, miss, expanded]);
  const fromSearch = miss && remote?.query === typed ? remote.results.filter((r) => !local.some((o) => o.value.toLowerCase() === r.value.toLowerCase())) : [];
  const matches = [...local, ...fromSearch].slice(0, 14);
  const show = expanded && (matches.length > 0 || (miss && (searching || remote?.query === typed)));
  const accept = (text: string) => {
    onSelect(text);
    setExpanded(false);
    setActive(-1);
  };
  return <div className="cached-entry" onBlur={(event) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setExpanded(false);
  }}>
    <input className="input" data-workspace-entry role="combobox" aria-label={label}
      aria-expanded={show} aria-autocomplete="list" aria-controls={show ? id : undefined}
      aria-activedescendant={show && active >= 0 && matches[active] ? `${id}-${active}` : undefined}
      value={value} placeholder={placeholder} autoComplete="off"
      onFocus={() => setExpanded(true)}
      onChange={(event) => { onChange(event.target.value); setExpanded(true); setActive(-1); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { setExpanded(false); setActive(-1); }
        if ((event.key === "ArrowUp" || event.key === "ArrowDown") && matches.length) {
          event.preventDefault();
          setExpanded(true);
          setActive((previous) => event.key === "ArrowDown" ? Math.min(matches.length - 1, previous + 1) : Math.max(0, previous - 1));
        }
        if (event.key === "Enter") {
          event.preventDefault();
          accept((show ? matches[active]?.value : undefined) ?? value);
        }
      }}
    />
    {show && <div className="panel cached-entry-menu" id={id} role="listbox" aria-label={`${label} suggestions`}
      onMouseDown={(event) => event.preventDefault()}>
      {matches.map((option, index) =>
        <button type="button" key={option.value} id={`${id}-${index}`} className="btn ghost"
          role="option" aria-selected={index === active} onClick={() => accept(option.value)}>
          <span className="ellipsis">{option.value}</span>
          {option.detail && <span className="faint ellipsis">{option.detail}</span>}
        </button>
      )}
      {miss && searching && <div className="faint small cached-entry-status" role="status">Searching GitHub…</div>}
      {miss && !searching && remote?.query === typed && !fromSearch.length && !local.length && <div className="faint small cached-entry-status" role="status">No matches on GitHub</div>}
    </div>}
  </div>;
}
