import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { originsForQuote } from "./catalog.js";
import { pool } from "./db.js";

export async function rememberOrigin(vaultId: string, epochId: bigint, originId: string, amount: bigint) {
  if (amount <= 0n) return;
  await pool.query(
    `INSERT INTO sweep_origins (vault_id, epoch_id, origin_id, amount_raw)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (vault_id, epoch_id, origin_id)
     DO UPDATE SET amount_raw = (sweep_origins.amount_raw::numeric + EXCLUDED.amount_raw::numeric)::text`,
    [vaultId, epochId.toString(), originId, amount.toString()],
  );
}

export async function attributeSweep(
  connection: Connection,
  wallet: PublicKey,
  quoteMint: PublicKey,
  vaultId: string,
  epochId: bigint,
  swept: bigint,
) {
  const origins = originsForQuote(quoteMint.toBase58());
  if (origins.length <= 1) {
    await rememberOrigin(vaultId, epochId, origins[0]?.id ?? vaultId, swept);
    return [`${origins[0]?.baseSymbol ?? vaultId} ${swept}`];
  }

  const ata = getAssociatedTokenAddressSync(quoteMint, wallet, true);
  const signatures = await connection.getSignaturesForAddress(ata, { limit: 25 });
  const tagged = new Map<string, bigint>();
  let used = 0n;
  for (const row of signatures) {
    if (used >= swept) break;
    const found = await pool.query<{ base_mint: string | null }>(
      `SELECT base_mint FROM distributions WHERE signature = $1`,
      [row.signature],
    );
    const base = found.rows[0]?.base_mint;
    const origin = origins.find((item) => item.baseMint === base);
    if (!origin) continue;
    const got = await inflow(connection, row.signature, wallet, quoteMint);
    if (got <= 0n) continue;
    const take = got > swept - used ? swept - used : got;
    tagged.set(origin.id, (tagged.get(origin.id) ?? 0n) + take);
    used += take;
  }
  const notes: string[] = [];
  for (const [originId, amount] of tagged) {
    await rememberOrigin(vaultId, epochId, originId, amount);
    notes.push(`${originId} ${amount}`);
  }
  if (used < swept) {
    await rememberOrigin(vaultId, epochId, "untagged", swept - used);
    notes.push(`untagged ${swept - used}`);
  }
  return notes;
}

async function inflow(connection: Connection, signature: string, wallet: PublicKey, mint: PublicKey) {
  const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
  const meta = tx?.meta;
  if (!meta) return 0n;
  const delta = (rows: typeof meta.preTokenBalances) =>
    (rows ?? [])
      .filter((row) => row.owner === wallet.toBase58() && row.mint === mint.toBase58())
      .reduce((sum, row) => sum + BigInt(row.uiTokenAmount.amount), 0n);
  const change = delta(meta.postTokenBalances) - delta(meta.preTokenBalances);
  return change > 0n ? change : 0n;
}
