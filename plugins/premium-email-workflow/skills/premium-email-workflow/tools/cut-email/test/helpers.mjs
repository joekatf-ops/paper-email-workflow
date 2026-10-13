// Shared helpers for the cut-email tests: temp folders, synthetic images, colour maths.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';

export async function tempDir(label = 'cut-email-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), label));
}

// Small seeded random number generator so every test run makes the same pictures.
export function seeded(seed = 42) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * A 1200 x 3000 test master with distinct parts:
 *   0 to 600     smooth gradient
 *   600 to 800   flat brand orange #FE8F50
 *   800 to 1600  photo-like texture (smooth blobs plus fine grain)
 *   1600 to 1800 flat navy with a white box (a "button")
 *   1800 to 3000 diagonal gradient
 * Returns the raw RGB pixels as well, so tests can compare against an independent copy.
 */
export async function makeSyntheticMaster(file, { width = 1200, height = 3000, alphaBand = null } = {}) {
  const rand = seeded(7);
  // photo-like texture: a small random image blown up smoothly
  const small = Buffer.alloc(40 * 27 * 3);
  for (let i = 0; i < small.length; i++) small[i] = Math.floor(rand() * 256);
  const blobs = await sharp(small, { raw: { width: 40, height: 27, channels: 3 } })
    .resize(width, 800, { kernel: 'cubic' })
    .raw()
    .toBuffer();

  const channels = alphaBand ? 4 : 3;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r, g, b;
      if (y < 600) [r, g, b] = [(x / width) * 255, (y / 600) * 255, 128];
      else if (y < 800) [r, g, b] = [254, 143, 80];
      else if (y < 1600) {
        const k = ((y - 800) * width + x) * 3;
        const grain = () => (rand() - 0.5) * 6;
        [r, g, b] = [blobs[k] + grain(), blobs[k + 1] + grain(), blobs[k + 2] + grain()];
      } else if (y < 1800) {
        const inBox = y > 1650 && y < 1750 && x > 300 && x < 900;
        [r, g, b] = inBox ? [255, 255, 255] : [18, 25, 87];
      } else [r, g, b] = [((x + y) / (width + height)) * 255, 200 - ((y - 1800) / 1200) * 150, (x / width) * 200];
      const k = (y * width + x) * channels;
      data[k] = clamp(r);
      data[k + 1] = clamp(g);
      data[k + 2] = clamp(b);
      if (channels === 4) data[k + 3] = alphaBand && y >= alphaBand[0] && y < alphaBand[1] ? 0 : 255;
    }
  }
  await sharp(data, { raw: { width, height, channels } }).png({ compressionLevel: 1 }).toFile(file);
  return { data, width, height, channels };
}

/** Builds a plain image from horizontal bands of exact stored values: [[heightPx, [r,g,b]], ...]. */
export function bandsRaw(width, bands) {
  const height = bands.reduce((n, [h]) => n + h, 0);
  const data = Buffer.alloc(width * height * 3);
  let y0 = 0;
  for (const [h, [r, g, b]] of bands) {
    for (let y = y0; y < y0 + h; y++)
      for (let x = 0; x < width; x++) {
        const k = (y * width + x) * 3;
        data[k] = r;
        data[k + 1] = g;
        data[k + 2] = b;
      }
    y0 += h;
  }
  return { data, width, height };
}

// ---------- PNG colour profile splicing (independent of sharp's own encoder) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Returns a copy of an untagged PNG with an iCCP chunk added, without touching the pixel numbers. */
export function addIccToPng(png, icc, name = 'Display P3') {
  const sig = png.subarray(0, 8);
  const ihdrLen = png.readUInt32BE(8);
  const afterIhdr = 8 + 12 + ihdrLen;
  const body = Buffer.concat([Buffer.from(name, 'latin1'), Buffer.from([0, 0]), zlib.deflateSync(icc)]);
  const type = Buffer.from('iCCP', 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, body])));
  return Buffer.concat([sig, png.subarray(8, afterIhdr), len, type, body, crc, png.subarray(afterIhdr)]);
}

/** Display P3 ICC profile bytes, taken from sharp's built-in copy. */
export async function displayP3Profile() {
  const tagged = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#808080' } })
    .withIccProfile('p3')
    .png()
    .toBuffer();
  return (await sharp(tagged).metadata()).icc;
}

// ---------- reference colour maths (written out by hand, no sharp involved) ----------

const toLinear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c) => {
  const v = Math.max(0, Math.min(1, c));
  return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
};

/** Display P3 numbers to sRGB numbers. Both use the sRGB tone curve and a D65 white point. */
export function p3ToSrgb([r, g, b]) {
  const [R, G, B] = [toLinear(r), toLinear(g), toLinear(b)];
  return [
    fromLinear(1.2249401 * R - 0.2249404 * G),
    fromLinear(-0.0420569 * R + 1.0420571 * G),
    fromLinear(-0.0196376 * R - 0.0786361 * G + 1.0982735 * B),
  ].map((v) => Math.round(v));
}

export async function pixelAt(file, x, y) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const k = (y * info.width + x) * 3;
  return [data[k], data[k + 1], data[k + 2]];
}

export const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/** A quiet logger so test output stays readable. */
export function collectLog() {
  const lines = [];
  const log = (...a) => lines.push(a.join(' '));
  log.lines = lines;
  return log;
}
