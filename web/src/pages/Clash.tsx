import { useEffect, useState } from "react";
import { usd, type FarmState } from "../api";

export function Clash({ state }: { state: FarmState }) {
  return (
    <div className="page">
      <header className="hero">
        <div>
          <h1>Clash</h1>
          <ComingSoon />
        </div>
      </header>
      <div className="stat-grid two">
        <article className="panel stat">
          <span>Clash pot</span>
          <strong>{usd(state.clash.clashPoolUsd)}</strong>
          <Makeup rows={state.clash.clashMakeup} />
        </article>
        <article className="panel stat">
          <span>Global pot</span>
          <strong>{usd(state.clash.globalPrizeUsd)}</strong>
          <Makeup rows={state.clash.globalMakeup} />
        </article>
      </div>
    </div>
  );
}

function Makeup({ rows }: { rows: { symbol: string; amount: string }[] }) {
  return (
    <ul className="origins">
      {rows.map((row) => (
        <li key={row.symbol}>
          <span>{row.symbol}</span>
          <strong>{Number(row.amount || "0").toFixed(2)}</strong>
        </li>
      ))}
    </ul>
  );
}

function ComingSoon() {
  const [dots, setDots] = useState(1);
  useEffect(() => {
    const id = setInterval(() => setDots((n) => (n % 3) + 1), 450);
    return () => clearInterval(id);
  }, []);
  return <p className="lede">Coming Soon{".".repeat(dots)}</p>;
}
