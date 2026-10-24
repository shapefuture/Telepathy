import { describe, expect, it } from "vitest";
import { classify } from "../src/classify";
import { contentTerms, editDistance, escapeHtml, ftsQuery, latToRu, ruToLat, snippet, variants } from "../src/text";
import { localParts } from "../src/util";

describe("text", () => {
  it("transliterates both ways", () => {
    expect(ruToLat("деплой")).toBe("deploy");
    expect(latToRu("deploy")).toBe("деплой");
    expect(latToRu("zoom")).toBe("зум");
    expect(variants("python")).toEqual(["питон"]);
    expect(variants("mixedслово")).toEqual([]);
  });

  it("drops stopwords and duplicates", () => {
    expect(contentTerms("Who is the accountant, the ACCOUNTANT?")).toEqual(["accountant"]);
    expect(contentTerms("кто знает бухгалтера")).toEqual(["знает", "бухгалтера"]);
  });

  it("quotes every FTS term so operators cannot be injected", () => {
    expect(ftsQuery(['a"b', "near", "accountant"])).toBe('"a""b" OR "near"* OR "accountant"*');
    expect(ftsQuery([])).toBeNull();
  });

  it("bounded edit distance with transpositions", () => {
    expect(editDistance("accountnat", "accountant", 2)).toBe(1);
    expect(editDistance("бухгалтер", "бугалтер", 2)).toBe(1);
    expect(editDistance("cat", "dog", 1)).toBe(2);
  });

  it("snippets keep the original text around the match", () => {
    const body = `${"x ".repeat(300)}the parking is behind the library ${"y ".repeat(300)}`;
    const s = snippet(body, ["parking"]);
    expect(s).toContain("parking is behind");
    expect(s.length).toBeLessThanOrEqual(282);
  });

  it("escapes HTML", () => {
    expect(escapeHtml('<b a="1">&')).toBe("&lt;b a=&quot;1&quot;&gt;&amp;");
  });

  it("classifies explicit help requests in RU and EN", () => {
    expect(classify("Can anyone recommend an accountant?")).toEqual({ intent: "help_request", confidence: 0.85 });
    expect(classify("Посоветуйте юриста по визам?").intent).toBe("help_request");
    expect(classify("Могу помочь с налогами, пишите в лс").intent).toBe("help_offer");
    expect(classify("what time is it?").confidence).toBe(0.55);
  });

  it("local time respects DST (Asia/Jerusalem)", () => {
    // UTC+3 in summer, UTC+2 after 2026-10-25.
    expect(localParts(new Date("2026-10-24T06:00:00Z"), "Asia/Jerusalem")).toEqual({ date: "2026-10-24", hour: 9 });
    expect(localParts(new Date("2026-10-26T06:00:00Z"), "Asia/Jerusalem")).toEqual({ date: "2026-10-26", hour: 8 });
  });
});
