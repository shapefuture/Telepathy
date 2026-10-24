# nexus.v1: integrating with Telepathy nodes

For community platforms that want to exchange help requests with Telepathy communities without
adopting Telepathy (plan §K.1 "Embedded Platform/API").

| File | What |
|---|---|
| `nexus-v1.schema.json` | message format (JSON Schema) |
| `openapi.yaml` | HTTP routes and responses |
| `sdk/nexus.mjs` (+ `.d.mts`) | zero-dependency JS: canonical JSON, Ed25519 sign/verify, builders, `send` |
| `test-vectors/nexus-v1.json` | fixed key, message, canonical form, signature, and pass/fail cases |
| `../src/telepathy/federation/nexus.py` | an independent Python implementation that passes the vectors |

## Conformance

An implementation conforms when it:

1. reproduces `canonical` and `signature` from the vectors exactly (Ed25519 is deterministic);
2. returns the listed result for every `verify_cases` and `shape_cases` entry at `now`;
3. sends only `job`, `summary`, `criteria` in inquiries, with `forwarding: "prohibited"` and `max_hops: 1`;
4. deduplicates by (issuer, nonce) and treats a repeat as success;
5. deletes the summary and contact on `withdraw`.

Run the checks: `cd worker && npm test` (Worker and SDK) and `uv run pytest tests/test_nexus_conformance.py` (Python).

## Minimal example

```js
import { buildMessage, inquiryBody, sign, send } from "./sdk/nexus.mjs";
const msg = buildMessage({ type: "inquiry", exchangeId: crypto.randomUUID(), issuer: "https://my.example",
  recipient: "https://club-a.example", body: inquiryBody({ missionRef: crypto.randomUUID(), job: "accounting",
  summary: "Bookkeeping help for a small bakery" }) });
console.log(await send("https://club-a.example", await sign(msg, MY_PRIVATE_KEY)));
```

Canonical JSON: keys sorted, no whitespace, strings as `JSON.stringify` writes them, integers
only (no floats).

## Hydra (P16)

`sdk/hydra.mjs` checks what a club publishes on its other heads, without Telepathy: failure
domains and the hydra index, signed notices, follow receipts, heartbeats, anchor records, the newest
valid address list among several sources (`bestManifest`), escrow decryption, Shamir recombination
and TOTP. Vectors: `test-vectors/hydra-v1.json` (regenerate with `hydra-generate.mjs`). The Worker
(`worker/test/hydra.test.ts`) and Python (`tests/test_hydra_conformance.py`) are both tested against
them.
