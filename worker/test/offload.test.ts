import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureMember, readable } from "../src/acl";
import { handleFetch, makeApp } from "../src/index";
import { removeMessage } from "../src/ingest";
import { answer } from "../src/search";
import { enableGroup, fakeTelegram, feed, groupMsg } from "./helpers";

const ON = { ...env, OFFLOAD_DOCUMENTS: "true" };
const auth = { authorization: "Bearer test-admin-token", "content-type": "application/json" };
const pdf = (id: string) => ({ document: { file_id: id, file_name: "plan.pdf", file_size: 50_000 } });
const admin = (path: string, init: RequestInit = {}, e = ON) => handleFetch(new Request(`https://bot.example${path}`, init), e as any);
const queued = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM doc_queue").first<{ n: number }>())!.n;

describe("document offload to GitHub Actions", () => {
  it("is off when OFFLOAD_DOCUMENTS isn't \"true\": heavy documents are not queued", async () => {
    const app = makeApp({ ...env, OFFLOAD_DOCUMENTS: "false" } as any, fakeTelegram().fetcher);
    await enableGroup(app);
    await feed(app, groupMsg(5, "the plan", pdf("F1")));
    expect(await queued()).toBe(0);
  });

  it("queues PDF/DOCX/PPTX when enabled, and the result becomes searchable", async () => {
    const app = makeApp(ON as any, fakeTelegram().fetcher);
    await enableGroup(app);
    const m = groupMsg(5, "the plan", pdf("F1"));
    await feed(app, m);
    await feed(app, m); // replay doesn't duplicate
    expect(await queued()).toBe(1);

    expect((await admin("/admin/docs/pending")).status).toBe(401);
    const pending = (await (await admin("/admin/docs/pending", { headers: auth })).json()) as any;
    expect(pending.documents).toHaveLength(1);
    const d = pending.documents[0];
    expect(d).toMatchObject({ file_id: "F1", file_name: "plan.pdf" });

    const post = (body: unknown) => admin("/admin/docs/result", { method: "POST", headers: auth, body: JSON.stringify(body) });
    const r = (await (await post({ source_id: d.source_id, msg_id: d.msg_id, status: "done", chunks: [{ locator: "p. 2", text: "The budget for the hackathon is 5000 shekels." }] })).json()) as any;
    expect(r).toMatchObject({ ok: true, stored: 1, status: "done" });
    const again = (await (await post({ source_id: d.source_id, msg_id: d.msg_id, status: "done", chunks: [{ locator: null, text: "dup" }] })).json()) as any;
    expect(again.note).toBe("already handled");

    const a = await answer(env.DB, await readable(env.DB, await ensureMember(env.DB, 5)), "hackathon budget");
    expect(a.status).toBe("answered");
    expect(a.quotes[0]!.label).toBe("plan.pdf · p. 2");
  });

  it("removed messages are never served or stored (C06); failures retry up to 3 times", async () => {
    const app = makeApp(ON as any, fakeTelegram().fetcher);
    await enableGroup(app);
    const m = groupMsg(5, "doc", pdf("F2"));
    await feed(app, m);
    const pending = async () => ((await (await admin("/admin/docs/pending", { headers: auth })).json()) as any).documents;
    const d = (await pending())[0];
    const post = (body: unknown) => admin("/admin/docs/result", { method: "POST", headers: auth, body: JSON.stringify(body) });
    await post({ ...d, status: "failed", error: "parse error" });
    expect(await pending()).toHaveLength(1); // retried
    await post({ ...d, status: "failed" });
    await post({ ...d, status: "failed" });
    expect(await pending()).toHaveLength(0); // gave up after 3

    const m2 = groupMsg(5, "doc2", pdf("F3"));
    await feed(app, m2);
    await removeMessage(env.DB, d.source_id, m2.message.message_id);
    expect(await pending()).toHaveLength(0);
    const r = (await (await post({ source_id: d.source_id, msg_id: m2.message.message_id, status: "done", chunks: [{ locator: null, text: "secret" }] })).json()) as any;
    expect(r).toMatchObject({ stored: 0, status: "skipped" });
  });
});
