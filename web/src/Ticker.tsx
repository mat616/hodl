import { tickerFor } from "./tokens";

export function Ticker({ id, bob = true, small = false }: { id: string; bob?: boolean; small?: boolean }) {
  const token = tickerFor(id);
  if (!token) return <span className="item empty" />;
  const className = `item ${small ? "sm" : ""} ${bob ? "bob" : ""}`;
  return (
    <span className={className} title={token.symbol}>
      {token.image ? <img src={token.image} alt={token.symbol} /> : token.symbol}
    </span>
  );
}
