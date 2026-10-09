import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { LP_POOL, WATERFALL, originsForQuote, pots } from "./catalog.js";
import { pool } from "./db.js";
import { configPda, releaseIx, sendTx, tokenAmount } from "./solana.js";

const DUST = 100_000n;
const BUY_OF_RESERVE = 400n;
const RESERVE_BPS = 450n;
// OUTPUT_MINT: base58 mint bought with the backing slice. Leave unset to skip that swap.
function outputMint(): PublicKey | null {
  const raw = process.env.OUTPUT_MINT;
  return raw ? new PublicKey(raw) : null;
}

type Row = { watermark_raw: string; lp_quote_raw: string };

async function state(): Promise<Row> {
  const { rows } = await pool.query<Row>(
    `SELECT watermark_raw, lp_quote_raw FROM productive_wallet WHERE id = 1`,
  );
  return rows[0] ?? { watermark_raw: "0", lp_quote_raw: "0" };
}

async function save(watermark: bigint, lp: bigint, wallet: string) {
  await pool.query(
    `INSERT INTO productive_wallet (id, wallet, watermark_raw, lp_quote_raw, lp_pool)
     VALUES (1,$1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE SET
       wallet = $1, watermark_raw = $2, lp_quote_raw = $3, lp_pool = $4`,
    [wallet, watermark.toString(), lp.toString(), LP_POOL],
  );
}

async function jupiterSwap(connection: Connection, owner: Keypair, input: PublicKey, output: PublicKey, amount: bigint) {
  const quoteUrl =
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${input.toBase58()}` +
    `&outputMint=${output.toBase58()}&amount=${amount.toString()}&slippageBps=100`;
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) throw new Error(`jupiter quote ${quoteRes.status}`);
  const quote = (await quoteRes.json()) as {
    outAmount?: string;
    otherAmountThreshold?: string;
    outputMint?: string;
  };
  if (quote.outputMint !== output.toBase58() || !quote.outAmount) {
    throw new Error("jupiter quote does not match the swap");
  }
  const swapRes = await fetch("https://lite-api.jup.ag/swap/v1/swap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: owner.publicKey.toBase58(),
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!swapRes.ok) throw new Error(`jupiter swap ${swapRes.status}`);
  const body = (await swapRes.json()) as { swapTransaction?: string };
  if (!body.swapTransaction) throw new Error("jupiter returned no transaction");
  const tx = VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, "base64"));
  const minOut = BigInt(quote.otherAmountThreshold || quote.outAmount);
  await assertSwap(connection, tx, owner.publicKey, input, output, amount, minOut);
  tx.sign([owner]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

export async function routeProductive(
  connection: Connection,
  authority: Keypair,
  productive: Keypair,
  quote: PublicKey,
  base: PublicKey,
) {
  const actions: string[] = [];
  const dest = getAssociatedTokenAddressSync(quote, productive.publicKey, true);
  const reserve = await tokenAmount(connection, quote, configPda());
  if (reserve > DUST) {
    const create = createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey,
      dest,
      productive.publicKey,
      quote,
    );
    const sig = await sendTx(connection, authority, [create, await releaseIx(authority.publicKey, quote, dest)]);
    actions.push(`released reserve ${reserve} ${sig}`);
  }

  let bal = await tokenAmount(connection, quote, productive.publicKey);
  const row = await state();
  let watermark = BigInt(row.watermark_raw || "0");
  let lp = BigInt(row.lp_quote_raw || "0");

  if (lp === 0n && bal > DUST) {
    const origins = originsForQuote(quote.toBase58());
    const pot = pots().find((item) => item.quoteMint === quote.toBase58());
    const shares = pot
      ? await pool.query<{ origin_id: string; amount_raw: string }>(
          `SELECT origin_id, SUM(amount_raw::numeric)::text AS amount_raw
           FROM sweep_origins WHERE vault_id = $1 AND origin_id <> 'untagged'
           GROUP BY origin_id`,
          [pot.id],
        )
      : { rows: [] as { origin_id: string; amount_raw: string }[] };
    const known = shares.rows
      .map((row) => ({ origin: origins.find((item) => item.id === row.origin_id), amount: BigInt(row.amount_raw) }))
      .filter((row): row is { origin: (typeof origins)[number]; amount: bigint } => Boolean(row.origin && row.origin.baseMint));
    const tagged = known.reduce((sum, row) => sum + row.amount, 0n);
    if (known.length > 1 && tagged > 0n) {
      for (const row of known) {
        const part = (bal * row.amount) / tagged;
        const buy = (part * BUY_OF_RESERVE) / RESERVE_BPS;
        const slice = part - buy;
        if (buy > DUST) {
          const sig = await jupiterSwap(connection, productive, quote, new PublicKey(row.origin.baseMint!), buy);
          actions.push(`bought ${row.origin.baseSymbol} ${buy} ${sig}`);
        }
        actions.push(`reserved ${row.origin.baseSymbol} LP ${slice}`);
      }
      bal = await tokenAmount(connection, quote, productive.publicKey);
      watermark = bal;
      lp = bal;
      await save(watermark, lp, productive.publicKey.toBase58());
      return actions;
    }
    const buy = (bal * BUY_OF_RESERVE) / RESERVE_BPS;
    lp = bal - buy;
    if (buy > DUST) {
      const sig = await jupiterSwap(connection, productive, quote, base, buy);
      actions.push(`bought base with 4% ${buy} ${sig}`);
    }
    bal = await tokenAmount(connection, quote, productive.publicKey);
    watermark = bal;
    await save(watermark, lp, productive.publicKey.toBase58());
    actions.push(`reserved 0.5% ${lp} for LP ${LP_POOL}`);
    return actions;
  }

  if (bal > watermark + DUST) {
    const delta = bal - watermark;
    for (const sleeve of WATERFALL) {
      const part = (delta * BigInt(sleeve.bps)) / 10_000n;
      if (part <= 0n) continue;
      await pool.query(
        `INSERT INTO yield_sleeves (vault_id, source, epoch_id, sleeve, amount_raw)
         VALUES ('nearkat','yield',0,$1,$2)
         ON CONFLICT (vault_id, source, epoch_id, sleeve)
         DO UPDATE SET amount_raw = (yield_sleeves.amount_raw::numeric + EXCLUDED.amount_raw::numeric)::text`,
        [sleeve.sleeve, part.toString()],
      );
      if (sleeve.sleeve === "reinvest" && part > 1_000_000n) {
        const sig = await jupiterSwap(connection, productive, quote, base, part);
        actions.push(`reinvest ${part} ${sig}`);
      } else if (sleeve.sleeve === "fun_backing" && part > 1_000_000n) {
        const out = outputMint();
        if (!out) continue;
        const sig = await jupiterSwap(connection, productive, quote, out, part);
        actions.push(`backed output mint with ${part} ${sig}`);
      }
    }
    bal = await tokenAmount(connection, quote, productive.publicKey);
    watermark = bal;
    await save(watermark, lp, productive.publicKey.toBase58());
    actions.push(`routed yield ${delta}`);
  }
  return actions;
}

// Public program ids a swap is allowed to call. These are not deployment addresses.
const SWAP_PROGRAMS = new Set([
  "ComputeBudget111111111111111111111111111111",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "11111111111111111111111111111111",
]);

function accountAmount(account: { data: string[] | Buffer } | null | undefined) {
  if (!account) return 0n;
  const data = account.data;
  const buf = Array.isArray(data) ? Buffer.from(data[0], "base64") : Buffer.from(data);
  if (buf.length < 72) return 0n;
  return buf.readBigUInt64LE(64);
}

async function assertSwap(
  connection: Connection,
  tx: VersionedTransaction,
  owner: PublicKey,
  input: PublicKey,
  output: PublicKey,
  amountIn: bigint,
  minOut: bigint,
) {
  const lookups = [];
  for (const lookup of tx.message.addressTableLookups) {
    const table = await connection.getAddressLookupTable(lookup.accountKey);
    if (!table.value) throw new Error("jupiter lookup table missing");
    lookups.push(table.value);
  }
  const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: lookups });
  if (tx.message.header.numRequiredSignatures !== 1) throw new Error("jupiter tx has extra signers");
  const signer = keys.get(0);
  if (!signer?.equals(owner)) throw new Error("jupiter signer is not the productive wallet");
  for (const ix of tx.message.compiledInstructions) {
    const program = keys.get(ix.programIdIndex);
    if (!program || !SWAP_PROGRAMS.has(program.toBase58())) {
      throw new Error(`jupiter tx uses ${program?.toBase58() ?? "an unknown program"}`);
    }
  }
  const mintInfo = await connection.getAccountInfo(output);
  const outputProgram = mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const inputAta = getAssociatedTokenAddressSync(input, owner, true, TOKEN_PROGRAM_ID);
  const outputAta = getAssociatedTokenAddressSync(output, owner, true, outputProgram);
  const beforeIn = await tokenAmount(connection, input, owner);
  const beforeOutInfo = await connection.getAccountInfo(outputAta);
  const beforeOut = beforeOutInfo && beforeOutInfo.data.length >= 72 ? beforeOutInfo.data.readBigUInt64LE(64) : 0n;
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    accounts: { encoding: "base64", addresses: [inputAta, outputAta] },
  });
  if (sim.value.err) throw new Error("jupiter simulation failed");
  const inSim = sim.value.accounts?.[0] as { data: string[] } | null | undefined;
  const outSim = sim.value.accounts?.[1] as { data: string[] } | null | undefined;
  if (!outSim) throw new Error("jupiter simulation did not return the output account");
  if (!inSim && beforeIn > 0n) throw new Error("jupiter simulation did not return the input account");
  const afterIn = accountAmount(inSim);
  const afterOut = accountAmount(outSim);
  if (beforeIn - afterIn > amountIn) throw new Error("jupiter spends more than the quoted input");
  if (afterOut < beforeOut + minOut) throw new Error("jupiter output is below the minimum");
}
