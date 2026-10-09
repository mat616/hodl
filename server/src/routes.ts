import type { FastifyInstance } from "fastify";
import { Connection, PublicKey } from "@solana/web3.js";
import { pool } from "./db.js";
import { applyWallet, buildState, loadWalletSlice } from "./snapshot.js";

const STATE_TTL_MS = 10_000;
type Shared = Awaited<ReturnType<typeof buildState>>;
type Slice = Awaited<ReturnType<typeof loadWalletSlice>>;

let shared: { at: number; value: Shared } | null = null;
let sharedPending: Promise<Shared> | null = null;
const walletSlices = new Map<string, { at: number; value: Slice }>();
const walletPending = new Map<string, Promise<Slice>>();

async function sharedState(connection: Connection) {
  const fresh = Boolean(shared && Date.now() - shared.at < STATE_TTL_MS);
  if (!fresh && !sharedPending) {
    sharedPending = buildState(connection)
      .then((value) => {
        shared = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        sharedPending = null;
      });
  }
  if (shared) return shared.value;
  return sharedPending!;
}

async function sliceFor(connection: Connection, base: Shared, wallet: string) {
  const hit = walletSlices.get(wallet);
  if (hit && Date.now() - hit.at < STATE_TTL_MS) return hit.value;
  const existing = walletPending.get(wallet);
  if (existing) return existing;
  const pending = loadWalletSlice(connection, base, wallet)
    .then((value) => {
      walletSlices.set(wallet, { at: Date.now(), value });
      if (walletSlices.size > 500) {
        const now = Date.now();
        for (const [key, entry] of walletSlices) {
          if (now - entry.at >= STATE_TTL_MS) walletSlices.delete(key);
        }
      }
      return value;
    })
    .finally(() => {
      walletPending.delete(wallet);
    });
  walletPending.set(wallet, pending);
  return pending;
}

async function state(connection: Connection, wallet?: string) {
  const base = await sharedState(connection);
  if (!wallet) return base;
  const slice = await sliceFor(connection, base, wallet);
  return applyWallet(base, wallet, slice);
}

export function registerRoutes(app: FastifyInstance, connection: Connection) {
  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true };
  });

  app.get("/v1/state", async (req) => {
    const wallet = (req.query as { wallet?: string }).wallet;
    if (wallet) new PublicKey(wallet);
    return state(connection, wallet);
  });

  app.get("/v1/home", async (req) => {
    const wallet = (req.query as { wallet?: string }).wallet;
    const next = await state(connection, wallet);
    return next.home;
  });

  app.get("/v1/pools", async (req) => {
    const wallet = (req.query as { wallet?: string }).wallet;
    const next = await state(connection, wallet);
    return { pools: next.pools, slot: next.slot };
  });

  app.get("/v1/clash", async () => {
    const next = await state(connection);
    return next.clash;
  });

  app.get("/v1/engine", async () => {
    const next = await state(connection);
    return { engine: next.engine, reserve: next.reserve };
  });

  app.get("/v1/portfolio", async (req) => {
    const wallet = (req.query as { wallet?: string }).wallet;
    if (!wallet) return { portfolio: null };
    const next = await state(connection, wallet);
    return { portfolio: next.portfolio, pools: next.pools };
  });

  app.get("/v1/keeper", async () => {
    const { rows } = await pool.query("SELECT * FROM keeper_heartbeats ORDER BY id");
    return { jobs: rows };
  });

  const watchHits = new Map<string, number[]>();
  app.post("/v1/watch", async (req, reply) => {
    const ip = req.ip || "unknown";
    const now = Date.now();
    const recent = (watchHits.get(ip) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= 10) {
      reply.code(429);
      return { error: "slow down" };
    }
    recent.push(now);
    watchHits.set(ip, recent);
    const wallet = (req.body as { wallet?: string })?.wallet;
    if (!wallet) throw new Error("wallet required");
    new PublicKey(wallet);
    const existing = await pool.query(`SELECT 1 FROM watch_wallets WHERE wallet = $1`, [wallet]);
    if (existing.rowCount === 0) {
      const count = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM watch_wallets`);
      if ((count.rows[0]?.n ?? 0) >= 500) {
        reply.code(429);
        return { error: "watch list is full" };
      }
    }
    await pool.query(
      `INSERT INTO watch_wallets (wallet) VALUES ($1) ON CONFLICT DO NOTHING`,
      [wallet],
    );
    return { ok: true, wallet };
  });
}
