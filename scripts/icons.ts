// Draws the Reviewloop mark (an open loop with a dot, on espresso) as PNGs for the web app,
// the desktop builds and the Chrome extension. No image tooling needed.
//   npm run icons
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";

type RGBA = [number, number, number, number];
const ESPRESSO: RGBA = [41, 37, 30, 255];
const LINEN: RGBA = [244, 239, 230, 255];

interface Spec {
  size: number;
  /** Inset of the rounded square, as a fraction of size (0 = full bleed). */
  inset: number;
  /** Corner radius as a fraction of the square's side. */
  radius: number;
  /** Mark scale relative to the square. */
  mark: number;
}

function draw({ size, inset, radius, mark }: Spec): Buffer {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4;
  const x0 = size * inset;
  const side = size - 2 * x0;
  const r = side * radius;
  const c = size / 2;
  const outer = (side / 2) * 0.62 * mark;
  const stroke = outer * 0.3;
  const inner = outer - stroke;
  const mid = (outer + inner) / 2;
  // Gap in the ring, upper right: rounded ends, and a dot just outside.
  const gapFrom = -Math.PI * 0.46;
  const gapTo = -Math.PI * 0.04;
  const capAt = (a: number) => ({ x: c + Math.cos(a) * mid, y: c + Math.sin(a) * mid, r: stroke * 0.5 });
  const caps = [capAt(gapFrom), capAt(gapTo)];
  const spark = { x: c + Math.cos(-Math.PI * 0.25) * (outer + stroke * 0.55), y: c + Math.sin(-Math.PI * 0.25) * (outer + stroke * 0.55), r: stroke * 0.42 };

  const inRect = (x: number, y: number) => {
    const qx = Math.max(x0 + r - x, 0, x - (x0 + side - r));
    const qy = Math.max(x0 + r - y, 0, y - (x0 + side - r));
    return qx * qx + qy * qy <= r * r && x >= x0 && x <= x0 + side && y >= x0 && y <= x0 + side;
  };
  const inCircle = (x: number, y: number, k: { x: number; y: number; r: number }) => (x - k.x) ** 2 + (y - k.y) ** 2 <= k.r * k.r;
  const inMark = (x: number, y: number) => {
    const d = Math.hypot(x - c, y - c);
    if (d >= inner && d <= outer) {
      const a = Math.atan2(y - c, x - c);
      if (!(a > gapFrom && a < gapTo)) return true;
    }
    return caps.some((k) => inCircle(x, y, k)) || inCircle(x, y, spark);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          if (!inRect(fx, fy)) continue;
          if (inMark(fx, fy)) fg++;
          else bg++;
        }
      }
      const n = SS * SS;
      const a = (bg + fg) / n;
      const i = (y * size + x) * 4;
      if (a === 0) continue;
      const t = fg / (bg + fg);
      for (let k = 0; k < 3; k++) px[i + k] = Math.round(ESPRESSO[k]! * (1 - t) + LINEN[k]! * t);
      px[i + 3] = Math.round(255 * a);
    }
  }
  return png(size, px);
}

function png(size: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function out(path: string, spec: Spec) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, draw(spec));
  console.log(path);
}

const app: Omit<Spec, "size"> = { inset: 0, radius: 0.225, mark: 1 };
for (const size of [32, 180, 192, 512]) out(`public/icons/icon-${size}.png`, { size, ...app });
out("public/icons/maskable-512.png", { size: 512, inset: 0, radius: 0, mark: 0.8 });
out("public/favicon.png", { size: 64, ...app });
// macOS app icon grid: 824px rounded square on a 1024 canvas. Windows uses the same file.
out("desktop/build/icon.png", { size: 1024, inset: 0.0977, radius: 0.225, mark: 1 });
for (const size of [16, 32, 48, 128]) out(`extension/icons/icon-${size}.png`, { size, ...app });

// Windows taskbar overlay shown while issues are waiting (macOS uses a numbered dock badge).
function dot(size: number): Buffer {
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const r = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let s = 0; s < 16; s++) {
        const fx = x + ((s % 4) + 0.5) / 4;
        const fy = y + (Math.floor(s / 4) + 0.5) / 4;
        if ((fx - c) ** 2 + (fy - c) ** 2 <= r * r) hit++;
      }
      const i = (y * size + x) * 4;
      px[i] = 168;
      px[i + 1] = 64;
      px[i + 2] = 43;
      px[i + 3] = Math.round((255 * hit) / 16);
    }
  }
  return png(size, px);
}
writeFileSync("desktop/build/badge.png", dot(32));
console.log("desktop/build/badge.png");
