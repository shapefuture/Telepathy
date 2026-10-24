import type { Signed, Verdict } from "./nexus.mjs";
export interface PersonHeads { id: string; heads: string[][]; buddies?: string[] }
export interface HydraIndex { index: number; atLeast: boolean; worst: string[]; cutOff: number; people: number }
export interface EscrowEnvelope { schema: "nexus.escrow.v1"; org: string; created_at: string; sha256: string; iv: string; ct: string; recipients: { kid: string; epk: string; iv: string; wrapped: string }[] }
export interface Share { k: number; x: number; y: Uint8Array }
export declare function headDomains(kind: "telegram" | "email" | "webpush" | "ntfy" | "matrix" | "sms", address: string, opts?: { mx?: string | null; senders?: string[]; matrixServer?: string }): string[];
export declare function expandDomains(base: string[], registry?: Record<string, string[]>): string[];
export declare function independentCount(heads: string[][]): number;
export declare function hydraIndex(graph: PersonHeads[], opts?: { threshold?: number; maxK?: number }): HydraIndex;
export declare function verifyNotice(doc: Signed<any>, root: Signed<any>): Promise<Verdict>;
export declare function verifyReceipt(doc: Signed<any>, root: Signed<any>): Promise<boolean>;
export declare function followStateFromReceipts(receipts: Signed<any>[]): Record<string, string>;
export declare function verifyHeartbeat(doc: Signed<any>, root: Signed<any>): Promise<boolean>;
export declare function manifestHash(m: Signed<any>): Promise<string>;
export declare function anchorRecord(root: Signed<any>, m: Signed<any>): Promise<string>;
export declare function parseAnchor(rec: string): Record<string, string> | null;
export declare function checkAnchor(rec: string, root: Signed<any>, m: Signed<any>): Promise<Verdict>;
export declare function bestManifest(candidates: { root: Signed<any>; destinations: Signed<any> }[], pinnedRoot: Signed<any>, last?: Signed<any> | null, now?: string): Promise<{ root: Signed<any>; destinations: Signed<any>; relocation: boolean } | null>;
export declare function decryptEscrow(env: EscrowEnvelope, privateKeyB64: string): Promise<string>;
export declare function decodeShare(t: string): Share;
export declare function encodeShare(s: Share): string;
export declare function shamirCombine(shares: (Share | string)[]): Uint8Array;
export declare function totp(secret: Uint8Array, step: number, digits?: number): Promise<string>;
