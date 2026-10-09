export type VaultStatus = "live" | "uninitialized" | "pending_mint";

export type VaultDef = {
  id: string;
  name: string;
  crop: string;
  flavor: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseMint: string | null;
  quoteMint: string | null;
  quoteDecimals: number;
  // originMint: mint used to match reward payouts. Often the same as baseMint.
  originMint: string | null;
  status: VaultStatus;
};

// Fill baseMint, quoteMint, and originMint before a vault can take deposits.
// baseMint: mint of the token that earned the reward.
// quoteMint: mint the pot holds.
// originMint: mint the rewards API uses for that token.
export const VAULTS: VaultDef[] = [
  {
    id: "nearkat",
    name: "NearKat Plot",
    crop: "🐈",
    flavor: "wNEAR harvest from NEARKAT holders",
    baseSymbol: "NEARKAT",
    quoteSymbol: "wNEAR",
    baseMint: null,
    quoteMint: null,
    quoteDecimals: 9,
    originMint: null,
    status: "live",
  },
  {
    id: "dark",
    name: "DARK Plot",
    crop: "🌑",
    flavor: "wNEAR harvest from DARK holders",
    baseSymbol: "DARK",
    quoteSymbol: "wNEAR",
    baseMint: null,
    quoteMint: null,
    quoteDecimals: 9,
    originMint: null,
    status: "uninitialized",
  },
  {
    id: "knots",
    name: "KNOTS Plot",
    crop: "🪢",
    flavor: "STONK harvest from KNOTS holders",
    baseSymbol: "KNOTS",
    quoteSymbol: "STONK",
    baseMint: null,
    quoteMint: null,
    quoteDecimals: 9,
    originMint: null,
    status: "uninitialized",
  },
  {
    id: "stonkitty",
    name: "STONKITTY Plot",
    crop: "🐱",
    flavor: "STONK harvest from STONKITTY holders",
    baseSymbol: "STONKITTY",
    quoteSymbol: "STONK",
    baseMint: null,
    quoteMint: null,
    quoteDecimals: 9,
    originMint: null,
    status: "uninitialized",
  },
  {
    id: "zcat",
    name: "ZCAT Plot",
    crop: "🐱",
    flavor: "ZEC harvest from ZCAT holders",
    baseSymbol: "ZCAT",
    quoteSymbol: "ZEC",
    baseMint: null,
    quoteMint: null,
    quoteDecimals: 8,
    originMint: null,
    status: "uninitialized",
  },
  {
    id: "mask",
    name: "MASK Plot",
    crop: "🎭",
    flavor: "ZEC harvest from MASK holders",
    baseSymbol: "MASK",
    quoteSymbol: "ZEC",
    baseMint: null,
    quoteMint: null,
    quoteDecimals: 8,
    originMint: null,
    status: "uninitialized",
  },
  {
    id: "gp",
    name: "GP Plot",
    crop: "🪙",
    flavor: "GLDX harvest from GP (RuneScape Gold) holders",
    baseSymbol: "GP",
    quoteSymbol: "GLDX",
    baseMint: null,
    quoteMint: null,
    quoteDecimals: 8,
    originMint: null,
    status: "uninitialized",
  },
  {
    id: "wow",
    name: "WOW Plot",
    crop: "🗡️",
    flavor: "GLDX harvest from WOW holders",
    baseSymbol: "WOW",
    quoteSymbol: "GLDX",
    baseMint: null,
    quoteMint: null,
    quoteDecimals: 8,
    originMint: null,
    status: "uninitialized",
  },
];

export type PotDef = {
  id: string;
  quoteSymbol: string;
  quoteMint: string | null;
  quoteDecimals: number;
  origins: VaultDef[];
};

export function pots(): PotDef[] {
  const groups = new Map<string, VaultDef[]>();
  for (const vault of VAULTS) {
    const key = vault.quoteMint ?? vault.quoteSymbol;
    groups.set(key, [...(groups.get(key) ?? []), vault]);
  }
  const order = ["STONK", "ZEC", "wNEAR", "GLDX"];
  return [...groups.values()]
    .map((origins) => {
      const first = origins[0];
      return {
        id: origins.length > 1 ? first.quoteSymbol.toLowerCase() : first.id,
        quoteSymbol: first.quoteSymbol,
        quoteMint: first.quoteMint,
        quoteDecimals: first.quoteDecimals,
        origins,
      };
    })
    .sort((a, b) => order.indexOf(a.quoteSymbol) - order.indexOf(b.quoteSymbol));
}

export function originsForQuote(quoteMint: string): VaultDef[] {
  return VAULTS.filter((vault) => vault.quoteMint === quoteMint);
}

export const LIVE_VAULT = VAULTS.find((v) => v.id === "nearkat")!;

// LP_POOL: pool address that receives the liquidity slice. Leave empty to skip naming it.
export const LP_POOL = "";

export const WATERFALL = [
  { sleeve: "local_prize", label: "Local daily prize", bps: 1000 },
  { sleeve: "clash", label: "Weekly Clash pot", bps: 1500 },
  { sleeve: "jackpot", label: "Global Prize", bps: 1500 },
  { sleeve: "reinvest", label: "Reinvest originating base", bps: 2500 },
  { sleeve: "fun_backing", label: "Buy STONK for FUN backing", bps: 2500 },
  { sleeve: "treasury", label: "Treasury", bps: 1000 },
] as const;

export function vaultByQuote(mint: string): VaultDef | undefined {
  return VAULTS.find((v) => v.quoteMint === mint);
}

export function vaultById(id: string): VaultDef | undefined {
  return VAULTS.find((v) => v.id === id);
}
