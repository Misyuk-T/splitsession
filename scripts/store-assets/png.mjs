// Flattens a PNG to 24-bit RGB (no alpha channel): the Chrome Web Store refuses screenshots and tiles with one.
// Reads 8-bit, non-interlaced RGBA or RGB (what Chromium writes), composites onto white, writes colour type 2.
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};

/** The header of a PNG: size, bit depth and colour type (2 = RGB, 6 = RGBA). */
export function pngInfo(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    depth: png[24],
    colorType: png[25],
    interlace: png[28],
  };
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** @param {Buffer} png @returns {Buffer} the same picture as 24-bit RGB */
export function flattenPng(png) {
  const { width, height, depth, colorType, interlace } = pngInfo(png);
  if (depth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2))
    throw new Error(
      `unsupported PNG (depth ${depth}, colour type ${colorType}, interlace ${interlace})`,
    );
  const bpp = colorType === 6 ? 4 : 3;
  const idat = [];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT")
      idat.push(png.subarray(at + 8, at + 8 + len));
    at += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? px[y * stride + x - bpp] : 0;
      const up = y > 0 ? px[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? px[(y - 1) * stride + x - bpp] : 0;
      const add =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? (left + up) >> 1
                : paeth(left, up, upLeft);
      px[y * stride + x] = (raw[src + x] + add) & 0xff;
    }
  }
  // RGB rows with the "Up" filter: small files, and a fixed encoding for a given picture.
  const rows = Buffer.alloc((width * 3 + 1) * height);
  const rgb = Buffer.alloc(width * 3 * height);
  for (let i = 0; i < width * height; i++) {
    const a = bpp === 4 ? px[i * 4 + 3] / 255 : 1;
    for (let k = 0; k < 3; k++)
      rgb[i * 3 + k] = Math.round(px[i * bpp + k] * a + 255 * (1 - a));
  }
  for (let y = 0; y < height; y++) {
    rows[y * (width * 3 + 1)] = 2;
    for (let x = 0; x < width * 3; x++) {
      const up = y > 0 ? rgb[(y - 1) * width * 3 + x] : 0;
      rows[y * (width * 3 + 1) + 1 + x] = (rgb[y * width * 3 + x] - up) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
