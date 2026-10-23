// Deterministic intent rules (P04-09). Local only; a label is never competence evidence (C08).

import { normalize } from "./text";

export type Intent = "help_request" | "help_offer" | "event" | "resource" | "social" | "other";

const rx = (...p: string[]) => new RegExp(p.join("|"), "iu");
const HELP_REQUEST = rx(
  String.raw`\b(can|could) (anyone|someone|somebody|you) (recommend|help|suggest|advise)`,
  String.raw`\b(looking for|need) (a |an |some )?(recommendation|advice|help|contact|intro)`,
  String.raw`\bdoes anyone know\b`, String.raw`\bany recommendations?\b`, String.raw`\bwho (knows|can)\b`,
  "посоветуйте", "подскажите", "кто[- ]?(нибудь|то)? ?(знает|может|подскажет)",
  "(^|\\s)ищу(\\s|$)", "нуж(ен|на|но)", "помогите",
);
const HELP_OFFER = rx(
  String.raw`\bi can help\b`, String.raw`\bhappy to help\b`, String.raw`\bfeel free to (dm|reach out|ping)`,
  "могу помочь", "готов[аы]? помочь", "обращайтесь", "пишите в лс",
);
const EVENT = rx(
  String.raw`\b(meetup|webinar|workshop|event|meeting) (on|at|this|next)\b`, String.raw`\bjoin us\b`,
  "встреча", "вебинар", "митап", "приглашаем",
);
const SOCIAL = /^(hi|hello|hey|thanks|thank you|привет|спасибо|всем привет)[\s!.]*$/iu;
const URL = /https?:\/\/\S+/;

export function classify(text: string): { intent: Intent; confidence: number } {
  const t = normalize(text).trim();
  if (!t) return { intent: "other", confidence: 0 };
  if (HELP_REQUEST.test(t)) return { intent: "help_request", confidence: t.includes("?") ? 0.85 : 0.7 };
  if (HELP_OFFER.test(t)) return { intent: "help_offer", confidence: 0.8 };
  if (EVENT.test(t)) return { intent: "event", confidence: 0.7 };
  if (SOCIAL.test(t)) return { intent: "social", confidence: 0.8 };
  if (URL.test(t)) return { intent: "resource", confidence: 0.55 };
  if (t.endsWith("?")) return { intent: "help_request", confidence: 0.55 };
  return { intent: "other", confidence: 0.3 };
}
