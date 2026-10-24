// Check that every quotation in model output appears word for word in the sources.

const QUOTE = /[«"“„]([^«»"“”„]{8,})[»"”]/g;
const fold = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[\s ]+/g, " ").trim();

export interface Checked {
  text: string;
  verified: number;
  failed: string[];
}

/** Removes quotes that aren't in the sources (and reports them); keeps the rest of the text. */
export function checkQuotes(output: string, sources: string[]): Checked {
  const hay = fold(sources.join("\n"));
  let verified = 0;
  const failed: string[] = [];
  const text = output.replace(QUOTE, (all, inner: string) => {
    if (hay.includes(fold(inner))) {
      verified += 1;
      return all;
    }
    failed.push(inner);
    return "";
  });
  return { text: text.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim(), verified, failed };
}
