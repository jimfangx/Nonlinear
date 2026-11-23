const paths = {
  close: "M6 6l12 12M18 6L6 18",
  trash: "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 10v6 M14 10v6",
  search: "M15.5 15.5L21 21M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0z",
  copy: "M8 8h12v12H8z M4 16V4h12",
  pin: "M15.5 3.5l5 5-3 2-1 4-2 2-7-7 2-2 4-1 2-3z M11 13l-7 7",
  lock: "M6 10h12v10H6z M8 10V7a4 4 0 1 1 8 0v3",
  account: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z M4 21c0-9 16-9 16 0",
  moon: "M21 13A9 9 0 1 1 11 3a8 8 0 0 0 10 10z",
  activity: "M2 12h5l3-7 4 14 3-7h5",
  shield: "M12 2l8 3v7c0 4-4 8-8 10-4-2-8-6-8-10V5l8-3z M8 12l3 3 5-6",
  sidebar: "M3 4h18v16H3z M9 4v16",
  warning: "M12 3l10 18H2z M12 9v4 M12 17h.01",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z M12 7v6l4 2",
  inbox: "M4 4h16l2 10v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-5L4 4z M2 14h6l2 3h4l2-3h6",
  timeline: "M3 3v17h18 M7 8h7 M11 12h8 M6 16h9",
  board: "M3 4h18v16H3z M9 4v16 M15 4v16 M5 8h2 M11 8h2 M17 8h2 M5 12h2 M11 12h2",
  review: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  diff: "M3 7h17 M16 3l4 4-4 4 M21 17H4 M8 13l-4 4 4 4",
  graph: "M6 7v10 M18 7c0 6-12 3-12 10 M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0z M20 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0z M8 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0z",
  settings: "M3 6h18 M3 12h18 M3 18h18 M8 3v6 M16 9v6 M11 15v6",
  list: "M8 6h13 M8 12h13 M8 18h13 M3.5 6h.01 M3.5 12h.01 M3.5 18h.01",
  tree: "M3 5h6l2 2h10v4H3z M7 11v8h4 M11 15h10v4H11z",
  chevron: "M9 6l6 6-6 6",
  find: "M15.5 15.5L21 21M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0z M7 10h6",
};

export function NavIcon({ name }: { name: keyof typeof paths }) {
  return <svg className="nav-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
