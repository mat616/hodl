import { readFileSync, existsSync } from "fs";
import { createHash, randomBytes } from "crypto";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../web/node_modules");
const web3 = require(join(root, "@solana/web3.js"));
const spl = require(join(root, "@solana/spl-token"));
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} = web3;
const { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } = spl;

// PROGRAM_ID: base58 id of this program.
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "11111111111111111111111111111111");
const RPC = process.env.KEEPER_RPC || "https://solana-rpc.publicnode.com";
const KEY_PATH = process.env.KEEPER_KEY || "";
const DEPOSIT_MINUTES = Number(process.env.KEEPER_DEPOSIT_MINUTES || "10");
const LOOP_MS = Number(process.env.KEEPER_INTERVAL_MS || "30000");

const send = process.argv.includes("--send");
const loop = process.argv.includes("--loop");

function pda(seeds) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}
function configPda() {
  return pda([Buffer.from("config")]);
}
function treasuryPda() {
  return pda([Buffer.from("treasury")]);
}
function epochPda(id) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(id);
  return pda([Buffer.from("epoch"), buf]);
}
function ata(mint, owner) {
  return getAssociatedTokenAddressSync(mint, owner, true);
}
function u64(n) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(n);
  return out;
}
async function disc(name) {
  const hash = createHash("sha256").update(`global:${name}`).digest();
  return hash.subarray(0, 8);
}
function ui(raw) {
  const base = 10n ** 9n;
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""}`;
}

function decodeConfig(data) {
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

function decodeEpoch(data) {
  let o = 8;
  const id = data.readBigUInt64LE(o);
  o += 8;
  const status = ["Open", "Closed", "Settled", "Cancelled"][data[o]] ?? "Unknown";
  o += 1;
  const total = data.readBigUInt64LE(o);
  o += 8;
  const weight = data.readBigUInt64LE(o) + (data.readBigUInt64LE(o + 8) << 64n);
  o += 16;
  const drawSlot = data.readBigUInt64LE(o);
  o += 8;
  const count = data[o];
  o += 1;
  const slots = (data.length - o - 89) / 57;
  const depositors = [];
  for (let i = 0; i < slots; i++) {
    const wallet = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    const amount = data.readBigUInt64LE(o);
    o += 8;
    const dw = data.readBigUInt64LE(o) + (data.readBigUInt64LE(o + 8) << 64n);
    o += 16;
    o += 1;
    if (i < count) depositors.push({ wallet, amount, weight: dw });
  }
  return { id, status, total, totalWeight: weight, drawSlot, depositors };
}

function pickWinner(epoch) {
  const seed = randomBytes(32);
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
  return { seed, winner };
}

async function sendTx(connection, payer, ixs) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(payer);
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

async function openIx(authority, mint, epochId, drawSlot) {
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

async function closeIx(authority, epochId) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: await disc("close_epoch"),
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: configPda(), isSigner: false, isWritable: true },
      { pubkey: epochPda(epochId), isSigner: false, isWritable: true },
    ],
  });
}

async function settleIx(authority, mint, epochId, seed, winner) {
  const epochKey = epochPda(epochId);
  const treasury = treasuryPda();
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([await disc("settle"), seed]),
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
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
    ],
  });
}

async function sweepIx(crank, mint, user, epochId) {
  const epoch = epochPda(epochId);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([await disc("sweep"), u64(0n)]),
    keys: [
      { pubkey: crank, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: epoch, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: user, isSigner: false, isWritable: false },
      { pubkey: ata(mint, user), isSigner: false, isWritable: true },
      { pubkey: ata(mint, epoch), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

function drawFrom(slot, cutoff) {
  const windowSlots = BigInt(Math.round(DEPOSIT_MINUTES * 150));
  return slot + cutoff + windowSlots + 300n;
}

async function allowanceFor(connection, mint, delegate, owner) {
  const account = ata(mint, owner);
  const info = await connection.getAccountInfo(account);
  if (!info || info.data.length < 129) return null;
  const tag = info.data.readUInt32LE(72);
  if (tag !== 1) return null;
  const who = new PublicKey(info.data.subarray(76, 108));
  if (!who.equals(delegate)) return null;
  const amount = info.data.readBigUInt64LE(64);
  const delegated = info.data.readBigUInt64LE(121);
  const pull = amount < delegated ? amount : delegated;
  if (pull <= 0n) return null;
  return { owner, pull };
}

function watchedWallets(authority) {
  const wallets = [authority];
  const file = fileURLToPath(new URL("./watch.json", import.meta.url));
  if (!existsSync(file)) return wallets;
  try {
    const extra = JSON.parse(readFileSync(file, "utf8"));
    for (const item of extra) wallets.push(new PublicKey(item));
  } catch {
    console.log("watch.json could not be read");
  }
  return wallets;
}

async function findDelegates(connection, mint, delegate, authority) {
  const found = [];
  const seen = new Set();
  for (const owner of watchedWallets(authority)) {
    const key = owner.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    const row = await allowanceFor(connection, mint, delegate, owner);
    if (row) found.push(row);
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
      const key = owner.toBase58();
      if (seen.has(key)) continue;
      seen.add(key);
      const amount = account.data.readBigUInt64LE(64);
      const delegated = account.data.readBigUInt64LE(121);
      const pull = amount < delegated ? amount : delegated;
      if (pull > 0n) found.push({ owner, pull });
    }
  } catch (err) {
    console.log("broad delegate scan skipped:", err instanceof Error ? err.message.split("\n")[0] : err);
  }
  return found;
}

async function tick(connection, payer) {
  const slot = BigInt(await connection.getSlot("confirmed"));
  const cfgInfo = await connection.getAccountInfo(configPda());
  if (!cfgInfo) {
    console.log("vault is not initialized");
    return;
  }
  const config = decodeConfig(cfgInfo.data);
  const isAuthority = payer.publicKey.equals(config.authority);
  console.log(
    `slot ${slot} collecting ${config.collecting} next ${config.nextEpoch} cutoff ${config.cutoff} authority ${isAuthority}`,
  );
  if (config.paused) {
    console.log("vault is paused");
    return;
  }

  if (isAuthority && config.collecting > 1n) {
    const prevInfo = await connection.getAccountInfo(epochPda(config.collecting - 1n));
    const prev = prevInfo ? decodeEpoch(prevInfo.data) : null;
    if (prev && prev.status === "Closed" && slot >= prev.drawSlot && prev.totalWeight > 0n) {
      const { seed, winner } = pickWinner(prev);
      console.log(`settle epoch ${prev.id} winner ${winner.toBase58()} pot ${ui(prev.total)}`);
      if (send) {
        const sig = await sendTx(connection, payer, [
          await settleIx(payer.publicKey, config.mint, prev.id, seed, winner),
        ]);
        console.log("settled", sig);
      }
    }
  }

  let collecting = config.collecting;
  let epoch = null;
  if (collecting > 0n) {
    const info = await connection.getAccountInfo(epochPda(collecting));
    epoch = info ? decodeEpoch(info.data) : null;
  }
  const pastCutoff = epoch && slot + config.cutoff > epoch.drawSlot;

  if (!isAuthority && (collecting === 0n || pastCutoff)) {
    console.log("keeper is not the vault authority, so it cannot open or roll the epoch");
  } else if (collecting === 0n) {
    const draw = drawFrom(slot, config.cutoff);
    console.log(`open epoch ${config.nextEpoch} draw ${draw}`);
    if (send) {
      const sig = await sendTx(connection, payer, [await openIx(payer.publicKey, config.mint, config.nextEpoch, draw)]);
      console.log("opened", sig);
    }
    return;
  } else if (pastCutoff && epoch.status === "Open") {
    const draw = drawFrom(slot, config.cutoff);
    console.log(`close epoch ${epoch.id} and open ${config.nextEpoch} draw ${draw}`);
    if (send) {
      const sig = await sendTx(connection, payer, [
        await closeIx(payer.publicKey, epoch.id),
        await openIx(payer.publicKey, config.mint, config.nextEpoch, draw),
      ]);
      console.log("rolled", sig);
    }
    return;
  }

  if (!epoch || epoch.status !== "Open") {
    console.log("no open collecting epoch");
    return;
  }
  const left = epoch.drawSlot - config.cutoff - slot;
  console.log(`epoch ${epoch.id} open, ${left} slots left in the deposit window, pot ${ui(epoch.total)}`);

  let delegates = [];
  try {
    delegates = await findDelegates(connection, config.mint, configPda(), config.authority);
  } catch (err) {
    console.log("delegate scan failed:", err instanceof Error ? err.message : err);
  }
  if (delegates.length === 0) {
    console.log("no wallets have wNEAR allowed to the vault");
    return;
  }
  for (const row of delegates) {
    console.log(`sweep ${ui(row.pull)} from ${row.owner.toBase58()}`);
    if (!send) continue;
    try {
      const sig = await sendTx(connection, payer, [await sweepIx(payer.publicKey, config.mint, row.owner, epoch.id)]);
      console.log("swept", sig);
    } catch (err) {
      console.log("sweep failed", row.owner.toBase58(), err instanceof Error ? err.message : err);
    }
  }
}

async function main() {
  if (!existsSync(KEY_PATH)) {
    console.log(`No keeper key at ${KEY_PATH}`);
    console.log("Create one with solana-keygen, fund it with a little SOL, and point KEEPER_KEY at it.");
    console.log("It must be the vault authority to roll epochs. Any funded key can submit sweeps.");
    process.exit(1);
  }
  const secret = Uint8Array.from(JSON.parse(readFileSync(KEY_PATH, "utf8")));
  const payer = Keypair.fromSecretKey(secret);
  const connection = new Connection(RPC, "confirmed");
  const sol = await connection.getBalance(payer.publicKey);
  console.log(`${send ? "SEND" : "DRY-RUN"} keeper ${payer.publicKey.toBase58()} ${ui(BigInt(sol))} SOL`);
  do {
    try {
      await tick(connection, payer);
    } catch (err) {
      console.log("tick failed", err instanceof Error ? err.message : err);
    }
    if (loop) await new Promise((r) => setTimeout(r, LOOP_MS));
  } while (loop);
}

main();
