import { useId, useState } from "react";

export interface CachedOption {
  value: string;
  detail?: string;
}

export function CachedEntry({ value, onChange, onSelect, options, label, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  onSelect: (value: string) => void;
  options: CachedOption[];
  label: string;
  placeholder?: string;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(-1);
  const matches = options.filter(({ value: option, detail }) =>
    `${option} ${detail ?? ""}`.toLowerCase().includes(value.trim().toLowerCase())
  ).slice(0, 10);
  const show = expanded && matches.length > 0;
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
    {show && <div className="panel cached-entry-menu" id={id} role="listbox" aria-label={`${label} suggestions`}>
      {matches.map((option, index) =>
        <button type="button" key={option.value} id={`${id}-${index}`} className="btn ghost"
          role="option" aria-selected={index === active} onClick={() => accept(option.value)}>
          <span className="ellipsis">{option.value}</span>
          {option.detail && <span className="faint ellipsis">{option.detail}</span>}
        </button>
      )}
    </div>}
  </div>;
}
