// Minimal A2A (agent-to-agent, https://a2a-protocol.org) adapter (plan §E.3, P14-12).
// It is a transport only: an A2A `message/send` must carry a signed nexus.v1 message as a data
// part, and goes through exactly the same checks as the REST routes. A2A adds no trust of its own.

import type { App } from "../bot";
import { newId } from "../util";
import type { MessageType } from "./envelope";
import { fedEnabled, nodeId, receive, type Received } from "./gateway";

const TYPES: MessageType[] = ["inquiry", "offer", "decline", "approval", "commitment", "withdraw"];

export function agentCard(app: App): Record<string, unknown> {
  const id = nodeId(app.env);
  return {
    name: app.env.COMMUNITY_LABEL || "Telepathy community node",
    description: "Community assistance gateway. Accepts signed nexus.v1 messages (see /.well-known/nexus-node.json). No unsigned requests, no people search.",
    url: `${id}/a2a`,
    version: "1.0.0",
    protocolVersion: "0.3.0",
    preferredTransport: "JSONRPC",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "nexus-opportunity",
        name: "Opportunity exchange",
        description: "Deliver a signed nexus.v1 inquiry, offer, decline, approval, commitment or withdraw message as a data part.",
        tags: ["nexus.v1", "community", "consent"],
      },
    ],
  };
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: { message?: { parts?: { kind?: string; data?: unknown }[] } } };

const rpcError = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Handle one JSON-RPC request. Returns the JSON-RPC response body and effect keys. */
export async function handleA2A(app: App, body: unknown): Promise<{ body: unknown; keys: string[] }> {
  if (!fedEnabled(app.env)) return { body: rpcError(null, -32601, "disabled"), keys: [] };
  const rpc = (body ?? {}) as Rpc;
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return { body: rpcError(rpc.id, -32600, "invalid request"), keys: [] };
  if (rpc.method !== "message/send") return { body: rpcError(rpc.id, -32601, "method not found"), keys: [] };
  const data = rpc.params?.message?.parts?.find((p) => p.kind === "data")?.data as { type?: MessageType; exchange_id?: string } | undefined;
  if (!data || !data.type || !TYPES.includes(data.type)) return { body: rpcError(rpc.id, -32602, "expected a nexus.v1 message in a data part"), keys: [] };
  const r: Received = await receive(app, data, { types: [data.type], id: data.exchange_id });
  return {
    body: {
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      result: { kind: "message", role: "agent", messageId: newId(), parts: [{ kind: "data", data: { status: r.status, ...r.body } }] },
    },
    keys: r.keys,
  };
}
