// A small GIF writer for the README animations: PNG frames in, one GIF out (pure JS: gifenc + pngjs, no ffmpeg).
//
// Quality and size choices:
//  - one 255-colour palette per *scene* (frames with the same `seg`), built from every pixel sample of the scene, so a
//    scene's own colours (a page, a window) are not squeezed out by another scene's. Entry 255 is kept for "transparent".
//  - no dithering (nearest colour): dithering turns UI text and flat fills into noise.
//  - every frame after the first of a scene stores only the pixels that changed (the rest are transparent, the
//    previous picture stays), which is what keeps held key frames and a moving cursor cheap.
import gifenc from "gifenc";
import { PNG } from "pngjs";

const { GIFEncoder, quantize, applyPalette } = gifenc;

const TRANSPARENT = 255;

/** @param {Buffer} png @returns {{ width: number, height: number, data: Uint8Array }} RGBA pixels */
export function decodePng(png) {
  const { width, height, data } = PNG.sync.read(png);
  return {
    width,
    height,
    data: new Uint8Array(data.buffer, data.byteOffset, data.length),
  };
}

/** Pixels of every `step`-th position of each picture, as one RGBA array: the colour sample of a scene. */
function sampleOf(pictures, step) {
  const parts = pictures.map((p) => {
    const n = Math.floor(p.data.length / 4 / step);
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++)
      out.set(p.data.subarray(i * step * 4, i * step * 4 + 4), i * 4);
    return out;
  });
  const all = new Uint8Array(parts.reduce((sum, a) => sum + a.length, 0));
  let at = 0;
  for (const a of parts) {
    all.set(a, at);
    at += a.length;
  }
  return all;
}

/**
 * @param {{ png: Buffer, ms: number, seg: number }[]} frames in play order; `ms` is how long the frame stays
 * @param {{ width: number, height: number }} size every frame must have exactly this size
 * @returns {Buffer} the GIF (loops forever)
 */
export function encodeGif(frames, { width, height }) {
  const pictures = frames.map((f) => {
    const p = decodePng(f.png);
    if (p.width !== width || p.height !== height)
      throw new Error(
        `frame is ${p.width}x${p.height}, expected ${width}x${height}`,
      );
    return p;
  });
  const palettes = new Map();
  for (const seg of new Set(frames.map((f) => f.seg))) {
    const own = pictures.filter((_, i) => frames[i].seg === seg);
    // Every 3rd pixel of every distinct picture is plenty to find the colours; flat UI colours dominate either way.
    const palette = quantize(sampleOf(own, 3), 255, { format: "rgb565" });
    while (palette.length < 256) palette.push([0, 0, 0]);
    palettes.set(seg, palette);
  }

  const gif = GIFEncoder();
  let previous = null; // indices of the frame on screen
  let previousSeg = null;
  frames.forEach((frame, i) => {
    const palette = palettes.get(frame.seg);
    const index = applyPalette(
      pictures[i].data,
      palette.slice(0, 255),
      "rgb565",
    );
    const diffable = previous !== null && previousSeg === frame.seg;
    let out = index;
    if (diffable) {
      out = new Uint8Array(index.length);
      for (let k = 0; k < index.length; k++)
        out[k] = index[k] === previous[k] ? TRANSPARENT : index[k];
    }
    gif.writeFrame(out, width, height, {
      palette,
      delay: Math.max(20, Math.round(frame.ms / 10) * 10),
      transparent: diffable,
      transparentIndex: TRANSPARENT,
      dispose: 1,
      repeat: 0,
    });
    previous = index;
    previousSeg = frame.seg;
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}
