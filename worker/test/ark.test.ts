// Ковчег (plan: build step 7, journey 10): the copy line, taking everything, calling everyone,
// and "what the bot knows about me".
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureMember } from "../src/acl";
import { arkLine } from "../src/ark";
import { dispatchPending } from "../src/outbox";
import { OWNER, dm, enableGroup, feed, groupMsg, press, testApp, type Call } from "./helpers";
import type { Env } from "../src/env";

const q = <T>(sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).first<T>();
const idOf = async (tg: number) => (await ensureMember(env.DB, tg)).id;
const docs = (calls: Call[]) => calls.filter((c) => c.method === "sendDocument");

async function world() {
  const t = testApp();
  await enableGroup(t.app);
  await feed(t.app, groupMsg(1, "The venue for the meetup is Hall B"));
  await feed(t.app, groupMsg(2, "hello"));
  return t;
}

describe("Ковчег: the copy line", () => {
  it("is honest when copies aren't set up, and shows the last copy when they are", async () => {
    expect(await arkLine(env.DB, env as unknown as Env, "en")).toContain("aren't set up yet");
    await env.DB.prepare("INSERT INTO escrow_runs(id, at, bytes, sha256, targets_ok, targets_failed) VALUES ('r1', '2026-10-25T03:00:00Z', 10, 'x', 2, 0)").run();
    const configured = { ...env, ESCROW_R2: {} } as unknown as Env;
    expect(await arkLine(env.DB, configured, "en")).toContain("Last copy: 2026-10-25");
  });

  it("the owner's console shows the line and the two actions for each club", async () => {
    const { app, calls } = await world();
    await feed(app, dm(OWNER, "/ark"));
    expect(calls.filter((c) => c.params.chat_id === OWNER && c.method === "sendMessage").map((c) => String(c.params.text)).join("\n")).toContain("Ковчег");
    const clubButtons = calls.filter((c) => c.params.chat_id === OWNER && c.params.reply_markup).flatMap((c) => c.params.reply_markup.inline_keyboard.flat().map((b: { callback_data: string }) => b.callback_data));
    expect(clubButtons.some((d: string) => d.endsWith(":take"))).toBe(true);
    expect(clubButtons.some((d: string) => d.endsWith(":call"))).toBe(true);
  });
});

describe("Ковчег: take everything, call everyone", () => {
  it("/move takes only a secure address, and 'Take everything' sends the club's memory as one file", async () => {
    const { app, calls } = await world();
    await feed(app, dm(OWNER, "/move http://insecure.example"));
    expect(calls.filter((c) => c.params.chat_id === OWNER).at(-1)!.params.text).toContain("secure address");
    await feed(app, dm(OWNER, "/move https://new.example/club"));
    const src = (await q<{ id: string }>("SELECT id FROM sources"))!.id;
    expect(await q("SELECT value FROM settings WHERE key=?", `ark.move.${src}`)).toEqual({ value: "https://new.example/club" });
    const takeKey = `ak:${src}:take`;
    await feed(app, press(OWNER, takeKey));
    const file = docs(calls).at(-1)!;
    expect(file.params.document.name).toBe("telepathy-export.json");
    const body = await (file.params.document.text as Blob).text(); // the fake Telegram keeps the file as a Blob
    expect(body).toContain("telepathy-export/1");
    expect(body).toContain("Hall B");
    expect(body).not.toMatch(/"tg_id"/); // no Telegram ids in the export
  });

  it("'Call everyone' tells each member once a day, and a stranger can't press it", async () => {
    const { app, calls } = await world();
    await feed(app, dm(OWNER, "/move https://new.example/club"));
    const src = (await q<{ id: string }>("SELECT id FROM sources"))!.id;
    await feed(app, press(77, `ak:${src}:call`));
    expect(await q("SELECT COUNT(*) AS n FROM effects WHERE key LIKE 'ark-call:%'")).toEqual({ n: 0 });
    await feed(app, press(OWNER, `ak:${src}:call`));
    const n = (await q<{ n: number }>("SELECT COUNT(*) AS n FROM effects WHERE key LIKE 'ark-call:%'"))!.n;
    expect(n).toBeGreaterThan(0);
    await feed(app, press(OWNER, `ak:${src}:call`)); // the same day: nothing is sent twice
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM effects WHERE key LIKE 'ark-call:%'"))!.n).toBe(n);
    await dispatchPending(app.db, app.tg, 60);
    expect(calls.some((c) => c.method === "sendMessage" && String(c.params.text).includes("https://new.example/club"))).toBe(true);
  });
});

describe("Ковчег: what the bot knows about me", () => {
  it("/knows counts what is kept, and each part can be removed with its button", async () => {
    const { app, calls } = await world();
    await env.DB.prepare("INSERT INTO skills(member_id, code, state) VALUES (?, 'accounting', 'confirmed')").bind(await idOf(1)).run();
    await feed(app, dm(1, "/knows"));
    const card = calls.filter((c) => c.params.chat_id === 1 && c.method === "sendMessage").at(-1)!;
    expect(card.params.text).toContain("What I know about you");
    expect(card.params.text).toContain("Skills on your profile: <b>1</b>");
    expect(JSON.stringify(card.params.reply_markup)).toContain("kn:skills");
    await feed(app, press(1, "kn:skills"));
    expect(await q("SELECT COUNT(*) AS n FROM skills WHERE member_id=?", await idOf(1))).toEqual({ n: 0 });
  });
});
