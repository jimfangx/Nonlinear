const paths = {
  inbox: "M4 4h16l2 10v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-5L4 4z M2 14h6l2 3h4l2-3h6",
  timeline: "M3 3v17h18 M7 8h7 M11 12h8 M6 16h9",
  board: "M3 4h18v16H3z M9 4v16 M15 4v16 M5 8h2 M11 8h2 M17 8h2 M5 12h2 M11 12h2",
  review: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  diff: "M3 7h17 M16 3l4 4-4 4 M21 17H4 M8 13l-4 4 4 4",
  graph: "M6 7v10 M18 7c0 6-12 3-12 10 M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0z M20 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0z M8 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0z",
  settings: "M3 6h18 M3 12h18 M3 18h18 M8 3v6 M16 9v6 M11 15v6",
};

export function NavIcon({ name }: { name: keyof typeof paths }) {
  return <svg className="nav-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
