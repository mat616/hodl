import { pool } from "./db.js";
import { VAULTS } from "./catalog.js";

// Map a mint (base58) to a CoinGecko id when the price API does not know that mint.
const COINGECKO: Record<string, string> = {};

export async function refreshPrices() {
  const mints = [
    ...new Set(
      VAULTS.flatMap((v) => [v.quoteMint, v.baseMint]).filter((m): m is string => Boolean(m)),
    ),
  ];
  const byMint = new Map<string, number>();

  try {
    const quoted = await jupiterPrices(mints);
    for (const [mint, usd] of quoted) byMint.set(mint, usd);
  } catch {
    // fall through to CoinGecko
  }

  const missing = mints.filter((m) => !byMint.has(m) && COINGECKO[m]);
  if (missing.length) {
    try {
      const ids = [...new Set(missing.map((m) => COINGECKO[m]))].join(",");
      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
      if (res.ok) {
        const json = (await res.json()) as Record<string, { usd?: number }>;
        for (const mint of missing) {
          const price = json[COINGECKO[mint]]?.usd;
          if (price && price > 0) byMint.set(mint, price);
        }
      }
    } catch {
      // keep whatever we have
    }
  }

  for (const [mint, usd] of byMint) {
    await pool.query(
      `INSERT INTO prices (mint, usd, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (mint) DO UPDATE SET usd = $2, updated_at = now()`,
      [mint, usd],
    );
  }
  return byMint;
}

async function jupiterPrices(mints: string[]) {
  const byMint = new Map<string, number>();
  if (!mints.length) return byMint;
  const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mints.join(",")}`);
  if (!res.ok) return byMint;
  const json = (await res.json()) as Record<string, { usdPrice?: number } | null>;
  for (const mint of mints) {
    const price = Number(json[mint]?.usdPrice);
    if (Number.isFinite(price) && price > 0) byMint.set(mint, price);
  }
  return byMint;
}

export async function priceMap() {
  const { rows } = await pool.query<{ mint: string; usd: string }>("SELECT mint, usd FROM prices");
  const known = new Map(rows.map((r) => [r.mint, Number(r.usd)]));
  return fillMissing(known);
}

let filledAt = 0;
let filled = new Map<string, number>();

async function fillMissing(known: Map<string, number>) {
  const missing = [
    ...new Set(VAULTS.flatMap((v) => [v.quoteMint, v.baseMint]).filter((m): m is string => Boolean(m))),
  ].filter((mint) => !(known.get(mint) && known.get(mint)! > 0));
  if (!missing.length) return known;
  if (Date.now() - filledAt > 60_000) {
    filledAt = Date.now();
    filled = new Map();
    try {
      filled = await jupiterPrices(missing);
    } catch {
      filled = new Map();
    }
  }
  const out = new Map(known);
  for (const [mint, usd] of filled) if (!(out.get(mint) && out.get(mint)! > 0)) out.set(mint, usd);
  return out;
}

export function usdFromRaw(raw: bigint | string, decimals: number, usd: number | undefined) {
  const n = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  if (!usd || usd <= 0) return 0;
  return Number(n) / 10 ** decimals * usd;
}

export function uiAmount(raw: bigint | string, decimals: number) {
  const n = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const frac = (n % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
