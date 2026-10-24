// H4/H7: Shamir secret sharing over GF(256) (AES polynomial 0x11b). Used to split CONTINUITY_KEY
// among k-of-n custodians, and the key of a sealed relocation among partners. Any k shares
// recover the secret; fewer reveal nothing about it.
// Share text: "s1-<k>-<x>-<base64url(y)>"

import { b64u, unb64u } from "./webpush";

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0); // multiply by generator 3
    x &= 0xff;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);
const div = (a: number, b: number) => {
  if (b === 0) throw new Error("div0");
  return a === 0 ? 0 : EXP[(LOG[a]! + 255 - LOG[b]!) % 255]!;
};

export interface Share {
  k: number;
  x: number;
  y: Uint8Array;
}

export function split(secret: Uint8Array, n: number, k: number, rnd: (len: number) => Uint8Array = (len) => crypto.getRandomValues(new Uint8Array(len))): Share[] {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 2 || n < k || n > 255) throw new Error("shamir_params");
  const coeffs = Array.from({ length: secret.length }, (_, i) => [secret[i]!, ...rnd(k - 1)]);
  return Array.from({ length: n }, (_, j) => {
    const x = j + 1;
    const y = new Uint8Array(secret.length);
    for (let i = 0; i < secret.length; i++) {
      let acc = 0;
      for (let d = k - 1; d >= 0; d--) acc = mul(acc, x) ^ coeffs[i]![d]!; // Horner
      y[i] = acc;
    }
    return { k, x, y };
  });
}

export function combine(shares: Share[]): Uint8Array {
  const uniq = [...new Map(shares.map((s) => [s.x, s])).values()];
  if (!uniq.length) throw new Error("shamir_none");
  const k = uniq[0]!.k;
  if (uniq.length < k) throw new Error("shamir_too_few");
  const use = uniq.slice(0, k);
  const len = use[0]!.y.length;
  if (use.some((s) => s.y.length !== len || s.x < 1 || s.x > 255)) throw new Error("shamir_shape");
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    let acc = 0;
    for (const a of use) {
      let num = 1;
      let den = 1;
      for (const b of use) {
        if (a.x === b.x) continue;
        num = mul(num, b.x);
        den = mul(den, a.x ^ b.x);
      }
      acc ^= mul(a.y[i]!, div(num, den));
    }
    out[i] = acc;
  }
  return out;
}

export const encodeShare = (s: Share) => `s1-${s.k}-${s.x}-${b64u(s.y)}`;
export function decodeShare(t: string): Share {
  const m = /^s1-(\d{1,3})-(\d{1,3})-([A-Za-z0-9_-]+)$/.exec(t.trim());
  if (!m) throw new Error("share_shape");
  return { k: Number(m[1]), x: Number(m[2]), y: unb64u(m[3]!) };
}
