import { pool } from "./db.js";
import { REWARDS_API } from "./config.js";
import { VAULTS } from "./catalog.js";
import { heartbeat } from "./db.js";

type RewardsOverview = {
  recentDistributions?: Array<{
    signature?: string;
    tx?: string;
    mint?: string;
    quoteMint?: string;
    amount?: string | number;
    raw?: string | number;
    timestamp?: string;
    createdAt?: string;
    at?: string;
  }>;
};

export async function pollDistributions() {
  if (!REWARDS_API) return [];
  const urls = [`${REWARDS_API.replace(/\/$/, "")}/rewards?limit=100`];
  let body: RewardsOverview | null = null;
  let lastErr = "";
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) {
        lastErr = `${res.status} ${url}`;
        continue;
      }
      body = (await res.json()) as RewardsOverview;
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  if (!body) {
    await heartbeat("rewards", false, undefined, lastErr || "rewards fetch failed");
    return [];
  }

  const rows = body.recentDistributions ?? [];
  const fresh: string[] = [];
  for (const row of rows) {
    const signature = String(row.signature || row.tx || "");
    if (!signature) continue;
    const baseMint = String(row.mint || "");
    const origin = VAULTS.find((v) => v.baseMint === baseMint || v.originMint === baseMint);
    const quoteMint = String(row.quoteMint || origin?.quoteMint || "");
    const vault = origin ?? VAULTS.find((v) => v.quoteMint === quoteMint);
    const occurred = row.timestamp || row.createdAt || row.at || null;
    const raw = row.raw ?? row.amount ?? null;
    const inserted = await pool.query(
      `INSERT INTO distributions (signature, vault_id, quote_mint, base_mint, occurred_at, raw_amount)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (signature) DO UPDATE SET base_mint = COALESCE(distributions.base_mint, EXCLUDED.base_mint)
       WHERE distributions.base_mint IS NULL
       RETURNING signature`,
      [signature, vault?.id ?? null, quoteMint || null, origin?.baseMint ?? (baseMint || null), occurred, raw === null ? null : String(raw)],
    );
    if (inserted.rowCount) fresh.push(signature);
  }

  for (const vault of VAULTS) {
    if (!vault.originMint) continue;
    try {
      const res = await fetch(`${REWARDS_API}/tokens/${vault.originMint}/rewards`);
      if (!res.ok) continue;
      const json = (await res.json()) as { lastPayoutAt?: string; lastPayout?: string };
      const at = json.lastPayoutAt || json.lastPayout;
      if (at) {
        await pool.query(
          `INSERT INTO distributions (signature, vault_id, quote_mint, occurred_at)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (signature) DO NOTHING`,
          [`last:${vault.id}:${at}`, vault.id, vault.quoteMint, at],
        );
      }
    } catch {
      // optional per-token probe
    }
  }

  await heartbeat("rewards", true, `${rows.length} recent, ${fresh.length} new`);
  return fresh;
}
