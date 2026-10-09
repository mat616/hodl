import { createHash, randomBytes } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PROGRAM_ID } from "./config.js";

export type ConfigView = {
  authority: PublicKey;
  mint: PublicKey;
  maxUser: bigint;
  maxEpoch: bigint;
  cutoff: bigint;
  nextEpoch: bigint;
  collecting: bigint;
  paused: boolean;
};

export type DepositorView = {
  wallet: PublicKey;
  amount: bigint;
  weight: bigint;
  refunded: boolean;
};

export type EpochView = {
  id: bigint;
  status: "Open" | "Closed" | "Settled" | "Cancelled";
  total: bigint;
  totalWeight: bigint;
  drawSlot: bigint;
  count: number;
  depositors: DepositorView[];
  winner: PublicKey;
  prize: bigint;
  reserveCut: bigint;
  treasuryCut: bigint;
  randomness: PublicKey | null;
};

const STATUS = ["Open", "Closed", "Settled", "Cancelled"] as const;

export function pda(seeds: Buffer[]) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}
export function configPda() {
  return pda([Buffer.from("config")]);
}
export function treasuryPda() {
  return pda([Buffer.from("treasury")]);
}
export function epochPda(id: bigint) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(id);
  return pda([Buffer.from("epoch"), buf]);
}
export function ata(mint: PublicKey, owner: PublicKey) {
  return getAssociatedTokenAddressSync(mint, owner, true);
}
export function u64(n: bigint) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(n);
  return out;
}
export async function disc(name: string) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

export function decodeConfig(data: Buffer): ConfigView {
  let o = 8;
  const pk = () => {
    const key = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    return key;
  };
  const n = () => {
    const v = data.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  return {
    authority: pk(),
    mint: pk(),
    maxUser: n(),
    maxEpoch: n(),
    cutoff: n(),
    nextEpoch: n(),
    collecting: n(),
    paused: data[o] === 1,
  };
}

export function decodeEpoch(data: Buffer): EpochView {
  let o = 8;
  const id = data.readBigUInt64LE(o);
  o += 8;
  const status = STATUS[data[o]] ?? "Open";
  o += 1;
  const total = data.readBigUInt64LE(o);
  o += 8;
  const totalWeight = data.readBigUInt64LE(o) + (data.readBigUInt64LE(o + 8) << 64n);
  o += 16;
  const drawSlot = data.readBigUInt64LE(o);
  o += 8;
  const count = data[o];
  o += 1;
  const rest = data.length - o;
  const tail = rest >= 121 && (rest - 121) % 57 === 0 ? 121 : 89;
  const slots = (rest - tail) / 57;
  if (!Number.isInteger(slots) || slots < count) {
    throw new Error(`epoch account length ${data.length} is not a depositor list`);
  }
  const depositors: DepositorView[] = [];
  for (let i = 0; i < slots; i++) {
    const wallet = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    const amount = data.readBigUInt64LE(o);
    o += 8;
    const weight = data.readBigUInt64LE(o) + (data.readBigUInt64LE(o + 8) << 64n);
    o += 16;
    const refunded = data[o] === 1;
    o += 1;
    if (i < count) depositors.push({ wallet, amount, weight, refunded });
  }
  const winner = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const prize = data.readBigUInt64LE(o);
  o += 8;
  const reserveCut = data.readBigUInt64LE(o);
  o += 8;
  const treasuryCut = data.readBigUInt64LE(o);
  o += 8;
  let randomness: PublicKey | null = null;
  if (tail === 121) {
    o += 32;
    randomness = new PublicKey(data.subarray(o, o + 32));
  }
  return { id, status, total, totalWeight, drawSlot, count, depositors, winner, prize, reserveCut, treasuryCut, randomness };
}

export function pickWinner(epoch: EpochView, seed: Buffer) {
  let target = 0n;
  for (let i = 15; i >= 0; i--) target = (target << 8n) + BigInt(seed[i]);
  target %= epoch.totalWeight;
  let acc = 0n;
  let winner = epoch.depositors[epoch.depositors.length - 1].wallet;
  for (const row of epoch.depositors) {
    acc += row.weight;
    if (target < acc) {
      winner = row.wallet;
      break;
    }
  }
  return winner;
}

export function randomSeed() {
  return randomBytes(32);
}

export async function sendTx(
  connection: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
  extra: Keypair[] = [],
) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(payer, ...extra);
  const sig = await connection.sendRawTransaction(tx.serialize());
  try {
    const result = await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (result.value.err) throw new Error(JSON.stringify(result.value.err));
  } catch (err) {
    const status = await connection.getSignatureStatuses([sig]);
    const value = status.value[0];
    if (!value || value.err) throw err;
  }
  return sig;
}

export async function openIx(authority: PublicKey, mint: PublicKey, epochId: bigint, drawSlot: bigint) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([await disc("open_epoch"), u64(drawSlot)]),
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: epochPda(epochId), isSigner: false, isWritable: true },
      { pubkey: ata(mint, epochPda(epochId)), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export function lotsPda(epochId: bigint, owner: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lots"), Buffer.from(u64(epochId)), owner.toBuffer()],
    PROGRAM_ID,
  )[0];
}

export async function setCutoffIx(authority: PublicKey, cutoffSlots: bigint) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([await disc("set_cutoff"), u64(cutoffSlots)]),
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: configPda(), isSigner: false, isWritable: true },
    ],
  });
}

export async function withdrawIx(
  authority: PublicKey,
  mint: PublicKey,
  source: PublicKey,
  sourceAuthority: PublicKey,
) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: await disc("withdraw"),
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: sourceAuthority, isSigner: false, isWritable: false },
      { pubkey: ata(mint, authority), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

export async function pauseIx(authority: PublicKey) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([await disc("set_paused"), Buffer.from([1])]),
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: configPda(), isSigner: false, isWritable: true },
    ],
  });
}

export async function recoverIx(authority: PublicKey, mint: PublicKey, epochId: bigint) {
  const epoch = epochPda(epochId);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: await disc("recover_epoch"),
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: true },
      { pubkey: epoch, isSigner: false, isWritable: true },
      { pubkey: ata(mint, epoch), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

export async function cancelIx(authority: PublicKey, epochId: bigint) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: await disc("cancel_epoch"),
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: configPda(), isSigner: false, isWritable: true },
      { pubkey: epochPda(epochId), isSigner: false, isWritable: true },
    ],
  });
}

export async function claimRefundIx(depositor: PublicKey, mint: PublicKey, epochId: bigint) {
  const epoch = epochPda(epochId);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: await disc("claim_refund"),
    keys: [
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: epoch, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: ata(mint, depositor), isSigner: false, isWritable: true },
      { pubkey: ata(mint, epoch), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

export async function closeIx(crank: PublicKey, epochId: bigint, randomness: PublicKey) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: await disc("close_epoch"),
    keys: [
      { pubkey: crank, isSigner: true, isWritable: false },
      { pubkey: configPda(), isSigner: false, isWritable: true },
      { pubkey: epochPda(epochId), isSigner: false, isWritable: true },
      { pubkey: randomness, isSigner: false, isWritable: false },
    ],
  });
}

export async function settleIx(
  crank: PublicKey,
  mint: PublicKey,
  epochId: bigint,
  winner: PublicKey,
  randomness: PublicKey,
) {
  const epochKey = epochPda(epochId);
  const treasury = treasuryPda();
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: await disc("settle"),
    keys: [
      { pubkey: crank, isSigner: true, isWritable: false },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: epochKey, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: winner, isSigner: false, isWritable: false },
      { pubkey: ata(mint, winner), isSigner: false, isWritable: true },
      { pubkey: ata(mint, epochKey), isSigner: false, isWritable: true },
      { pubkey: ata(mint, configPda()), isSigner: false, isWritable: true },
      { pubkey: ata(mint, treasury), isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: randomness, isSigner: false, isWritable: false },
    ],
  });
}

export async function sweepIx(crank: PublicKey, mint: PublicKey, user: PublicKey, epochId: bigint) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([await disc("sweep"), u64(0n)]),
    keys: [
      { pubkey: crank, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: epochPda(epochId), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: user, isSigner: false, isWritable: false },
      { pubkey: ata(mint, user), isSigner: false, isWritable: true },
      { pubkey: ata(mint, epochPda(epochId)), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: lotsPda(epochId, user), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export function drawFrom(slot: bigint, cutoff: bigint, minutes: number) {
  const windowSlots = BigInt(Math.round(minutes * 150));
  return slot + cutoff + windowSlots + 300n;
}

export async function growEpochIx(authority: PublicKey, epochId: bigint) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: await disc("grow_epoch"),
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: epochPda(epochId), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export async function releaseIx(authority: PublicKey, mint: PublicKey, destination: PublicKey) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: await disc("release_reserve"),
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: ata(mint, configPda()), isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

export async function tokenAmount(connection: Connection, mint: PublicKey, owner: PublicKey) {
  const info = await connection.getAccountInfo(ata(mint, owner));
  if (!info || info.data.length < 72) return 0n;
  return info.data.readBigUInt64LE(64);
}

export async function allowanceFor(connection: Connection, mint: PublicKey, delegate: PublicKey, owner: PublicKey) {
  const info = await connection.getAccountInfo(ata(mint, owner));
  if (!info || info.data.length < 129) return null;
  const tag = info.data.readUInt32LE(72);
  if (tag !== 1) return null;
  const who = new PublicKey(info.data.subarray(76, 108));
  if (!who.equals(delegate)) return null;
  const amount = info.data.readBigUInt64LE(64);
  const delegated = info.data.readBigUInt64LE(121);
  const pull = amount < delegated ? amount : delegated;
  if (pull <= 0n) return null;
  return { owner, pull, amount, delegated };
}
