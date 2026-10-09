export type WeightLot = {
  amount: bigint;
  weight: bigint;
};

/** Same two-decimal truncation as the snapshot `chance()` helper. */
export function chancePct(part: bigint, whole: bigint) {
  if (whole <= 0n) return 0;
  return Number((part * 10000n) / whole) / 100;
}

export function parseTokenAmount(text: string, decimals: number) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("-")) return 0n;
  const [whole, frac = ""] = trimmed.split(".");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return 0n;
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

/**
 * Rebuild the credited slices. Newest last.
 * Unknown leftover (a credit with no sweep row) is treated as the oldest lot.
 * If recorded slices overshoot the on-chain totals, return null and use pro-rata.
 */
export function assembleLots(
  recorded: WeightLot[],
  yourAmount: bigint,
  yourWeight: bigint,
): WeightLot[] | null {
  if (yourAmount <= 0n || yourWeight < 0n) return null;
  const credited = recorded.filter((lot) => lot.amount > 0n);
  const sumAmount = credited.reduce((sum, lot) => sum + lot.amount, 0n);
  const sumWeight = credited.reduce((sum, lot) => sum + lot.weight, 0n);
  if (sumAmount > yourAmount || sumWeight > yourWeight) return null;
  const leftoverAmount = yourAmount - sumAmount;
  const leftoverWeight = yourWeight - sumWeight;
  if (leftoverAmount === 0n) {
    return leftoverWeight === 0n ? credited : null;
  }
  return [{ amount: leftoverAmount, weight: leftoverWeight }, ...credited];
}

/** Floor-divide so a later on-chain remove can use the same integer rule. */
export function weightTaken(lots: WeightLot[], remove: bigint) {
  let left = remove;
  let taken = 0n;
  for (let i = lots.length - 1; i >= 0 && left > 0n; i--) {
    const lot = lots[i];
    if (lot.amount <= 0n) continue;
    const take = left < lot.amount ? left : lot.amount;
    taken += (lot.weight * take) / lot.amount;
    left -= take;
  }
  return taken;
}

/**
 * After-remove chance.
 * With lots: undo the newest credited slice first (LIFO).
 * Without lots: take the same fraction of stored weight as of tokens (pro-rata).
 */
export function chanceAfterRemove(
  yourAmount: bigint,
  yourWeight: bigint,
  totalWeight: bigint,
  remove: bigint,
  lots?: WeightLot[] | null,
) {
  if (yourAmount <= 0n || yourWeight <= 0n || totalWeight <= 0n || remove <= 0n) {
    return chancePct(yourWeight, totalWeight);
  }
  const takeAmount = remove < yourAmount ? remove : yourAmount;
  if (takeAmount === yourAmount) return 0;
  const takeWeight =
    lots && lots.length > 0
      ? weightTaken(lots, takeAmount)
      : (yourWeight * takeAmount) / yourAmount;
  const nextYou = yourWeight > takeWeight ? yourWeight - takeWeight : 0n;
  const nextTotal = totalWeight > takeWeight ? totalWeight - takeWeight : 0n;
  return chancePct(nextYou, nextTotal);
}
