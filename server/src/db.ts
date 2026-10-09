import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DATABASE_URL } from "./config.js";
import { VAULTS } from "./catalog.js";

export const pool = new pg.Pool({ connectionString: DATABASE_URL });

export async function migrate() {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");
  await pool.query(sql);
  for (const vault of VAULTS) {
    await pool.query(
      `INSERT INTO vaults (id, base_symbol, quote_symbol, base_mint, quote_mint, quote_decimals, status, crop)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         base_symbol = EXCLUDED.base_symbol,
         quote_symbol = EXCLUDED.quote_symbol,
         base_mint = EXCLUDED.base_mint,
         quote_mint = EXCLUDED.quote_mint,
         quote_decimals = EXCLUDED.quote_decimals,
         status = EXCLUDED.status,
         crop = EXCLUDED.crop,
         updated_at = now()`,
      [
        vault.id,
        vault.baseSymbol,
        vault.quoteSymbol,
        vault.baseMint,
        vault.quoteMint,
        vault.quoteDecimals,
        vault.status,
        vault.crop,
      ],
    );
  }
}

export async function heartbeat(id: string, ok: boolean, detail?: string, error?: string) {
  await pool.query(
    `INSERT INTO keeper_heartbeats (id, last_run, last_ok, last_error, detail)
     VALUES ($1, now(), $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       last_run = now(), last_ok = $2, last_error = $3, detail = $4`,
    [id, ok, error ?? null, detail ?? null],
  );
}
