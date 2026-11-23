/** Color theme presets. Each overrides the accent tokens for light and dark. */
export interface ColorTheme {
  id: string;
  label: string;
  light: { accent: string; accent2: string; hunk: string };
  dark: { accent: string; accent2: string; hunk: string };
}

export const COLOR_THEMES: ColorTheme[] = [
  { id: "violet", label: "Violet (default)", light: { accent: "#5b4bd6", accent2: "#ede9ff", hunk: "#f0eefc" }, dark: { accent: "#a497ff", accent2: "#2a2550", hunk: "#211f38" } },
  { id: "blue", label: "Blue", light: { accent: "#1f62d0", accent2: "#e3edff", hunk: "#ebf2fd" }, dark: { accent: "#7fb0ff", accent2: "#1b2c4d", hunk: "#18233a" } },
  { id: "teal", label: "Teal", light: { accent: "#0b7a75", accent2: "#dcf4f2", hunk: "#e8f6f5" }, dark: { accent: "#5fd4cc", accent2: "#153a38", hunk: "#142b2a" } },
  { id: "green", label: "Green", light: { accent: "#2f7a1f", accent2: "#e4f4dd", hunk: "#edf6e9" }, dark: { accent: "#8fd672", accent2: "#21391a", hunk: "#1a2a16" } },
  { id: "amber", label: "Amber", light: { accent: "#a35a00", accent2: "#fcefd9", hunk: "#fbf3e4" }, dark: { accent: "#ffbf5e", accent2: "#3d2b12", hunk: "#2c2213" } },
  { id: "rose", label: "Rose", light: { accent: "#c0306a", accent2: "#fde4ee", hunk: "#fcedf3" }, dark: { accent: "#ff8fb8", accent2: "#45182b", hunk: "#321624" } },
  { id: "graphite", label: "Graphite", light: { accent: "#3b3b4a", accent2: "#e8e8ee", hunk: "#f0f0f4" }, dark: { accent: "#c8c8d6", accent2: "#2c2c36", hunk: "#22222a" } },
];

const vars = (t: ColorTheme["light"]) => `--accent: ${t.accent}; --accent-2: ${t.accent2}; --hunk-bg: ${t.hunk};`;
const hex = (color: string, fallback: string) => /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;

function customVars(accent: string) {
  const channels = [1, 3, 5].map((index) => parseInt(accent.slice(index, index + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  return `--accent: ${accent}; --on-accent: ${luminance > 0.179 ? "#000" : "#fff"}; --accent-2: color-mix(in srgb, ${accent} 20%, var(--panel)); --hunk-bg: color-mix(in srgb, ${accent} 12%, var(--bg));`;
}

export function themeCss(id: string, customLight: string, customDark: string): string {
  const t = COLOR_THEMES.find((theme) => theme.id === id);
  if (id === "violet" || (id !== "custom" && !t)) return `:root { --button-accent: #5b4bd6; --button-on-accent: #fff; }`;
  const light = t ? vars(t.light) : customVars(hex(customLight, "#5b4bd6"));
  const dark = t ? vars(t.dark) : customVars(hex(customDark, "#a497ff"));
  return `:root { ${light} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${dark} } }
:root[data-theme="dark"] { ${dark} }`;
}

export const BACKGROUND_BLOB = "ui:background-image";
