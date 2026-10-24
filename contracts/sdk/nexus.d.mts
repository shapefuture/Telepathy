export declare const SCHEMA: "nexus.v1";
export type MessageType = "inquiry" | "offer" | "decline" | "approval" | "commitment" | "withdraw" | "notice";
export interface NexusMessage {
  schema: "nexus.v1";
  type: MessageType;
  exchange_id: string;
  issuer_org: string;
  recipient_org: string;
  issued_at: string;
  expires_at: string;
  nonce: string;
  body: Record<string, unknown>;
  signature?: string;
}
export declare function canonical(v: unknown): string;
export declare function generateKeys(): Promise<{ privateKey: string; publicKey: string }>;
export declare function pkcs8FromSeed(seed: Uint8Array | number[]): string;
export declare function sign(msg: NexusMessage, privateKeyB64: string): Promise<NexusMessage>;
export declare function verify(msg: NexusMessage, publicKeyB64: string): Promise<boolean>;
export declare function buildMessage(o: { type: MessageType; exchangeId: string; issuer: string; recipient: string; body: Record<string, unknown>; ttlMs?: number; now?: number; nonce?: string }): NexusMessage;
export declare function inquiryBody(o: { missionRef: string; job: string; summary: string; criteria?: Record<string, unknown>; policyVersion?: number }): Record<string, unknown>;
export declare function pathFor(msg: NexusMessage): string;
export declare function send(endpoint: string, signed: NexusMessage, fetchImpl?: typeof fetch): Promise<{ status: number; body: unknown }>;
export interface PubKey { keyid: string; key: string }
export interface Signed<T> { signed: T; signatures: { keyid: string; sig: string }[] }
export type Verdict = { ok: true; relocation?: boolean } | { ok: false; reason: string };
export declare function keyId(publicKeyB64: string): Promise<string>;
export declare function countValid(doc: Signed<unknown>, keys: PubKey[]): Promise<number>;
export declare function verifyRoot(doc: Signed<any>, trusted: Signed<any> | null, now?: string): Promise<Verdict>;
export declare function verifyDestinations(doc: Signed<any>, root: Signed<any>, last: Signed<any> | null, now?: string): Promise<Verdict>;
export declare function verifyPass(pass: Signed<any>, issuerRoot: Signed<any>, me: string, now?: string): Promise<{ ok: boolean; reason?: string; claim?: any }>;
export declare function followStateFrom(bundles: Signed<any>[]): Record<string, string>;
