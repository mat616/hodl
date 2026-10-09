import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { routeProductive } from "./acquire.js";
import { DEPOSIT_MINUTES, SEND, loadProductive } from "./config.js";
import { LIVE_VAULT, pots, vaultByQuote } from "./catalog.js";
import { attributeSweep } from "./origins.js";
import { heartbeat, pool } from "./db.js";
import { commitFuture, revealBound } from "./oracle.js";
import { refreshPrices } from "./prices.js";
import { pollDistributions } from "./rewards.js";
import {
  allowanceFor,
  ata,
  closeIx,
  configPda,
  recoverIx,
  decodeConfig,
  decodeEpoch,
  drawFrom,
  epochPda,
  openIx,
  pickWinner,
  sendTx,
  settleIx,
  sweepIx,
  tokenAmount,
  type ConfigView,
  type EpochView,
} from "./solana.js";

export type TickResult = {
  slot: number;
  actions: string[];
};

async function upsertEpoch(vaultId: string, epoch: EpochView) {
  await pool.query(
    `INSERT INTO epochs (
       vault_id, epoch_id, status, total_raw, total_weight, draw_slot, depositor_count,
       winner, prize_raw, reserve_cut_raw, treasury_cut_raw, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
     ON CONFLICT (vault_id, epoch_id) DO UPDATE SET
       status = $3, total_raw = $4, total_weight = $5, draw_slot = $6, depositor_count = $7,
       winner = $8, prize_raw = $9, reserve_cut_raw = $10, treasury_cut_raw = $11, updated_at = now()`,
    [
      vaultId,
      epoch.id.toString(),
      epoch.status,
      epoch.total.toString(),
      epoch.totalWeight.toString(),
      epoch.drawSlot.toString(),
      epoch.count,
      epoch.winner.equals(PublicKey.default) ? null : epoch.winner.toBase58(),
      epoch.prize.toString(),
      epoch.reserveCut.toString(),
      epoch.treasuryCut.toString(),
    ],
  );
  await pool.query(`DELETE FROM depositors WHERE vault_id = $1 AND epoch_id = $2`, [vaultId, epoch.id.toString()]);
  for (const row of epoch.depositors) {
    await pool.query(
      `INSERT INTO depositors (vault_id, epoch_id, wallet, amount_raw, weight, refunded)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [vaultId, epoch.id.toString(), row.wallet.toBase58(), row.amount.toString(), row.weight.toString(), row.refunded],
    );
  }
  await bookAcquisition(vaultId, epoch);
}

async function syncHistory(connection: Connection, vaultId: string, nextEpoch: bigint) {
  for (let id = 1n; id < nextEpoch; id++) {
    const info = await connection.getAccountInfo(epochPda(id));
    if (!info) continue;
    await upsertEpoch(vaultId, decodeEpoch(info.data as Buffer));
  }
}

async function sweepCreditSlot(connection: Connection, signature: string) {
  const tx = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  return tx?.slot ?? null;
}

function sliceWeight(amount: bigint, drawSlot: bigint, slot: number) {
  if (drawSlot <= BigInt(slot)) return 0n;
  return amount * (drawSlot - BigInt(slot));
}

async function recordSweep(
  vaultId: string,
  epoch: EpochView,
  wallet: PublicKey,
  amount: bigint,
  signature: string,
  slot: number | null,
) {
  const weight = slot === null ? null : sliceWeight(amount, epoch.drawSlot, slot);
  await pool.query(
    `INSERT INTO sweeps (vault_id, epoch_id, wallet, amount_raw, signature, slot, weight)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (signature) DO NOTHING`,
    [vaultId, epoch.id.toString(), wallet.toBase58(), amount.toString(), signature, slot, weight],
  );
}

async function bookAcquisition(vaultId: string, epoch: EpochView) {
  if (epoch.status !== "Settled" || epoch.reserveCut <= 0n) return;
  await pool.query(
    `INSERT INTO yield_sleeves (vault_id, source, epoch_id, sleeve, amount_raw)
     VALUES ($1,'acquisition',$2,'buy_base',$3)
     ON CONFLICT (vault_id, source, epoch_id, sleeve) DO NOTHING`,
    [vaultId, epoch.id.toString(), epoch.reserveCut.toString()],
  );
}

async function watched(authority: PublicKey) {
  const { rows } = await pool.query<{ wallet: string }>("SELECT wallet FROM watch_wallets");
  const out = [authority];
  const seen = new Set([authority.toBase58()]);
  for (const row of rows) {
    try {
      const key = new PublicKey(row.wallet);
      if (seen.has(key.toBase58())) continue;
      seen.add(key.toBase58());
      out.push(key);
    } catch {
      // skip bad rows
    }
  }
  return out;
}

async function findDelegates(connection: Connection, mint: PublicKey, delegate: PublicKey, authority: PublicKey) {
  const found: { owner: PublicKey; pull: bigint }[] = [];
  const seen = new Set<string>();
  for (const owner of await watched(authority)) {
    const row = await allowanceFor(connection, mint, delegate, owner);
    if (!row) continue;
    seen.add(owner.toBase58());
    found.push({ owner, pull: row.pull });
  }
  try {
    const tagAndKey = Buffer.concat([Buffer.from([1, 0, 0, 0]), delegate.toBuffer()]);
    const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      commitment: "confirmed",
      filters: [
        { dataSize: 165 },
        { memcmp: { offset: 0, bytes: mint.toBase58() } },
        { memcmp: { offset: 72, bytes: tagAndKey.toString("base64"), encoding: "base64" } },
      ],
    });
    for (const { account } of accounts) {
      const owner = new PublicKey(account.data.subarray(32, 64));
      if (seen.has(owner.toBase58())) continue;
      const amount = account.data.readBigUInt64LE(64);
      const delegated = account.data.readBigUInt64LE(121);
      const pull = amount < delegated ? amount : delegated;
      if (pull > 0n) found.push({ owner, pull });
    }
  } catch {
    // public RPC often rejects the scan; watched wallets still work
  }
  return found;
}

export async function tick(connection: Connection, payer: Keypair | null): Promise<TickResult> {
  const actions: string[] = [];
  const slot = await connection.getSlot("confirmed");
  const slotN = BigInt(slot);
  await refreshPrices();
  const fresh = await pollDistributions();
  if (fresh.length) actions.push(`distributions ${fresh.length}`);

  const cfgInfo = await connection.getAccountInfo(configPda());
  if (!cfgInfo) {
    await heartbeat("keeper", true, "vault uninitialized");
    return { slot, actions: ["vault uninitialized"] };
  }
  const config = decodeConfig(cfgInfo.data as Buffer);
  const vault = vaultByQuote(config.mint.toBase58()) ?? LIVE_VAULT;
  const pot = pots().find((item) => item.quoteMint === config.mint.toBase58());
  const originVaultId = pot?.id ?? vault.id;
  const isAuthority = Boolean(payer && payer.publicKey.equals(config.authority));
  await syncHistory(connection, vault.id, config.nextEpoch);

  let collecting: EpochView | null = null;
  if (config.collecting > 0n) {
    const info = await connection.getAccountInfo(epochPda(config.collecting));
    collecting = info ? decodeEpoch(info.data as Buffer) : null;
    if (collecting) await upsertEpoch(vault.id, collecting);
  }

  const prevId = config.collecting > 1n ? config.collecting - 1n : config.nextEpoch > 1n ? config.nextEpoch - 1n : 0n;
  let previous: EpochView | null = null;
  if (prevId > 0n) {
    const info = await connection.getAccountInfo(epochPda(prevId));
    previous = info ? decodeEpoch(info.data as Buffer) : null;
    if (previous) {
      await upsertEpoch(vault.id, previous);
      await bookAcquisition(vault.id, previous);
    }
  }

  if (payer && SEND) {
    const closed = await fundedClosed(connection, config.nextEpoch);
    for (const epoch of closed) {
      if (!epoch.randomness || epoch.randomness.equals(PublicKey.default)) continue;
      if (slotN < epoch.drawSlot || epoch.totalWeight <= 0n) continue;
      try {
        const oracle = await revealBound(connection, payer, epoch.randomness);
        if ("pending" in oracle && oracle.pending) {
          actions.push(`oracle pending epoch ${epoch.id} ${oracle.request}`);
        } else if ("seed" in oracle && oracle.seed) {
          const winner = pickWinner(epoch, oracle.seed);
          actions.push(`oracle switchboard winner ${winner.toBase58()}`);
          const sig = await sendTx(connection, payer, [
            await settleIx(payer.publicKey, config.mint, epoch.id, winner, epoch.randomness),
          ]);
          actions.push(`settled epoch ${epoch.id} ${sig}`);
          const freshEpoch = await connection.getAccountInfo(epochPda(epoch.id));
          if (freshEpoch) {
            const settled = decodeEpoch(freshEpoch.data as Buffer);
            await upsertEpoch(vault.id, settled);
            await bookAcquisition(vault.id, settled);
          }
        }
      } catch (err) {
        actions.push(`oracle/settle epoch ${epoch.id} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  if (payer && SEND && isAuthority) {
    const returned = await recoverCleared(connection, payer, config.mint, config.nextEpoch, config.collecting);
    actions.push(...returned);
  }

  const pastCutoff = Boolean(
    collecting && collecting.status === "Open" && slotN + config.cutoff > collecting.drawSlot,
  );

  if (payer && SEND) {
    if (config.collecting === 0n) {
      const draw = drawFrom(slotN, config.cutoff, DEPOSIT_MINUTES);
      const sig = await sendTx(connection, payer, [
        await openIx(payer.publicKey, config.mint, config.nextEpoch, draw),
      ]);
      actions.push(`opened epoch ${config.nextEpoch} ${sig}`);
      await heartbeat("keeper", true, actions.join(" | "));
      return { slot, actions };
    }
    if (pastCutoff && collecting) {
      const draw = drawFrom(slotN, config.cutoff, DEPOSIT_MINUTES);
      try {
        const bound = await commitFuture(connection, payer, vault.id, collecting.id);
        if ("pending" in bound && bound.pending) {
          actions.push(`randomness not ready ${bound.request}`);
        } else if ("randomness" in bound) {
          const sig = await sendTx(connection, payer, [
            await closeIx(payer.publicKey, collecting.id, bound.randomness),
            await openIx(payer.publicKey, config.mint, config.nextEpoch, draw),
          ]);
          actions.push(`rolled ${collecting.id} -> ${config.nextEpoch} ${sig}`);
          await heartbeat("keeper", true, actions.join(" | "));
          return { slot, actions };
        }
      } catch (err) {
        actions.push(
          `roll failed, sweep stays closed until the next epoch opens: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } else if (config.collecting === 0n || pastCutoff) {
    actions.push("needs a crank key to roll epoch");
  }

  if (collecting && collecting.status === "Open" && !pastCutoff && payer && SEND) {
    const delegates = (await findDelegates(connection, config.mint, configPda(), config.authority)).filter(
      (row) => row.pull >= 50_000_000n,
    );
    const batchSize = 4;
    for (let i = 0; i < delegates.length; i += batchSize) {
      const batch = delegates.slice(i, i + batchSize);
      try {
        const sig = await sendTx(
          connection,
          payer,
          await Promise.all(batch.map((row) => sweepIx(payer.publicKey, config.mint, row.owner, collecting.id))),
        );
        const slot = await sweepCreditSlot(connection, sig);
        for (const row of batch) {
          await recordSweep(
            vault.id,
            collecting,
            row.owner,
            row.pull,
            `${sig}:${row.owner.toBase58()}`,
            slot,
          );
          try {
            const notes = await attributeSweep(connection, row.owner, config.mint, originVaultId, collecting.id, row.pull);
            actions.push(`origins ${row.owner.toBase58()} ${notes.join(", ")}`);
          } catch (err) {
            actions.push(`origin read failed ${row.owner.toBase58()}: ${err instanceof Error ? err.message : err}`);
          }
        }
        actions.push(`swept ${batch.length} wallets in ${sig}`);
      } catch (err) {
        actions.push(`batch sweep failed, retrying one by one: ${err instanceof Error ? err.message : err}`);
        for (const row of batch) {
          try {
            const sig = await sendTx(connection, payer, [
              await sweepIx(payer.publicKey, config.mint, row.owner, collecting.id),
            ]);
            await recordSweep(
              vault.id,
              collecting,
              row.owner,
              row.pull,
              sig,
              await sweepCreditSlot(connection, sig),
            );
            try {
              const notes = await attributeSweep(connection, row.owner, config.mint, originVaultId, collecting.id, row.pull);
              actions.push(`origins ${notes.join(", ")}`);
            } catch (err) {
              actions.push(`origin read failed: ${err instanceof Error ? err.message : err}`);
            }
            actions.push(`swept ${row.pull} from ${row.owner.toBase58()} ${sig}`);
          } catch (one) {
            actions.push(`sweep failed ${row.owner.toBase58()}: ${one instanceof Error ? one.message : one}`);
          }
        }
      }
    }
    if (delegates.length === 0) actions.push("no delegated quote left under the cap");
  }

  const productive = loadProductive();
  if (payer && SEND && productive) {
    try {
      const routed = await routeProductive(connection, payer, productive, config.mint, LIVE_VAULT.baseMint
        ? new PublicKey(LIVE_VAULT.baseMint)
        : config.mint);
      actions.push(...routed);
    } catch (err) {
      actions.push(`productive route failed: ${err instanceof Error ? err.message : err}`);
    }
  } else if (payer && isAuthority) {
    actions.push("no productive wallet yet");
  }

  await heartbeat("keeper", true, actions.join(" | ") || `idle epoch ${config.collecting}`);
  return { slot, actions };
}

async function recoverCleared(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  nextEpoch: bigint,
  collecting: bigint,
) {
  const notes: string[] = [];
  const ids: bigint[] = [];
  for (let id = 1n; id < nextEpoch; id++) ids.push(id);
  if (!ids.length) return notes;
  const infos = await connection.getMultipleAccountsInfo(ids.map((id) => epochPda(id)));
  for (let i = 0; i < ids.length; i++) {
    const info = infos[i];
    const id = ids[i];
    if (!info || id === collecting) continue;
    let epoch: EpochView;
    try {
      epoch = decodeEpoch(info.data as Buffer);
    } catch {
      continue;
    }
    if (epoch.status !== "Settled" && epoch.status !== "Cancelled") continue;
    const bal = await tokenAmount(connection, mint, epochPda(id));
    if (bal !== 0n) continue;
    try {
      const sig = await sendTx(connection, payer, [await recoverIx(payer.publicKey, mint, id)]);
      notes.push(`returned rent for epoch ${id} ${sig}`);
    } catch (err) {
      notes.push(`rent return epoch ${id} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return notes;
}

async function fundedClosed(connection: Connection, nextEpoch: bigint) {
  const ids: bigint[] = [];
  for (let id = 1n; id < nextEpoch; id++) ids.push(id);
  if (!ids.length) return [] as EpochView[];
  const infos = await connection.getMultipleAccountsInfo(ids.map((id) => epochPda(id)));
  const closed: EpochView[] = [];
  infos.forEach((info) => {
    if (!info) return;
    const epoch = decodeEpoch(info.data as Buffer);
    if (epoch.status === "Closed" && epoch.total > 0n) closed.push(epoch);
  });
  return closed;
}

export async function reserveSnapshot(connection: Connection, config: ConfigView) {
  const { treasuryPda } = await import("./solana.js");
  const reserve = await tokenAmount(connection, config.mint, configPda());
  const treasury = await tokenAmount(connection, config.mint, treasuryPda());
  return { reserve, treasury, mint: config.mint, vaultAta: ata(config.mint, configPda()) };
}
