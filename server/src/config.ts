import { existsSync, readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";

// PROGRAM_ID: base58 id of this program. The placeholder is not a deployable program.
export const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "11111111111111111111111111111111");
export const RPC = process.env.RPC_URL || "https://solana-rpc.publicnode.com";
// RPC_FALLBACK: optional RPC URL used when the primary RPC is rate limited.
export const RPC_FALLBACK = process.env.RPC_FALLBACK || "";

export const rpcFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (!RPC_FALLBACK) return res;
  const statusLimited = res.status === 429 || res.status === 403;
  const bodyLimited = !statusLimited && /rate limit|too many requests|connection rate limits/i.test(await res.clone().text());
  if (!statusLimited && !bodyLimited) return res;
  return fetch(RPC_FALLBACK, init);
};
export const PORT = Number(process.env.PORT || "8787");
export const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://dev:dev@127.0.0.1:5433/dev";
export const LOOP_MS = Number(process.env.KEEPER_INTERVAL_MS || "20000");
export const DEPOSIT_MINUTES = Number(process.env.KEEPER_DEPOSIT_MINUTES || "10");
export const ORACLE_MODE = (process.env.ORACLE_MODE === "trusted" ? "trusted" : "switchboard") as
  | "switchboard"
  | "trusted";
export const SEND = process.env.KEEPER_SEND !== "0";
// REWARDS_API: base URL of the rewards API, with no trailing slash. Leave empty to skip polling.
export const REWARDS_API = process.env.REWARDS_API || "";

const KEY_CANDIDATES = [process.env.KEEPER_KEY, "/keys/keeper.json"].filter((p): p is string => Boolean(p));

export function loadProductive(): Keypair | null {
  const inline = process.env.PRODUCTIVE_KEY_JSON;
  if (inline) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(inline) as number[]));
  }
  const path = process.env.PRODUCTIVE_KEY;
  if (!path || !existsSync(path)) return null;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

export function loadKeeper(): Keypair | null {
  const inline = process.env.KEEPER_KEY_JSON;
  if (inline) {
    const secret = Uint8Array.from(JSON.parse(inline) as number[]);
    return Keypair.fromSecretKey(secret);
  }
  const path = KEY_CANDIDATES.find((p) => existsSync(p));
  if (!path) return null;
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
  return Keypair.fromSecretKey(secret);
}

export function keeperKeyPath(): string | null {
  return KEY_CANDIDATES.find((p) => existsSync(p)) ?? null;
}
