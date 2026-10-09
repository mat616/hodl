import { pair, shortKey, usd, type FarmState, type Holding, type PoolView } from "../api";
import { PotActions } from "./Pool";
import { Ticker } from "../Ticker";

export function Portfolio({
  state,
  connected,
  canAct,
  onAllow,
  onRevoke,
  onRemove,
}: {
  state: FarmState;
  connected: boolean;
  canAct: boolean;
  onAllow: (plot: PoolView, amount: string, unlimited: boolean) => void;
  onRevoke: (plot: PoolView) => void;
  onRemove: (plot: PoolView, amount: string) => void;
}) {
  const p = state.portfolio;
  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="kicker">Inventory</p>
          <h1>Bags</h1>
          <p className="lede">{connected && p ? shortKey(p.wallet) : "Connect Phantom to fill these rows."}</p>
        </div>
      </header>
      <section className="panel">
        <h2>Stonks</h2>
        <div className="table-wrap">
          <table className="bags">
            <thead>
              <tr>
                <th>Stonk</th>
                <th>Amount</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {state.bags.stonks.map((row) => (
                <HoldingRow key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>Tendies</h2>
        <div className="table-wrap">
          <table className="bags">
            <thead>
              <tr>
                <th>Reward</th>
                <th>Amount</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {state.bags.rewards.map((row) => (
                <HoldingRow key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>Pots</h2>
        <div className="table-wrap">
          <table className="bags">
            <thead>
              <tr>
                <th>Pot</th>
                <th>Total</th>
                <th>Added</th>
                <th>Chance</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.pools.map((plot) => {
                const paused = plot.status === "live" && plot.epochStatus === "Paused";
                return (
                  <tr key={plot.id}>
                    <td>
                      <span className="cell-asset">
                        <Ticker id={plot.id} small bob={false} />
                        {plot.quoteSymbol}
                      </span>
                    </td>
                    <td>{pair(plot.currentPooledUsd, plot.currentPooled, plot.quoteSymbol)}</td>
                    <td>{pair(plot.yourAmountUsd ?? 0, plot.yourAmount ?? "0", plot.quoteSymbol)}</td>
                    <td>{(plot.yourWinPct ?? 0).toFixed(2)}%</td>
                    <td>
                      <PotActions
                        plot={plot}
                        serverNow={state.serverNow}
                        canAct={canAct}
                        paused={paused}
                        onAllow={onAllow}
                        onRevoke={onRevoke}
                        onRemove={onRemove}
                        removeLabel="Remove entry"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <article className="panel">
        <h2>Past draws</h2>
        <div className="table-wrap">
          <table className="bags">
            <thead>
              <tr>
                <th>Pot</th>
                <th>Epoch</th>
                <th>In</th>
                <th>Chance</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {(p?.history ?? []).map((row) => (
                <tr key={`${row.vaultId}-${row.epochId}`}>
                  <td>{row.vaultId}</td>
                  <td>{row.epochId}</td>
                  <td>{row.contributed}</td>
                  <td>{row.winPct.toFixed(2)}%</td>
                  <td>{row.won ? `tendies ${row.prize}` : row.status}</td>
                </tr>
              ))}
              {!p?.history.length ? (
                <tr>
                  <td colSpan={5}>No draws yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  );
}

function HoldingRow({ row }: { row: Holding }) {
  const amount = row.amount === null ? "—" : Number(row.amount).toFixed(2);
  return (
    <tr>
      <td>
        <span className="cell-asset">
          <Ticker id={row.id} small bob={false} />
          {row.symbol}
        </span>
      </td>
      <td>
        {amount}
        {row.amount === null ? "" : ` ${row.symbol}`}
      </td>
      <td>{row.usd === null ? "—" : usd(row.usd)}</td>
    </tr>
  );
}
