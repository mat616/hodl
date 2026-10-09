import { Connection, PublicKey } from "@solana/web3.js";
import { LIVE_VAULT, VAULTS, WATERFALL, pots, vaultByQuote } from "./catalog.js";
import { PROGRAM_ID } from "./config.js";
import { pool } from "./db.js";
import { priceMap, uiAmount, usdFromRaw } from "./prices.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { allowanceFor, ata, configPda, decodeConfig, decodeEpoch, epochPda, tokenAmount, treasuryPda } from "./solana.js";

// PRODUCTIVE_WALLET: base58 address of the wallet that holds bought tokens.
// Leave it unset and holdings from that wallet are reported as zero.
const PRODUCTIVE = process.env.PRODUCTIVE_WALLET;

async function baseHeld(connection: Connection, mint: string) {
  if (!PRODUCTIVE) return 0n;
  const owner = new PublicKey(PRODUCTIVE);
  const key = new PublicKey(mint);
  for (const program of [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]) {
    const account = getAssociatedTokenAddressSync(key, owner, true, program);
    const info = await connection.getAccountInfo(account);
    if (info && info.data.length >= 72) return info.data.readBigUInt64LE(64);
  }
  return 0n;
}

function chance(part: string | bigint, whole: string | bigint) {
  const a = BigInt(part || "0");
  const b = BigInt(whole || "0");
  if (b <= 0n) return 0;
  return Number((a * 10000n) / b) / 100;
}

function money(n: number) {
  return Number(n.toFixed(2));
}

async function walletHoldings(connection: Connection, owner: PublicKey | null, prices: Map<string, number>) {
  const stonkSpecs = VAULTS.filter((vault) => vault.baseMint).map((vault) => ({
    id: vault.id,
    symbol: vault.baseSymbol,
    mint: vault.baseMint!,
    decimals: null as number | null,
  }));
  const rewardSpecs = pots()
    .filter((pot) => pot.quoteMint)
    .map((pot) => ({
      id: pot.id,
      symbol: pot.quoteSymbol,
      mint: pot.quoteMint!,
      decimals: pot.quoteDecimals,
    }));
  const specs = [...stonkSpecs, ...rewardSpecs];
  const amountByMint = new Map<string, bigint>();
  const decimals = new Map<string, number>();
  if (owner) {
    const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
    const atas = specs.flatMap((spec) =>
      programs.map((program) => ({
        mint: spec.mint,
        key: getAssociatedTokenAddressSync(new PublicKey(spec.mint), owner, true, program),
      })),
    );
    const mintKeys = [...new Set(specs.filter((spec) => spec.decimals === null).map((spec) => spec.mint))].map(
      (mint) => new PublicKey(mint),
    );
    const infos = await connection.getMultipleAccountsInfo([...atas.map((row) => row.key), ...mintKeys]);
    atas.forEach((row, index) => {
      const data = infos[index]?.data;
      if (!data || data.length < 72) return;
      const amount = data.readBigUInt64LE(64);
      const prev = amountByMint.get(row.mint) ?? 0n;
      if (amount > prev) amountByMint.set(row.mint, amount);
    });
    mintKeys.forEach((key, index) => {
      const data = infos[atas.length + index]?.data;
      decimals.set(key.toBase58(), data && data.length > 44 ? data[44] : 6);
    });
  }
  const row = (spec: { id: string; symbol: string; mint: string; decimals: number | null }) => {
    if (!owner) return { id: spec.id, symbol: spec.symbol, amount: null, usd: null };
    const raw = amountByMint.get(spec.mint) ?? 0n;
    const places = spec.decimals ?? decimals.get(spec.mint) ?? 6;
    return {
      id: spec.id,
      symbol: spec.symbol,
      amount: uiAmount(raw, places),
      usd: money(usdFromRaw(raw, places, prices.get(spec.mint))),
    };
  };
  return { stonks: stonkSpecs.map(row), rewards: rewardSpecs.map(row) };
}

export async function buildState(connection: Connection, wallet?: string) {
  const prices = await priceMap();
  const slot = await connection.getSlot("confirmed");
  const cfgInfo = await connection.getAccountInfo(configPda());
  const config = cfgInfo ? decodeConfig(cfgInfo.data as Buffer) : null;
  const live = config ? vaultByQuote(config.mint.toBase58()) ?? LIVE_VAULT : LIVE_VAULT;

  let reserveRaw = 0n;
  let treasuryRaw = 0n;
  let collectingEpoch: Awaited<ReturnType<typeof decodeEpoch>> | null = null;
  if (config) {
    reserveRaw = await tokenAmount(connection, config.mint, configPda());
    treasuryRaw = await tokenAmount(connection, config.mint, treasuryPda());
    const look = config.collecting > 0n ? config.collecting : 0n;
    if (look > 0n) {
      const info = await connection.getAccountInfo(epochPda(look));
      collectingEpoch = info ? decodeEpoch(info.data as Buffer) : null;
    }
  }

  const epochs = await pool.query<{
    vault_id: string;
    epoch_id: string;
    status: string;
    total_raw: string;
    total_weight: string;
    draw_slot: string;
    winner: string | null;
    prize_raw: string | null;
    reserve_cut_raw: string | null;
    treasury_cut_raw: string | null;
  }>(`SELECT * FROM epochs ORDER BY epoch_id DESC`);

  const depositors = await pool.query<{
    vault_id: string;
    epoch_id: string;
    wallet: string;
    amount_raw: string;
    weight: string;
  }>(`SELECT * FROM depositors`);

  const sleeves = await pool.query<{
    vault_id: string;
    sleeve: string;
    amount_raw: string;
    source: string;
  }>(`SELECT vault_id, sleeve, amount_raw, source FROM yield_sleeves`);

  const clash = await pool.query<{
    clash_pot_usd: string;
    jackpot_pot_usd: string;
    jackpot_chance_bps: number;
  }>(`SELECT clash_pot_usd, jackpot_pot_usd, jackpot_chance_bps FROM clash_state WHERE id = 1`);

  const heartbeats = await pool.query<{
    id: string;
    last_run: string | null;
    last_ok: boolean | null;
    last_error: string | null;
    detail: string | null;
  }>(`SELECT * FROM keeper_heartbeats`);

  const sweepSum = await pool.query<{ vault_id: string; amount_raw: string }>(
    `SELECT vault_id, COALESCE(SUM(amount_raw::numeric),0)::text AS amount_raw FROM sweeps GROUP BY vault_id`,
  );

  const livePrice = live.quoteMint ? prices.get(live.quoteMint) || 0 : 0;
  let rewardsPooledUsd = 0;
  let highestWinning = null as null | {
    vaultId: string;
    amount: string;
    usd: number;
    winner: string;
    epochId: string;
  };
  const pooledByVault = new Map<string, bigint>();

  for (const row of epochs.rows) {
    const vault = VAULTS.find((v) => v.id === row.vault_id);
    if (!vault?.quoteMint) continue;
    const px = prices.get(vault.quoteMint) || 0;
    const total = BigInt(row.total_raw);
    pooledByVault.set(row.vault_id, (pooledByVault.get(row.vault_id) ?? 0n) + total);
    rewardsPooledUsd += usdFromRaw(total, vault.quoteDecimals, px);
    if (row.status === "Settled" && row.prize_raw && row.winner) {
      const usd = usdFromRaw(row.prize_raw, vault.quoteDecimals, px);
      if (!highestWinning || usd > highestWinning.usd) {
        highestWinning = {
          vaultId: row.vault_id,
          amount: uiAmount(row.prize_raw, vault.quoteDecimals),
          usd: money(usd),
          winner: row.winner,
          epochId: row.epoch_id,
        };
      }
    }
  }

  const yieldRows = sleeves.rows.filter((s) => s.source === "yield");
  const clashFromSleeves = yieldRows
    .filter((s) => s.sleeve === "clash")
    .reduce((sum, s) => {
      const vault = VAULTS.find((v) => v.id === s.vault_id);
      if (!vault?.quoteMint) return sum;
      return sum + usdFromRaw(s.amount_raw, vault.quoteDecimals, prices.get(vault.quoteMint));
    }, 0);
  const jackpotFromSleeves = yieldRows
    .filter((s) => s.sleeve === "jackpot")
    .reduce((sum, s) => {
      const vault = VAULTS.find((v) => v.id === s.vault_id);
      if (!vault?.quoteMint) return sum;
      return sum + usdFromRaw(s.amount_raw, vault.quoteDecimals, prices.get(vault.quoteMint));
    }, 0);

  const sleeveMakeup = (sleeve: string) =>
    pots().map((pot) => {
      const raw = yieldRows
        .filter((row) => row.sleeve === sleeve && pot.origins.some((origin) => origin.id === row.vault_id))
        .reduce((sum, row) => sum + BigInt(row.amount_raw), 0n);
      return { symbol: pot.quoteSymbol, amount: uiAmount(raw, pot.quoteDecimals) };
    });
  const clashMakeup = sleeveMakeup("clash");
  const globalMakeup = sleeveMakeup("jackpot");

  const clashRow = clash.rows[0];
  const clashUsd = money(Math.max(Number(clashRow?.clash_pot_usd || 0), clashFromSleeves));
  const jackpotUsd = money(Math.max(Number(clashRow?.jackpot_pot_usd || 0), jackpotFromSleeves));
  const jackpotChance = (clashRow?.jackpot_chance_bps ?? 500) / 10_000;

  const productiveUsd = money(usdFromRaw(reserveRaw, live.quoteDecimals, livePrice));
  const originSums = await pool.query<{ vault_id: string; origin_id: string; amount_raw: string }>(
    `SELECT vault_id, origin_id, SUM(amount_raw::numeric)::text AS amount_raw
     FROM sweep_origins GROUP BY vault_id, origin_id`,
  );

  const pools = pots().map((pot) => {
    const vault = pot.origins[0];
    const vaultEpochs = epochs.rows.filter((e) => e.vault_id === vault.id);
    const current =
      vault.id === live.id && collectingEpoch
        ? collectingEpoch
        : vaultEpochs[0]
          ? vaultEpochs.find((e) => e.status === "Open") || vaultEpochs[0]
          : null;
    const currentId = current && "id" in current ? current.id.toString() : current && "epoch_id" in current ? (current as { epoch_id: string }).epoch_id : null;
    const onChain = vault.id === live.id && collectingEpoch ? collectingEpoch : null;
    const totalRaw = onChain ? onChain.total : current && "total_raw" in (current as object)
      ? BigInt((current as { total_raw: string }).total_raw)
      : pooledByVault.get(vault.id) ?? 0n;
    const totalWeight = onChain ? onChain.totalWeight : current && "total_weight" in (current as object)
      ? BigInt((current as { total_weight: string }).total_weight)
      : 0n;
    const drawSlot = onChain ? onChain.drawSlot : current && "draw_slot" in (current as object)
      ? BigInt((current as { draw_slot: string }).draw_slot)
      : 0n;
    const status = onChain ? onChain.status : current && "status" in (current as object)
      ? (current as { status: string }).status
      : vault.status;
    const cutoff = config?.cutoff ?? 4500n;
    const slotsLeft = onChain && (onChain.status === "Open" || onChain.status === "Closed")
      ? Number(drawSlot - cutoff - BigInt(slot))
      : null;
    const chain = Boolean(config && pot.quoteMint && pot.quoteMint === config.mint.toBase58());
    const drawing = chain && slotsLeft !== null && slotsLeft <= 0;
    const mine = wallet
      ? onChain
        ? onChain.depositors.find((d) => d.wallet.toBase58() === wallet)
        : depositors.rows.find((d) => d.vault_id === vault.id && d.epoch_id === currentId && d.wallet === wallet)
      : null;
    const myAmount = mine ? ("amount" in mine ? mine.amount : BigInt((mine as { amount_raw: string }).amount_raw)) : 0n;
    const myWeight = mine ? ("weight" in mine ? mine.weight : BigInt((mine as { weight: string }).weight)) : 0n;
    const px = vault.quoteMint ? prices.get(vault.quoteMint) || 0 : 0;
    const lifetime = pooledByVault.get(vault.id) ?? 0n;
    const swept = sweepSum.rows.find((s) => s.vault_id === vault.id);
    const origins = pot.origins.map((origin) => {
      const tagged = originSums.rows
        .filter((row) => row.vault_id === pot.id && row.origin_id === origin.id)
        .reduce((sum, row) => sum + BigInt(row.amount_raw), 0n);
      const shown = pot.origins.length === 1 && tagged === 0n ? totalRaw : tagged;
      return {
        id: origin.id,
        symbol: origin.baseSymbol,
        amount: uiAmount(shown, pot.quoteDecimals),
        amountUsd: money(usdFromRaw(shown, pot.quoteDecimals, px)),
        sharePct: chance(shown, totalRaw),
      };
    });
    return {
      id: pot.id,
      name: pot.origins.length > 1 ? `${pot.quoteSymbol} pot` : vault.name,
      crop: vault.crop,
      flavor: pot.origins.length > 1 ? `${pot.quoteSymbol} from ${pot.origins.map((o) => o.baseSymbol).join(" and ")}` : vault.flavor,
      baseSymbol: pot.origins.length > 1 ? pot.quoteSymbol : vault.baseSymbol,
      quoteSymbol: vault.quoteSymbol,
      quoteMint: pot.quoteMint,
      quoteDecimals: pot.quoteDecimals,
      origins,
      status: chain ? "live" : "open",
      epochId: onChain ? onChain.id.toString() : currentId,
      epochStatus: drawing ? "Paused" : chain && onChain?.status === "Open" ? "Open" : chain ? status : "Open",
      rewardsPooled: uiAmount(lifetime, vault.quoteDecimals),
      rewardsPooledUsd: money(usdFromRaw(lifetime, vault.quoteDecimals, px)),
      currentPooled: uiAmount(totalRaw, vault.quoteDecimals),
      currentPooledUsd: money(usdFromRaw(totalRaw, vault.quoteDecimals, px)),
      swept: swept ? uiAmount(swept.amount_raw, vault.quoteDecimals) : "0",
      drawSlot: drawSlot.toString(),
      slotsLeft,
      secondsLeft: slotsLeft === null ? null : Math.max(0, Math.round(slotsLeft * 0.4)),
      yourAmount: wallet ? uiAmount(myAmount, vault.quoteDecimals) : null,
      yourAmountUsd: wallet ? money(usdFromRaw(myAmount, vault.quoteDecimals, px)) : null,
      yourAmountRaw: wallet ? myAmount.toString() : null,
      yourWeight: wallet ? myWeight.toString() : null,
      totalWeight: totalWeight.toString(),
      yourSharePct: wallet ? chance(myAmount, totalRaw) : null,
      yourWinPct: wallet ? chance(myWeight, totalWeight) : null,
      yourLots: null as { amount: string; weight: string }[] | null,
      depositors: (onChain ? onChain.depositors : depositors.rows.filter((d) => d.vault_id === vault.id && d.epoch_id === currentId)).map((d) => ({
        wallet: "wallet" in d && typeof d.wallet !== "string" ? d.wallet.toBase58() : (d as { wallet: string }).wallet,
        amount: uiAmount("amount" in d && typeof d.amount === "bigint" ? d.amount : (d as { amount_raw: string }).amount_raw, vault.quoteDecimals),
        amountRaw: ("amount" in d && typeof d.amount === "bigint" ? d.amount : BigInt((d as { amount_raw: string }).amount_raw)).toString(),
        weight: ("weight" in d && typeof d.weight === "bigint" ? d.weight : BigInt((d as { weight: string }).weight)).toString(),
        winPct: chance(
          "weight" in d && typeof d.weight === "bigint" ? d.weight : (d as { weight: string }).weight,
          totalWeight,
        ),
      })),
    };
  });

  const engine = await Promise.all(VAULTS.map(async (vault) => {
    const px = vault.quoteMint ? prices.get(vault.quoteMint) || 0 : 0;
    const pot = pots().find((item) => item.origins.some((origin) => origin.id === vault.id));
    const mine = originSums.rows
      .filter((row) => row.vault_id === pot?.id && row.origin_id === vault.id)
      .reduce((sum, row) => sum + BigInt(row.amount_raw), 0n);
    const potTotal = originSums.rows
      .filter((row) => row.vault_id === pot?.id)
      .reduce((sum, row) => sum + BigInt(row.amount_raw), 0n);
    const queued = vault.quoteMint === live.quoteMint
      ? pot && pot.origins.length > 1 && potTotal > 0n
        ? (reserveRaw * mine) / potTotal
        : pot?.origins.length === 1
          ? reserveRaw
          : 0n
      : 0n;
    const held = vault.baseMint ? await baseHeld(connection, vault.baseMint) : 0n;
    const generated = yieldRows
      .filter((s) => s.vault_id === vault.id)
      .reduce((sum, s) => sum + BigInt(s.amount_raw), 0n);
    const planned = WATERFALL.map((w) => {
      const raw = yieldRows
        .filter((s) => s.vault_id === vault.id && s.sleeve === w.sleeve)
        .reduce((sum, s) => sum + BigInt(s.amount_raw), 0n);
      return {
        sleeve: w.sleeve,
        label: w.label,
        bps: w.bps,
        amount: uiAmount(raw, vault.quoteDecimals),
        usd: money(usdFromRaw(raw, vault.quoteDecimals, px)),
      };
    });
    return {
      id: vault.id,
      symbol: vault.baseSymbol,
      quoteSymbol: vault.quoteSymbol,
      baseSymbol: vault.baseSymbol,
      crop: vault.crop,
      amount: uiAmount(held, 6),
      amountUsd: money(usdFromRaw(held, 6, vault.baseMint ? prices.get(vault.baseMint) || 0 : 0)),
      queuedQuote: uiAmount(queued, vault.quoteDecimals),
      queuedQuoteUsd: money(usdFromRaw(queued, vault.quoteDecimals, px)),
      generated: uiAmount(generated, vault.quoteDecimals),
      generatedUsd: money(usdFromRaw(generated, vault.quoteDecimals, px)),
      note:
        vault.id === live.id
          ? `${uiAmount(queued, vault.quoteDecimals)} ${vault.quoteSymbol} is queued to buy ${vault.baseSymbol}. The productive reserve holds ${vault.baseSymbol}, not ${vault.quoteSymbol}. Only ${vault.quoteSymbol} that ${vault.baseSymbol} later earns is split into the buckets.`
          : "This pot is not live, so nothing is queued to buy the base.",
      breakdown: planned,
    };
  }));

  const bags = await walletHoldings(connection, wallet ? new PublicKey(wallet) : null, prices);

  let portfolio = null;
  if (wallet && config) {
    const owner = new PublicKey(wallet);
    const quoteBal = await tokenAmount(connection, config.mint, owner);
    const allow = await allowanceFor(connection, config.mint, configPda(), owner);
    const mine = epochs.rows.flatMap((e) => {
      const vault = VAULTS.find((v) => v.id === e.vault_id);
      if (!vault) return [];
      const dep = depositors.rows.find((d) => d.vault_id === e.vault_id && d.epoch_id === e.epoch_id && d.wallet === wallet);
      if (!dep && e.winner !== wallet) return [];
      return [
        {
          vaultId: e.vault_id,
          epochId: e.epoch_id,
          status: e.status,
          contributed: dep ? uiAmount(dep.amount_raw, vault.quoteDecimals) : "0",
          winPct: dep ? chance(dep.weight, e.total_weight) : 0,
          won: e.winner === wallet,
          prize: e.prize_raw ? uiAmount(e.prize_raw, vault.quoteDecimals) : null,
        },
      ];
    });
    portfolio = {
      wallet,
      quoteSymbol: live.quoteSymbol,
      walletQuote: uiAmount(quoteBal, live.quoteDecimals),
      allowance: allow ? uiAmount(allow.delegated, live.quoteDecimals) : "0",
      waitingSweep: allow ? uiAmount(allow.pull, live.quoteDecimals) : "0",
      history: mine,
    };
  }

  return {
    serverNow: Date.now(),
    slot,
    programId: PROGRAM_ID.toBase58(),
    configPda: configPda().toBase58(),
    vaultAta: config ? ata(config.mint, configPda()).toBase58() : null,
    paused: config?.paused ?? false,
    authority: config?.authority.toBase58() ?? null,
    collectingEpoch: config?.collecting.toString() ?? "0",
    home: {
      rewardsPooledUsd: money(rewardsPooledUsd),
      highestWinningUsd: highestWinning?.usd ?? 0,
      highestWinning,
      productivePoolUsd: productiveUsd,
      clashPoolUsd: clashUsd,
      globalPrizeUsd: jackpotUsd,
      jackpotChance,
      jackpotChanceLabel: `${(jackpotChance * 100).toFixed(0)}%`,
    },
    pools,
    engine,
    bags,
    clash: {
      clashPoolUsd: clashUsd,
      globalPrizeUsd: jackpotUsd,
      clashMakeup,
      globalMakeup,
      jackpotChance,
      jackpotChanceLabel: `${(jackpotChance * 100).toFixed(0)}%`,
      participation: false,
      note: "Clash and Global Prize are display-only. CompetitionCore is not deployed. Chance starts at 5% and rises 5% after each week that consumes randomness without a trigger, cap 50%.",
      branches: VAULTS.map((v) => ({
        id: v.id,
        name: v.baseSymbol,
        crop: v.crop,
        score: null,
        registered: false,
      })),
    },
    portfolio,
    keeper: heartbeats.rows,
    prices: Object.fromEntries(prices),
    reserve: {
      symbol: live.quoteSymbol,
      amount: uiAmount(reserveRaw, live.quoteDecimals),
      usd: productiveUsd,
      treasury: uiAmount(treasuryRaw, live.quoteDecimals),
    },
  };
}

type FarmSnapshot = Awaited<ReturnType<typeof buildState>>;

async function historyFor(wallet: string) {
  const { rows } = await pool.query<{
    vault_id: string;
    epoch_id: string;
    status: string;
    total_weight: string;
    winner: string | null;
    prize_raw: string | null;
    amount_raw: string | null;
    weight: string | null;
  }>(
    `SELECT e.vault_id, e.epoch_id, e.status, e.total_weight, e.winner, e.prize_raw,
            d.amount_raw, d.weight
     FROM epochs e
     LEFT JOIN depositors d
       ON d.vault_id = e.vault_id AND d.epoch_id = e.epoch_id AND d.wallet = $1
     WHERE d.wallet IS NOT NULL OR e.winner = $1
     ORDER BY e.epoch_id DESC`,
    [wallet],
  );
  return rows.flatMap((row) => {
    const vault = VAULTS.find((item) => item.id === row.vault_id);
    if (!vault) return [];
    return [
      {
        vaultId: row.vault_id,
        epochId: row.epoch_id,
        status: row.status,
        contributed: row.amount_raw ? uiAmount(row.amount_raw, vault.quoteDecimals) : "0",
        winPct: row.weight ? chance(row.weight, row.total_weight) : 0,
        won: row.winner === wallet,
        prize: row.prize_raw ? uiAmount(row.prize_raw, vault.quoteDecimals) : null,
      },
    ];
  });
}

export async function loadWalletSlice(connection: Connection, base: FarmSnapshot, wallet: string) {
  const prices = new Map(Object.entries(base.prices).map(([mint, usd]) => [mint, Number(usd)]));
  const bags = await walletHoldings(connection, new PublicKey(wallet), prices);
  const sweeps = await pool.query<{
    vault_id: string;
    epoch_id: string;
    amount_raw: string;
    weight: string | null;
  }>(
    `SELECT vault_id, epoch_id, amount_raw, weight
     FROM sweeps WHERE wallet = $1 ORDER BY id ASC`,
    [wallet],
  );
  const live = base.pools.find((plot) => plot.status === "live" && plot.quoteMint);
  if (!live?.quoteMint) return { bags, portfolio: null, sweeps: sweeps.rows };
  const owner = new PublicKey(wallet);
  const mint = new PublicKey(live.quoteMint);
  const [quoteBal, allow, history] = await Promise.all([
    tokenAmount(connection, mint, owner),
    allowanceFor(connection, mint, configPda(), owner),
    historyFor(wallet),
  ]);
  return {
    bags,
    portfolio: {
      wallet,
      quoteSymbol: live.quoteSymbol,
      walletQuote: uiAmount(quoteBal, live.quoteDecimals),
      allowance: allow ? uiAmount(allow.delegated, live.quoteDecimals) : "0",
      waitingSweep: allow ? uiAmount(allow.pull, live.quoteDecimals) : "0",
      history,
    },
    sweeps: sweeps.rows,
  };
}

export function applyWallet(base: FarmSnapshot, wallet: string, slice: Awaited<ReturnType<typeof loadWalletSlice>>) {
  return {
    ...base,
    pools: base.pools.map((plot) => {
      const mine = plot.depositors.find((row) => row.wallet === wallet);
      const amount = mine?.amount ?? "0";
      const yours = Number(amount || "0");
      const pot = Number(plot.currentPooled || "0");
      const px = plot.quoteMint ? Number(base.prices[plot.quoteMint] || 0) : 0;
      const originIds = new Set([plot.id, ...plot.origins.map((origin) => origin.id)]);
      const rows = slice.sweeps.filter(
        (row) => originIds.has(row.vault_id) && String(row.epoch_id) === String(plot.epochId ?? ""),
      );
      const lots =
        rows.length > 0 && rows.every((row) => row.weight != null)
          ? rows.map((row) => ({ amount: row.amount_raw, weight: row.weight as string }))
          : null;
      return {
        ...plot,
        yourAmount: amount,
        yourAmountUsd: Number((yours * px).toFixed(2)),
        yourAmountRaw: mine?.amountRaw ?? "0",
        yourWeight: mine?.weight ?? "0",
        yourSharePct: pot > 0 ? Math.round((yours / pot) * 10000) / 100 : 0,
        yourWinPct: mine?.winPct ?? 0,
        yourLots: lots,
      };
    }),
    bags: slice.bags,
    portfolio: slice.portfolio,
  };
}
