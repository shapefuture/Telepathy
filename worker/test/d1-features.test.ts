import { env } from "cloudflare:test";
import { expect, it } from "vitest";

it("D1 supports external-content FTS5, triggers and fts5vocab", async () => {
  const db = env.DB;
  await db.prepare("INSERT INTO passages(source_id,msg_id,body,event_at) VALUES ('s',1,'бухгалтера Анна','t')").run();
  await db.prepare("INSERT INTO passages(source_id,msg_id,body,event_at) VALUES ('s',2,'accountant Dana','t')").run();
  const hit = await db.prepare("SELECT rowid FROM passages_fts WHERE passages_fts MATCH ?").bind('"бухгалт"*').all();
  expect(hit.results.length).toBe(1);
  await db.prepare("UPDATE passages SET body='accountant Bob' WHERE msg_id=2").run();
  const old = await db.prepare("SELECT rowid FROM passages_fts WHERE passages_fts MATCH 'dana'").all();
  expect(old.results.length).toBe(0);
  await db.prepare("UPDATE passages SET removed_at='x', body=NULL WHERE msg_id=1").run();
  const gone = await db.prepare("SELECT rowid FROM passages_fts WHERE passages_fts MATCH '\"анна\"'").all();
  expect(gone.results.length).toBe(0);
  const vocab = await db.prepare("SELECT term FROM passages_vocab WHERE term >= 'acc' AND term < 'acd'").all();
  expect(vocab.results.map((r) => r.term)).toEqual(["accountant"]);
});
