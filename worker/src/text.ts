// Text normalization, transliteration and typo distance shared by indexing and search.

const WORD = /[\p{L}\p{N}_]+/gu;

// Small RU/EN stopword list used only for evidence-coverage scoring, never for indexing.
export const STOPWORDS = new Set(
  `a an the and or of to in on for is are was were be been it this that with at by from as
  what who how when where why which can could do does did i you we they he she my your our
  any anyone someone somebody please about there here have has had will would should
  и в во на с со к ко по о об от до за из у же ли не да нет а но или что кто как где когда
  почему какой какая какие это этот эта мы вы они он она я мне меня ты есть был была были
  кто-нибудь пожалуйста можно подскажите`.split(/\s+/),
);

export function normalize(text: string): string {
  return text.normalize("NFC").toLowerCase();
}

export function tokens(text: string): string[] {
  return normalize(text).match(WORD) ?? [];
}

/** Distinct non-stopword tokens in order of first appearance. */
export function contentTerms(text: string): string[] {
  const out: string[] = [];
  for (const t of tokens(text)) {
    if (t.length > 1 && !STOPWORDS.has(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Prefix used for inflection-tolerant matching ("бухгалтер" ~ "бухгалтера"). */
export function stemKey(term: string): string {
  return term.length >= 6 ? term.slice(0, Math.max(4, term.length - 2)) : term;
}

// ---- RU <-> Latin transliteration (query expansion only) -------------------------------

const RU_TO_LAT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};
const LAT_TO_RU: [string, string][] = Object.entries({
  shch: "щ", sch: "щ", zh: "ж", kh: "х", ts: "ц", ch: "ч", sh: "ш", yu: "ю", ya: "я", yo: "ё",
  oo: "у", ee: "и", ph: "ф", th: "т", a: "а", b: "б", c: "к", d: "д", e: "е", f: "ф", g: "г",
  h: "х", i: "и", j: "дж", k: "к", l: "л", m: "м", n: "н", o: "о", p: "п", q: "к", r: "р",
  s: "с", t: "т", u: "у", v: "в", w: "в", x: "кс", z: "з",
}).sort((a, b) => b[0].length - a[0].length);
const CYR = /[а-яё]/;
const LAT = /[a-z]/;

export function ruToLat(word: string): string {
  return [...word].map((ch) => RU_TO_LAT[ch] ?? ch).join("");
}

export function latToRu(word: string): string {
  let out = "";
  let i = 0;
  while (i < word.length) {
    const ch = word[i]!;
    if (ch === "y" && !/^y[uao]/.test(word.slice(i, i + 2))) {
      const prevVowel = i > 0 && "aeiou".includes(word[i - 1]!);
      const nextVowel = i + 1 < word.length && "aeiou".includes(word[i + 1]!);
      out += prevVowel || nextVowel || i === 0 ? "й" : "и";
      i += 1;
      continue;
    }
    const hit = LAT_TO_RU.find(([lat]) => word.startsWith(lat, i));
    if (hit) {
      out += hit[1];
      i += hit[0].length;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Other-script spelling of a lowercase term, or [] when not applicable. */
export function variants(term: string): string[] {
  let v: string;
  if (CYR.test(term) && !LAT.test(term)) v = ruToLat(term);
  else if (LAT.test(term) && !CYR.test(term)) v = latToRu(term);
  else return [];
  return v && v !== term && v.length > 2 ? [v] : [];
}

/** Safe FTS5 MATCH expression: OR of quoted terms (no operator injection possible). */
export function ftsQuery(terms: string[]): string | null {
  const parts: string[] = [];
  for (const t of terms) {
    const q = `"${t.replaceAll('"', '""')}"`;
    const p = t.length >= 4 ? `${q}*` : q;
    if (!parts.includes(p)) parts.push(p);
  }
  return parts.length ? parts.join(" OR ") : null;
}

/** Restricted Damerau-Levenshtein (optimal string alignment), stops early past `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = b.length;
  let prev2 = new Array<number>(n + 1).fill(0);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(n + 1).fill(0);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2]! + 1);
      }
      cur[j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n]!;
}

/** True if the term (or a transliterated or corrected spelling) appears in the body. */
export function termPresent(term: string, foldedBody: string, extra: string[] = []): boolean {
  return [term, ...variants(term), ...extra].some((t) => foldedBody.includes(stemKey(t)));
}

/** Verbatim window of the original body around the first matched term. */
export function snippet(body: string, terms: string[], width = 280): string {
  if (body.length <= width) return body;
  const folded = normalize(body);
  const positions = terms.map((t) => folded.indexOf(stemKey(t))).filter((p) => p >= 0);
  const pos = positions.length ? Math.min(...positions) : 0;
  let start = Math.max(0, pos - Math.floor(width / 3));
  let end = Math.min(body.length, start + width);
  start = Math.max(0, end - width);
  // Cut between words, never inside one: a quote should not end on "сделат…".
  if (start > 0) {
    const space = body.indexOf(" ", start);
    if (space !== -1 && space < end) start = space + 1;
  }
  if (end < body.length) {
    const space = body.lastIndexOf(" ", end);
    if (space > start) end = space;
  }
  return (start > 0 ? "…" : "") + body.slice(start, end).trim() + (end < body.length ? "…" : "");
}

/** A quoted message as a Telegram block; long ones fold away until opened. Pass escaped HTML. */
export const quoteHtml = (html: string): string => (html.length > 160 ? `<blockquote expandable>${html}</blockquote>` : `<blockquote>${html}</blockquote>`);

export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
