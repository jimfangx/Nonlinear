import { useEffect, useState } from "react";
import { useSettings } from "../lib/store";
import { getBlob } from "../lib/db";
import { BACKGROUND_BLOB, themeCss } from "../lib/theme";

/** Applies the color preset and the optional background image (under a darkness mask). */
export function ThemeLayer() {
  const s = useSettings();
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!s.backgroundImage) { setImage(null); return; }
    void getBlob(BACKGROUND_BLOB).then((data) => { if (active) setImage(data ?? null); });
    return () => { active = false; };
  }, [s.backgroundImage]);
  useEffect(() => {
    document.documentElement.classList.toggle("has-bg", !!image);
    return () => document.documentElement.classList.remove("has-bg");
  }, [image]);
  return (
    <>
      <style>{themeCss(s.colorTheme, s.customAccentLight, s.customAccentDark)}</style>
      {image && (
        <div className="app-background" aria-hidden="true" style={{ backgroundImage: `url("${image}")` }}>
          <div className="app-background-mask" style={{ opacity: Math.max(0, Math.min(0.95, s.backgroundDim)) }} />
        </div>
      )}
    </>
  );
}
