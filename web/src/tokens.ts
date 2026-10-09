// image and quoteImage: a local path such as /wnear.png, or a URL. Leave blank to show the symbol.
export type Ticker = {
  id: string;
  symbol: string;
  image: string;
  quote: string;
  quoteImage: string;
};

export const TICKERS: Record<string, Ticker> = {
  wnear: {
    id: "wnear",
    symbol: "wNEAR",
    image: "/wnear.png",
    quote: "wNEAR",
    quoteImage: "/wnear.png",
  },
  gldx: {
    id: "gldx",
    symbol: "GLDX",
    image: "",
    quote: "GLDX",
    quoteImage: "",
  },
  nearkat: {
    id: "nearkat",
    symbol: "NEARKAT",
    image: "",
    quote: "wNEAR",
    quoteImage: "/wnear.png",
  },
  knots: {
    id: "knots",
    symbol: "KNOTS",
    image: "",
    quote: "STONK",
    quoteImage: "",
  },
  zcat: {
    id: "zcat",
    symbol: "ZCAT",
    image: "",
    quote: "ZEC",
    quoteImage: "",
  },
  zec: {
    id: "zec",
    symbol: "ZEC",
    image: "",
    quote: "ZEC",
    quoteImage: "",
  },
  dark: {
    id: "dark",
    symbol: "DARK",
    image: "",
    quote: "wNEAR",
    quoteImage: "/wnear.png",
  },
  stonkitty: {
    id: "stonkitty",
    symbol: "STONKITTY",
    image: "",
    quote: "STONK",
    quoteImage: "",
  },
  wow: {
    id: "wow",
    symbol: "WOW",
    image: "",
    quote: "GLDX",
    quoteImage: "",
  },
  mask: {
    id: "mask",
    symbol: "MASK",
    image: "",
    quote: "ZEC",
    quoteImage: "",
  },
  gp: {
    id: "gp",
    symbol: "GP",
    image: "",
    quote: "GLDX",
    quoteImage: "",
  },
  stonk: {
    id: "stonk",
    symbol: "STONK",
    image: "",
    quote: "STONK",
    quoteImage: "",
  },
};

export function tickerFor(id: string): Ticker | undefined {
  return TICKERS[id];
}
