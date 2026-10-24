// Mask personal details before any text leaves the Worker. A regex pass is a floor, not
// anonymisation: names inside sentences can remain, so only send what members already shared.

const RULES: [RegExp, string][] = [
  [/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, "[email]"],
  [/\bhttps?:\/\/\S+|\bt\.me\/\S+|\bwww\.\S+/gi, "[link]"],
  [/(^|[^\w])@[A-Za-z][\w]{3,31}\b/g, "$1[user]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[card]"], // card-like numbers, before phones
  [/(?:\+|\b)\d[\d ()-]{8,}\d\b/g, "[phone]"],
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, "[token]"],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, "[token]"], // bot tokens
];

export function redact(text: string): string {
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}
