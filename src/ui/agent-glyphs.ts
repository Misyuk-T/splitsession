/**
 * The glyphs of "agent activity": drawn once here and used by the in-page pill (inline SVG; the tab-strip favicon is a
 * ring of rotating dots and carries no glyph). The pill is built inside `pageActivity` (overlay.ts), which is injected as a
 * self-contained function and cannot import, so the background hands these plain data to it with every command.
 *
 * 24 x 24 box, white on the purple pill. `read`: an eye (the agent is looking at the page). `act`: a pointer arrow (the
 * agent is operating it).
 */

export interface GlyphPart {
  /** SVG path data in the 24 x 24 box. */
  d: string;
  /** `fill`: solid white. `stroke`: a white outline `w` wide (round joins and caps). */
  mode: "fill" | "stroke";
  w?: number;
}

export type GlyphKind = "read" | "act";

export const AGENT_GLYPHS: Readonly<Record<GlyphKind, readonly GlyphPart[]>> = {
  read: [
    {
      d: "M1.8 12S5.7 5.2 12 5.2 22.2 12 22.2 12 18.3 18.8 12 18.8 1.8 12 1.8 12Z",
      mode: "stroke",
      w: 2,
    },
    { d: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z", mode: "fill" },
  ],
  act: [
    {
      d: "M5.2 3.2 5 19.4l4.2-3.9 2.7 5.6 2.6-1.2-2.6-5.5 5.9-.4L5.2 3.2Z",
      mode: "fill",
    },
  ],
};

/** The same glyph as standalone SVG markup (for places that can take markup, such as docs and tests). */
export function glyphSvg(kind: GlyphKind, size = 24, color = "#fff"): string {
  const parts = AGENT_GLYPHS[kind]
    .map((p) =>
      p.mode === "fill"
        ? `<path d="${p.d}" fill="${color}"/>`
        : `<path d="${p.d}" fill="none" stroke="${color}" stroke-width="${p.w ?? 2}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">${parts}</svg>`;
}
