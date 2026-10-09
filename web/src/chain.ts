import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createRevokeInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

// VITE_PROGRAM_ID: base58 program id. The placeholder is not a deployable program.
export const DEFAULT_PROGRAM_ID = new PublicKey(
  import.meta.env.VITE_PROGRAM_ID || "11111111111111111111111111111111",
);

// VITE_QUOTE_MINTS: comma-separated base58 mints the page may approve.
export const QUOTE_MINTS = new Set(
  (import.meta.env.VITE_QUOTE_MINTS || "")
    .split(",")
    .map((mint) => mint.trim())
    .filter(Boolean),
);

export type TxSigner = {
  publicKey: PublicKey;
  sign: (tx: Transaction) => Promise<Transaction>;
};

export function keypairSigner(kp: Keypair): TxSigner {
  return {
    publicKey: kp.publicKey,
    sign: async (tx) => {
      tx.partialSign(kp);
      return tx;
    },
  };
}
export const CLUSTERS = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  localnet: "http://127.0.0.1:8899",
  mainnet: "https://solana-rpc.publicnode.com",
} as const;

export type ClusterName = keyof typeof CLUSTERS;

const discCache = new Map<string, Uint8Array>();

async function discriminator(name: string): Promise<Uint8Array> {
  const hit = discCache.get(name);
  if (hit) return hit;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`global:${name}`),
  );
  const bytes = new Uint8Array(digest).slice(0, 8);
  discCache.set(name, bytes);
  return bytes;
}

function discBuf(name: string): Promise<Buffer> {
  return discriminator(name).then((b) => Buffer.from(b));
}

function u64(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
}

function concat(...parts: Uint8Array[]): Buffer {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return Buffer.from(out);
}

export function loadKey(): Keypair | null {
  const raw = localStorage.getItem("hodl-dev-key");
  if (!raw) return null;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
}

export function saveKey(kp: Keypair) {
  localStorage.setItem("hodl-dev-key", JSON.stringify(Array.from(kp.secretKey)));
}

export function configPda(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
}

export function treasuryPda(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("treasury")], programId)[0];
}

export function lotsPda(programId: PublicKey, epochId: bigint, owner: PublicKey) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(epochId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lots"), buf, owner.toBuffer()],
    programId,
  )[0];
}

export function epochPda(programId: PublicKey, id: bigint) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(id);
  return PublicKey.findProgramAddressSync([Buffer.from("epoch"), buf], programId)[0];
}

export function ata(mint: PublicKey, owner: PublicKey) {
  return getAssociatedTokenAddressSync(mint, owner, true);
}

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
};

const STATUS = ["Open", "Closed", "Settled", "Cancelled"] as const;

export function decodeConfig(data: Buffer): ConfigView {
  let o = 8;
  const readPk = () => {
    const pk = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    return pk;
  };
  const readU64 = () => {
    const n = data.readBigUInt64LE(o);
    o += 8;
    return n;
  };
  return {
    authority: readPk(),
    mint: readPk(),
    maxUser: readU64(),
    maxEpoch: readU64(),
    cutoff: readU64(),
    nextEpoch: readU64(),
    collecting: readU64(),
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
  return { id, status, total, totalWeight, drawSlot, count, depositors, winner, prize, reserveCut, treasuryCut };
}

async function send(
  connection: Connection,
  signer: TxSigner,
  ixs: TransactionInstruction[],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: signer.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(...ixs);
  const signed = await signer.sign(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  try {
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  } catch (err) {
    const status = await connection.getSignatureStatuses([sig]);
    const value = status.value[0];
    if (!value || value.err) throw err;
  }
  return sig;
}

export async function airdrop(connection: Connection, to: PublicKey, lamports = 1_000_000_000) {
  const sig = await connection.requestAirdrop(to, lamports);
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

export async function createTestMint(connection: Connection, payer: Keypair): Promise<PublicKey> {
  const mint = Keypair.generate();
  const lamports = await getMinimumBalanceForRentExemptMint(connection);
  const dest = ata(mint.publicKey, payer.publicKey);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: MINT_SIZE,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint.publicKey, 9, payer.publicKey, null),
    createAssociatedTokenAccountInstruction(payer.publicKey, dest, payer.publicKey, mint.publicKey),
    createMintToInstruction(mint.publicKey, dest, payer.publicKey, 1_000_000_000_000n),
  );
  await sendAndConfirmTransaction(connection, tx, [payer, mint], { commitment: "confirmed" });
  return mint.publicKey;
}

export async function initialize(
  connection: Connection,
  programId: PublicKey,
  signer: TxSigner,
  mint: PublicKey,
  maxUser: bigint,
  maxEpoch: bigint,
  cutoff: bigint,
) {
  const config = configPda(programId);
  const treasury = treasuryPda(programId);
  const data = concat(
    await discBuf("initialize"),
    u64(maxUser),
    u64(maxEpoch),
    u64(cutoff),
  );
  const ix = new TransactionInstruction({
    programId,
    data,
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: ata(mint, config), isSigner: false, isWritable: true },
      { pubkey: ata(mint, treasury), isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
  return send(connection, signer, [ix]);
}

export async function openEpoch(
  connection: Connection,
  programId: PublicKey,
  signer: TxSigner,
  mint: PublicKey,
  epochId: bigint,
  drawSlot: bigint,
) {
  const config = configPda(programId);
  const epoch = epochPda(programId, epochId);
  const ix = new TransactionInstruction({
    programId,
    data: concat(await discBuf("open_epoch"), u64(drawSlot)),
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: epoch, isSigner: false, isWritable: true },
      { pubkey: ata(mint, epoch), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
  return send(connection, signer, [ix]);
}

export async function deposit(
  connection: Connection,
  programId: PublicKey,
  signer: TxSigner,
  mint: PublicKey,
  epochId: bigint,
  amount: bigint,
) {
  const epoch = epochPda(programId, epochId);
  const ix = new TransactionInstruction({
    programId,
    data: concat(await discBuf("deposit"), u64(amount)),
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda(programId), isSigner: false, isWritable: false },
      { pubkey: epoch, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: ata(mint, signer.publicKey), isSigner: false, isWritable: true },
      { pubkey: ata(mint, epoch), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
  return send(connection, signer, [ix]);
}

async function authEpochIx(
  name: "close_epoch" | "cancel_epoch",
  programId: PublicKey,
  payer: PublicKey,
  epochId: bigint,
) {
  return new TransactionInstruction({
    programId,
    data: await discBuf(name),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: configPda(programId), isSigner: false, isWritable: true },
      { pubkey: epochPda(programId, epochId), isSigner: false, isWritable: true },
    ],
  });
}

export async function closeAndOpenNext(
  connection: Connection,
  programId: PublicKey,
  signer: TxSigner,
  mint: PublicKey,
  closingId: bigint,
  nextId: bigint,
  nextDraw: bigint,
) {
  const config = configPda(programId);
  const next = epochPda(programId, nextId);
  const open = new TransactionInstruction({
    programId,
    data: concat(await discBuf("open_epoch"), u64(nextDraw)),
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: next, isSigner: false, isWritable: true },
      { pubkey: ata(mint, next), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
  return send(connection, signer, [
    await authEpochIx("close_epoch", programId, signer.publicKey, closingId),
    open,
  ]);
}

export function winnerForSeed(epoch: EpochView, seed: Uint8Array): PublicKey {
  const target = readU128LE(seed.subarray(0, 16)) % epoch.totalWeight;
  let acc = 0n;
  for (const d of epoch.depositors) {
    acc += d.weight;
    if (target < acc) return d.wallet;
  }
  return epoch.depositors[epoch.depositors.length - 1].wallet;
}

function readU128LE(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = 15; i >= 0; i--) n = (n << 8n) + BigInt(bytes[i]);
  return n;
}

export async function settle(
  connection: Connection,
  programId: PublicKey,
  signer: TxSigner,
  mint: PublicKey,
  epoch: EpochView,
) {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const winner = winnerForSeed(epoch, seed);
  const treasury = treasuryPda(programId);
  const epochKey = epochPda(programId, epoch.id);
  const ix = new TransactionInstruction({
    programId,
    data: concat(await discBuf("settle"), seed),
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      { pubkey: configPda(programId), isSigner: false, isWritable: false },
      { pubkey: epochKey, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: winner, isSigner: false, isWritable: false },
      { pubkey: ata(mint, winner), isSigner: false, isWritable: true },
      { pubkey: ata(mint, epochKey), isSigner: false, isWritable: true },
      { pubkey: ata(mint, configPda(programId)), isSigner: false, isWritable: true },
      { pubkey: ata(mint, treasury), isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
  const sig = await send(connection, signer, [ix]);
  return { sig, winner };
}

export async function cancelEpoch(
  connection: Connection,
  programId: PublicKey,
  signer: TxSigner,
  epochId: bigint,
) {
  return send(connection, signer, [
    await authEpochIx("cancel_epoch", programId, signer.publicKey, epochId),
  ]);
}

export async function claimRefund(
  connection: Connection,
  programId: PublicKey,
  signer: TxSigner,
  mint: PublicKey,
  epochId: bigint,
) {
  const epoch = epochPda(programId, epochId);
  const ix = new TransactionInstruction({
    programId,
    data: await discBuf("claim_refund"),
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda(programId), isSigner: false, isWritable: false },
      { pubkey: epoch, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: ata(mint, signer.publicKey), isSigner: false, isWritable: true },
      { pubkey: ata(mint, epoch), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
  return send(connection, signer, [ix]);
}

export async function sweep(
  connection: Connection,
  signer: TxSigner,
  programId: PublicKey,
  mint: PublicKey,
  user: PublicKey,
  epochId: bigint,
  amount: bigint,
) {
  const epoch = epochPda(programId, epochId);
  const ix = new TransactionInstruction({
    programId,
    data: concat(await discBuf("sweep"), u64(amount)),
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda(programId), isSigner: false, isWritable: false },
      { pubkey: epoch, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: user, isSigner: false, isWritable: false },
      { pubkey: ata(mint, user), isSigner: false, isWritable: true },
      { pubkey: ata(mint, epoch), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: lotsPda(programId, epochId, user), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
  return send(connection, signer, [ix]);
}

export async function removeStake(
  connection: Connection,
  signer: TxSigner,
  programId: PublicKey,
  mint: PublicKey,
  epochId: bigint,
  amount: bigint,
) {
  const epoch = epochPda(programId, epochId);
  const ix = new TransactionInstruction({
    programId,
    data: concat(await discBuf("remove"), u64(amount)),
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda(programId), isSigner: false, isWritable: false },
      { pubkey: epoch, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: ata(mint, signer.publicKey), isSigner: false, isWritable: true },
      { pubkey: ata(mint, epoch), isSigner: false, isWritable: true },
      { pubkey: lotsPda(programId, epochId, signer.publicKey), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
  return send(connection, signer, [ix]);
}

export async function approveQuote(
  connection: Connection,
  signer: TxSigner,
  mint: PublicKey,
  delegate: PublicKey,
  amount: bigint,
) {
  const userAta = ata(mint, signer.publicKey);
  const ix = createApproveInstruction(userAta, delegate, signer.publicKey, amount);
  const existing = await connection.getAccountInfo(userAta);
  const ixs = existing
    ? [ix]
    : [createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, userAta, signer.publicKey, mint), ix];
  return send(connection, signer, ixs);
}

export async function revokeQuote(connection: Connection, signer: TxSigner, mint: PublicKey) {
  const userAta = ata(mint, signer.publicKey);
  return send(connection, signer, [createRevokeInstruction(userAta, signer.publicKey)]);
}

export async function setPaused(
  connection: Connection,
  programId: PublicKey,
  signer: TxSigner,
  paused: boolean,
) {
  const flag = new Uint8Array([paused ? 1 : 0]);
  const ix = new TransactionInstruction({
    programId,
    data: concat(await discBuf("set_paused"), flag),
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      { pubkey: configPda(programId), isSigner: false, isWritable: true },
    ],
  });
  return send(connection, signer, [ix]);
}

export function uiAmount(raw: bigint, decimals = 9): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? `.${frac}` : ""}`;
}
