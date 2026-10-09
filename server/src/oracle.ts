import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { CrossbarClient } from "@switchboard-xyz/common";
import { AnchorUtils, Queue, Randomness, asV0Tx, getDefaultQueue } from "@switchboard-xyz/on-demand";
import { ORACLE_MODE, RPC } from "./config.js";
import { pool } from "./db.js";
import { pickWinner, randomSeed, type EpochView } from "./solana.js";

type SbProgram = Awaited<ReturnType<typeof AnchorUtils.loadProgramFromConnection>>;

let loaded: { program: SbProgram; queue: PublicKey } | null = null;

const CROSSBAR = "https://crossbar.switchboardlabs.xyz";

async function commitToOracle(program: SbProgram, randomness: Randomness, queue: PublicKey, payer: PublicKey) {
  const { oracle } = await new Queue(program, queue).selectRandomnessOracle(new CrossbarClient(CROSSBAR));
  return randomness.commitIx(queue, payer, oracle.pubkey);
}

function revealedSeed(value: unknown): Buffer | null {
  const bytes = Buffer.from(value as Uint8Array);
  if (bytes.length < 32) return null;
  const seed = Buffer.from(bytes.subarray(0, 32));
  if (seed.every((b) => b === 0)) return null;
  return seed;
}

async function switchboard(connection: Connection, payer: Keypair) {
  if (loaded) return loaded;
  const wallet = {
    payer,
    publicKey: payer.publicKey,
    signTransaction: async <T>(tx: T) => tx,
    signAllTransactions: async <T>(txs: T[]) => txs,
  };
  const program = await AnchorUtils.loadProgramFromConnection(
    connection,
    wallet as Parameters<typeof AnchorUtils.loadProgramFromConnection>[1],
  );
  const queue = await getDefaultQueue(RPC);
  loaded = { program, queue: queue.pubkey };
  return loaded;
}

async function sendVersioned(connection: Connection, payer: Keypair, ixs: Parameters<typeof asV0Tx>[0]["ixs"], extra: Keypair[] = []) {
  const tx = await asV0Tx({
    connection,
    ixs,
    signers: [payer, ...extra],
    computeUnitPrice: 50_000,
    computeUnitLimitMultiple: 1.3,
  });
  tx.sign([payer, ...extra]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

async function saveRequest(
  vaultId: string,
  epochId: string,
  status: string,
  request: string,
  secret: string,
  error: string | null,
) {
  await pool.query(
    `INSERT INTO oracle_requests (vault_id, epoch_id, seed_hex, request_pda, rng_secret, status, error, requested_at)
     VALUES ($1,$2,'',$3,$4,$5,$6,now())
     ON CONFLICT (vault_id, epoch_id) DO UPDATE SET
       request_pda = $3, rng_secret = $4, status = $5, error = $6`,
    [vaultId, epochId, request, secret, status, error],
  );
}

async function saveSeed(vaultId: string, epochId: string, seed: Buffer) {
  const hex = seed.toString("hex");
  await pool.query(
    `UPDATE oracle_requests
     SET status = 'fulfilled', seed_hex = $3, settle_seed_hex = $3, randomness_hex = $3, error = NULL, fulfilled_at = now()
     WHERE vault_id = $1 AND epoch_id = $2`,
    [vaultId, epochId, hex],
  );
}

export async function ensureOracle(connection: Connection, payer: Keypair, vaultId: string, epoch: EpochView) {
  const epochId = epoch.id.toString();
  const existing = await pool.query<{
    status: string;
    settle_seed_hex: string | null;
    request_pda: string | null;
    rng_secret: string | null;
  }>(
    `SELECT status, settle_seed_hex, request_pda, rng_secret
     FROM oracle_requests WHERE vault_id = $1 AND epoch_id = $2`,
    [vaultId, epochId],
  );
  const row = existing.rows[0];
  if (row?.settle_seed_hex) {
    const seed = Buffer.from(row.settle_seed_hex, "hex");
    return { seed, winner: pickWinner(epoch, seed), mode: row.status };
  }

  if (ORACLE_MODE === "trusted") {
    const seed = randomSeed();
    await pool.query(
      `INSERT INTO oracle_requests (vault_id, epoch_id, seed_hex, status, settle_seed_hex, requested_at, fulfilled_at)
       VALUES ($1,$2,$3,'trusted',$3,now(),now())
       ON CONFLICT (vault_id, epoch_id) DO UPDATE SET status = 'trusted', seed_hex = $3, settle_seed_hex = $3, fulfilled_at = now()`,
      [vaultId, epochId, seed.toString("hex")],
    );
    return { seed, winner: pickWinner(epoch, seed), mode: "trusted" };
  }

  const { program, queue } = await switchboard(connection, payer);
  let rng = row?.rng_secret ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(row.rng_secret) as number[])) : null;
  let account = row?.request_pda ? await connection.getAccountInfo(new PublicKey(row.request_pda)) : null;

  if (!rng || !row?.request_pda || !account) {
    rng = Keypair.generate();
    const [created, createIx] = await Randomness.create(program, rng, queue, payer.publicKey);
    const commitIx = await commitToOracle(program, created, queue, payer.publicKey);
    try {
      const createdSig = await sendVersioned(connection, payer, [createIx], [rng]);
      const committedSig = await sendVersioned(connection, payer, [commitIx]);
      await saveRequest(vaultId, epochId, "committed", rng.publicKey.toBase58(), "", null);
      return {
        pending: true,
        request: rng.publicKey.toBase58(),
        signature: `${createdSig} ${committedSig}`,
        mode: "switchboard",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await saveRequest(vaultId, epochId, "error", rng.publicKey.toBase58(), "", message);
      throw err;
    }
  }

  const randomness = new Randomness(program, new PublicKey(row.request_pda));
  const before = await randomness.loadData();
  if (Number(before.seedSlot) === 0) {
    const commitIx = await commitToOracle(program, randomness, queue, payer.publicKey);
    const sig = await sendVersioned(connection, payer, [commitIx]);
    await saveRequest(vaultId, epochId, "committed", row.request_pda, "", null);
    return { pending: true, request: row.request_pda, signature: sig, mode: "switchboard" };
  }
  if (Number(before.revealSlot) > 0) {
    const seed = revealedSeed(before.value);
    if (!seed) return { pending: true, request: row.request_pda, mode: "switchboard" };
    await saveSeed(vaultId, epochId, seed);
    return { seed, winner: pickWinner(epoch, seed), mode: "switchboard" };
  }

  try {
    const revealIx = await randomness.revealIx(payer.publicKey);
    const sig = await sendVersioned(connection, payer, [revealIx]);
    const after = await randomness.loadData();
    const seed = Number(after.revealSlot) > 0 ? revealedSeed(after.value) : null;
    if (!seed) return { pending: true, request: row.request_pda, signature: sig, mode: "switchboard" };
    await saveSeed(vaultId, epochId, seed);
    try {
      await sendVersioned(connection, payer, [await randomness.closeIx()]);
    } catch {
      // The draw seed is already stored. Rent reclaim can wait.
    }
    return { seed, winner: pickWinner(epoch, seed), mode: "switchboard" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(`UPDATE oracle_requests SET status = 'committed', error = $3 WHERE vault_id = $1 AND epoch_id = $2`, [
      vaultId,
      epochId,
      message,
    ]);
    return { pending: true, request: row.request_pda, mode: "switchboard", error: message };
  }
}

export async function commitFuture(connection: Connection, payer: Keypair, vaultId: string, epochId: bigint) {
  const slot = await connection.getSlot("confirmed");
  const { program, queue } = await switchboard(connection, payer);
  const epochKey = epochId.toString();
  const existing = await pool.query<{ request_pda: string | null; rng_secret: string | null }>(
    `SELECT request_pda, rng_secret FROM oracle_requests WHERE vault_id = $1 AND epoch_id = $2`,
    [vaultId, epochKey],
  );
  const row = existing.rows[0];
  if (row?.request_pda) {
    try {
      const randomness = new Randomness(program, new PublicKey(row.request_pda));
      const data = await randomness.loadData();
      const seedSlot = Number(data.seedSlot);
      const age = slot - seedSlot;
      if (seedSlot > 0 && Number(data.revealSlot) === 0 && (seedSlot > slot || age <= 300)) {
        return { randomness: randomness.pubkey };
      }
    } catch {
      // The old randomness account is gone. Commit a new one.
    }
  }
  const rng = Keypair.generate();
  const [created, createIx] = await Randomness.create(program, rng, queue, payer.publicKey);
  const commitIx = await commitToOracle(program, created, queue, payer.publicKey);
  const createdSig = await sendVersioned(connection, payer, [createIx], [rng]);
  const committedSig = await sendVersioned(connection, payer, [commitIx]);
  await saveRequest(vaultId, epochKey, "committed", rng.publicKey.toBase58(), "", null);
  const fresh = await created.loadData();
  if (Number(fresh.seedSlot) > 0 && Number(fresh.revealSlot) === 0) {
    return { randomness: rng.publicKey, signature: `${createdSig} ${committedSig}` };
  }
  return { pending: true as const, request: rng.publicKey.toBase58(), signature: `${createdSig} ${committedSig}` };
}

export async function revealBound(connection: Connection, payer: Keypair, randomnessKey: PublicKey) {
  const { program } = await switchboard(connection, payer);
  const randomness = new Randomness(program, randomnessKey);
  const before = await randomness.loadData();
  if (Number(before.revealSlot) > 0) {
    const seed = revealedSeed(before.value);
    if (!seed) return { pending: true as const, request: randomnessKey.toBase58() };
    return { seed };
  }
  const sig = await sendVersioned(connection, payer, [await randomness.revealIx(payer.publicKey)]);
  const after = await randomness.loadData();
  const seed = Number(after.revealSlot) > 0 ? revealedSeed(after.value) : null;
  if (!seed) return { pending: true as const, request: randomnessKey.toBase58(), signature: sig };
  return { seed, signature: sig };
}
