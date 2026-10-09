export const API = import.meta.env.VITE_API ?? "";

export type HomeView = {
  rewardsPooledUsd: number;
  highestWinningUsd: number;
  highestWinning: {
    vaultId: string;
    amount: string;
    usd: number;
    winner: string;
    epochId: string;
  } | null;
  productivePoolUsd: number;
  clashPoolUsd: number;
  globalPrizeUsd: number;
  jackpotChance: number;
  jackpotChanceLabel: string;
};

export type PoolView = {
  id: string;
  name: string;
  crop: string;
  flavor: string;
  baseSymbol: string;
  quoteSymbol: string;
  quoteMint: string | null;
  quoteDecimals: number;
  status: string;
  epochId: string | null;
  epochStatus: string;
  rewardsPooled: string;
  rewardsPooledUsd: number;
  currentPooled: string;
  currentPooledUsd: number;
  swept: string;
  drawSlot: string;
  slotsLeft: number | null;
  secondsLeft: number | null;
  yourAmount: string | null;
  yourAmountUsd: number | null;
  yourAmountRaw: string | null;
  yourWeight: string | null;
  totalWeight: string | null;
  yourSharePct: number | null;
  yourWinPct: number | null;
  yourLots: { amount: string; weight: string }[] | null;
  origins: { id: string; symbol: string; amount: string; amountUsd: number; sharePct: number }[];
  depositors: { wallet: string; amount: string; amountRaw?: string; weight?: string; winPct: number }[];
};

export type EngineAsset = {
  id: string;
  symbol: string;
  quoteSymbol?: string;
  baseSymbol: string;
  crop: string;
  amount: string;
  amountUsd: number;
  queuedQuote?: string;
  queuedQuoteUsd?: number;
  generated: string;
  generatedUsd: number;
  note: string;
  breakdown: { sleeve: string; label: string; bps: number; amount: string; usd: number }[];
};

export type FarmState = {
  serverNow: number;
  slot: number;
  programId: string;
  configPda: string;
  vaultAta: string | null;
  paused: boolean;
  authority: string | null;
  collectingEpoch: string;
  home: HomeView;
  pools: PoolView[];
  engine: EngineAsset[];
  clash: {
    clashPoolUsd: number;
    globalPrizeUsd: number;
    clashMakeup: { symbol: string; amount: string }[];
    globalMakeup: { symbol: string; amount: string }[];
    jackpotChance: number;
    jackpotChanceLabel: string;
    participation: boolean;
    note: string;
    branches: { id: string; name: string; crop: string; score: number | null; registered: boolean }[];
  };
  bags: {
    stonks: Holding[];
    rewards: Holding[];
  };
  portfolio: {
    wallet: string;
    quoteSymbol: string;
    walletQuote: string;
    allowance: string;
    waitingSweep: string;
    history: {
      vaultId: string;
      epochId: string;
      status: string;
      contributed: string;
      winPct: number;
      won: boolean;
      prize: string | null;
    }[];
  } | null;
  keeper: { id: string; last_run: string | null; last_ok: boolean | null; last_error: string | null; detail: string | null }[];
  prices: Record<string, number>;
  reserve: { symbol: string; amount: string; usd: number; treasury: string };
};

export async function fetchState(wallet?: string): Promise<FarmState> {
  const q = wallet ? `?wallet=${wallet}` : "";
  const res = await fetch(`${API}/v1/state${q}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

export async function watchWallet(wallet: string) {
  await fetch(`${API}/v1/watch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet }),
  });
}

export function usd(n: number) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function pair(dollars: number, amount: string, symbol: string) {
  const asset = Number(amount || "0");
  const shown = Number.isFinite(asset) ? asset.toFixed(2) : amount;
  return `${usd(dollars)} (${shown} ${symbol})`;
}

export type Holding = {
  id: string;
  symbol: string;
  amount: string | null;
  usd: number | null;
};

export function remainingSeconds(secondsLeft: number | null, serverNow: number | undefined, now: number) {
  if (secondsLeft === null) return null;
  const origin = serverNow || now;
  return secondsLeft - Math.floor((now - origin) / 1000);
}

export function clock(seconds: number | null) {
  if (seconds === null) return "—";
  if (seconds <= 0) return "drawing";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = m.toString().padStart(2, "0");
  const ss = s.toString().padStart(2, "0");
  if (h) return `${h}:${mm}:${ss}`;
  return `${m}:${ss}`;
}

export function shortKey(key: string) {
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
