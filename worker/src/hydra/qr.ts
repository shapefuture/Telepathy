// Minimal QR code generator for the printed recovery card (H6): byte mode, error correction M,
// versions 1–10 (up to 213 bytes). Follows ISO/IEC 18004 (structure after Nayuki's reference
// implementation). Output is an SVG string, so no external library or network is needed.

const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

function rawModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
const dataCodewords = (ver: number) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver - 1]! * NUM_BLOCKS[ver - 1]!;

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function rsDivisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j]!, root);
      if (j + 1 < r.length) r[j] = r[j]! ^ r[j + 1]!;
    }
    root = gfMul(root, 2);
  }
  return r;
}
function rsRemainder(data: number[], div: number[]): number[] {
  const r = new Array<number>(div.length).fill(0);
  for (const b of data) {
    const f = b ^ r.shift()!;
    r.push(0);
    div.forEach((c, i) => (r[i] = r[i]! ^ gfMul(c, f)));
  }
  return r;
}

function alignPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 10; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

export function qrMatrix(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 1;
  for (; ver <= 10; ver++) if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  if (ver > 10) throw new Error("qr_too_long");
  // ---- data bits
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(4, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  // ---- blocks, ECC, interleave
  const nb = NUM_BLOCKS[ver - 1]!;
  const ecl = ECC_PER_BLOCK[ver - 1]!;
  const raw = Math.floor(rawModules(ver) / 8);
  const short = nb - (raw % nb);
  const shortLen = Math.floor(raw / nb);
  const div = rsDivisor(ecl);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const d = data.slice(k, k + shortLen - ecl + (i < short ? 0 : 1));
    k += d.length;
    const e = rsRemainder(d, div);
    if (i < short) d.push(0);
    blocks.push(d.concat(e));
  }
  const codewords: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) blocks.forEach((b, j) => {
    if (i !== shortLen - ecl || j >= short) codewords.push(b[i]!);
  });
  // ---- function patterns
  const size = ver * 4 + 17;
  const m: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, v: boolean) => {
    m[y]![x] = v;
    fn[y]![x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const al = alignPositions(ver);
  for (let i = 0; i < al.length; i++)
    for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i]! + dx, al[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  const drawFormat = (mask: number) => {
    const d = (0 << 3) | mask; // level M = 0b00
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((d << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((f >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0); // reserve
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = ((v >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const c = Math.floor(i / 3);
      set(a, c, b);
      set(c, a, b);
    }
  }
  // ---- codewords, zigzag
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y]![x] && i < codewords.length * 8) {
          m[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
  }
  // ---- mask: choose the lowest penalty
  const maskFn = [
    (x: number, y: number) => (x + y) % 2 === 0,
    (_x: number, y: number) => y % 2 === 0,
    (x: number) => x % 3 === 0,
    (x: number, y: number) => (x + y) % 3 === 0,
    (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const apply = (k: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y]![x] && maskFn[k]!(x, y)) m[y]![x] = !m[y]![x];
  };
  let best = 0;
  let bestScore = Infinity;
  for (let k = 0; k < 8; k++) {
    apply(k);
    drawFormat(k);
    const s = penalty(m);
    if (s < bestScore) {
      bestScore = s;
      best = k;
    }
    apply(k); // undo (XOR)
  }
  apply(best);
  drawFormat(best);
  return m;
}

function penalty(m: boolean[][]): number {
  const n = m.length;
  let s = 0;
  let dark = 0;
  for (let y = 0; y < n; y++) {
    for (const horiz of [true, false]) {
      let run = 1;
      for (let x = 1; x < n; x++) {
        const a = horiz ? m[y]![x] : m[x]![y];
        const b = horiz ? m[y]![x - 1] : m[x - 1]![y];
        if (a === b) {
          run++;
          if (run === 5) s += 3;
          else if (run > 5) s++;
        } else run = 1;
      }
    }
    for (let x = 0; x < n; x++) {
      if (m[y]![x]) dark++;
      if (x < n - 1 && y < n - 1 && m[y]![x] === m[y]![x + 1] && m[y]![x] === m[y + 1]![x] && m[y]![x] === m[y + 1]![x + 1]) s += 3;
    }
  }
  return s + Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
}

export function qrSvg(text: string, scale = 4): string {
  const m = qrMatrix(text);
  const q = 4;
  const n = m.length + q * 2;
  let path = "";
  m.forEach((row, y) => row.forEach((v, x) => v && (path += `M${x + q},${y + q}h1v1h-1z`)));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * scale}" height="${n * scale}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
