import { pair, usd, type FarmState } from "../api";
import { Ticker } from "../Ticker";

const ORDER = ["STONK", "ZEC", "wNEAR", "GLDX"];

export function Engine({ state }: { state: FarmState }) {
  const groups = ORDER.map((symbol) => ({
    symbol,
    id: symbol.toLowerCase(),
    assets: state.engine.filter((asset) => asset.quoteSymbol === symbol),
  })).filter((group) => group.assets.length);
  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="kicker">Infinite Tendies</p>
          <h1>Tendies</h1>
          <p className="lede">
            4% of all payouts go to our Tendies that continuously generates more rewards for each daily drawing, buys into the STONK reserve, and accumulates in the clash/global pots.
          </p>
        </div>
      </header>
      <div className="farm-grid">
        {groups.map((group) => {
          const generated = sum(group.assets.map((asset) => Number(asset.generated || "0")));
          const generatedUsd = sum(group.assets.map((asset) => asset.generatedUsd));
          const upcoming = sum(
            group.assets.map((asset) => Number(asset.breakdown.find((row) => row.sleeve === "local_prize")?.amount || "0")),
          );
          const upcomingUsd = sum(
            group.assets.map((asset) => asset.breakdown.find((row) => row.sleeve === "local_prize")?.usd || 0),
          );
          return (
            <article key={group.symbol} className="plot">
              <div className="plot-head">
                <Ticker id={group.id} />
                <div>
                  <h2>{group.symbol}</h2>
                </div>
              </div>
              <ul className="origins">
                {group.assets.map((asset) => (
                  <li key={asset.id}>
                    <Ticker id={asset.id} small bob={false} />
                    <span>{asset.baseSymbol}</span>
                    <strong>
                      {Number(asset.amount || "0").toFixed(2)} {asset.baseSymbol}
                      {asset.amountUsd ? ` · ${usd(asset.amountUsd)}` : ""}
                    </strong>
                  </li>
                ))}
              </ul>
              <div className="plot-stats">
                <div>
                  <span>Total generated</span>
                  <strong>{pair(generatedUsd, String(generated), group.symbol)}</strong>
                </div>
                <div>
                  <span>Next drawing</span>
                  <strong>{pair(upcomingUsd, String(upcoming), group.symbol)}</strong>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}
