import { useEffect, useState } from "react";
import { pair, remainingSeconds, type FarmState, type PoolView } from "../api";
import { assembleLots, chanceAfterRemove, parseTokenAmount } from "../chance";
import { Countdown } from "../Countdown";
import { Ticker } from "../Ticker";

export function Pool(props: {
  state: FarmState;
  onAllow: (plot: PoolView, amount: string, unlimited: boolean) => void;
  onRevoke: (plot: PoolView) => void;
  onRemove: (plot: PoolView, amount: string) => void;
  canAct: boolean;
  onSeeMore: () => void;
}) {
  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="kicker">Daily draws</p>
          <h1>HODL Pots</h1>
          <p className="lede">
            One pot per reward token. Contribute to the pot to have a chance at winning. Earlier deposits earn more weight.{" "}
            <button type="button" className="text-link" onClick={props.onSeeMore}>
              See more -&gt;
            </button>
          </p>
        </div>
      </header>
      <div className="farm-grid">
        {props.state.pools.map((plot) => (
          <PotCard
            key={plot.id}
            plot={plot}
            serverNow={props.state.serverNow}
            canAct={props.canAct}
            onAllow={props.onAllow}
            onRevoke={props.onRevoke}
            onRemove={props.onRemove}
          />
        ))}
      </div>
    </div>
  );
}

function PotCard({
  plot,
  serverNow,
  canAct,
  onAllow,
  onRevoke,
  onRemove,
}: {
  plot: PoolView;
  serverNow?: number;
  canAct: boolean;
  onAllow: (plot: PoolView, amount: string, unlimited: boolean) => void;
  onRevoke: (plot: PoolView) => void;
  onRemove: (plot: PoolView, amount: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const opened = plot.status === "live" || plot.status === "open";
  const left = remainingSeconds(plot.secondsLeft, serverNow, now);
  const paused = plot.status === "live" && (plot.epochStatus === "Paused" || (left !== null && left <= 0));
  const badge = !opened ? "Sealed" : paused ? "Paused for drawing" : "Open";
  const before = plot.yourWinPct ?? 0;

  return (
    <article className={`plot chest ${opened ? "live" : "untilled"}`}>
      <div className="lid" />
      <div className="plot-head">
        <Ticker id={plot.id} />
        <div>
          <h2>{plot.quoteSymbol}</h2>
        </div>
        <span className={`badge ${badge === "Open" ? "ok" : ""}`}>{badge}</span>
      </div>
      <div className="plot-stats">
        <div>
          <span>In the pot</span>
          <strong>{pair(plot.currentPooledUsd, plot.currentPooled, plot.quoteSymbol)}</strong>
        </div>
        <div>
          <span>Upcoming draw</span>
          <strong>{paused ? "0:00" : <Countdown secondsLeft={plot.secondsLeft} serverNow={serverNow} />}</strong>
        </div>
      </div>
      <h3 className="breakdown">Contribution breakdown</h3>
      <ul className="origins">
        {plot.origins.map((origin) => (
          <li key={origin.id}>
            <Ticker id={origin.id} small bob={false} />
            <span>{origin.symbol}</span>
            <strong>
              {Number(origin.amount || "0").toFixed(2)} {plot.quoteSymbol} · {Math.round(origin.sharePct)}%
            </strong>
          </li>
        ))}
      </ul>
      <div className="plot-stats">
        <div>
          <span>Your stake</span>
          <strong>{pair(plot.yourAmountUsd ?? 0, plot.yourAmount ?? "0", plot.quoteSymbol)}</strong>
        </div>
        <div>
          <span>Chance to win</span>
          <strong>{before.toFixed(2)}%</strong>
        </div>
      </div>
      {opened ? (
        <PotActions
          plot={plot}
          serverNow={serverNow}
          canAct={canAct}
          paused={paused}
          onAllow={onAllow}
          onRevoke={onRevoke}
          onRemove={onRemove}
          removeLabel="Remove"
        />
      ) : (
        <button disabled>Sealed</button>
      )}
    </article>
  );
}

export function PotActions({
  plot,
  serverNow,
  canAct,
  paused,
  onAllow,
  onRevoke,
  onRemove,
  removeLabel,
}: {
  plot: PoolView;
  serverNow?: number;
  canAct: boolean;
  paused: boolean;
  onAllow: (plot: PoolView, amount: string, unlimited: boolean) => void;
  onRevoke: (plot: PoolView) => void;
  onRemove: (plot: PoolView, amount: string) => void;
  removeLabel: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const left = remainingSeconds(plot.secondsLeft, serverNow, now);
  const frozen = paused || (plot.status === "live" && left !== null && left <= 0);
  const [approveOpen, setApproveOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [amount, setAmount] = useState("1");
  const [specific, setSpecific] = useState(false);
  const [removeAmount, setRemoveAmount] = useState("");
  const stake = Number(plot.yourAmount || "0");
  const removeN = Math.min(Number(removeAmount || "0"), stake);
  const before = plot.yourWinPct ?? 0;
  const after = previewChance(plot, removeAmount);
  return (
    <>
      <div className="plot-actions">
        <button className="primary" disabled={!canAct || paused} onClick={() => setApproveOpen(true)}>
          {stake > 0 ? "Add" : "Approve entry"}
        </button>
        <button
          disabled={!canAct || stake <= 0 || frozen}
          onClick={() => {
            setRemoveAmount(stake.toFixed(2));
            setRemoveOpen(true);
          }}
        >
          {removeLabel}
        </button>
        <button disabled={!canAct} onClick={() => onRevoke(plot)}>
          Revoke
        </button>
      </div>
      {approveOpen ? (
        <div className="modal-back" onClick={() => setApproveOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="x" onClick={() => setApproveOpen(false)} aria-label="Close">X</button>
            <h3>Approve entry</h3>
            <p>{approvalMessage(plot, amount, !specific)}</p>
            <label className="check">
              <input type="checkbox" checked={specific} onChange={(e) => setSpecific(e.target.checked)} />
              Approve a specific amount
            </label>
            {specific ? <input value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Cap" /> : null}
            <div className="row">
              <button
                className="primary"
                onClick={() => {
                  onAllow(plot, amount, !specific);
                  setApproveOpen(false);
                }}
              >
                Confirm
              </button>
              <button onClick={() => setApproveOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}
      {removeOpen ? (
        <div className="modal-back" onClick={() => setRemoveOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="x" onClick={() => setRemoveOpen(false)} aria-label="Close">X</button>
            <h3>Remove</h3>
            <p>
              You have {pair(plot.yourAmountUsd ?? 0, plot.yourAmount ?? "0", plot.quoteSymbol)} in this pot. That is the most you can take out. Newest entries come out first, so a later slice takes less chance with it than an earlier one.
            </p>
            <input value={removeAmount} onChange={(e) => setRemoveAmount(e.target.value)} aria-label="Amount to remove" />
            <div className="chance-shift">
              <span>Chance to win</span>
              <strong>
                {before.toFixed(2)}% → {after.toFixed(2)}%
              </strong>
            </div>
            <div className="row">
              <button
                className="primary"
                disabled={removeN <= 0 || frozen}
                onClick={() => {
                  onRemove(plot, removeAmount);
                  setRemoveOpen(false);
                }}
              >
                Confirm
              </button>
              <button onClick={() => setRemoveOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function previewChance(plot: PoolView, removeText: string) {
  const yourAmount = BigInt(plot.yourAmountRaw || "0");
  const yourWeight = BigInt(plot.yourWeight || "0");
  const totalWeight = BigInt(plot.totalWeight || "0");
  const remove = parseTokenAmount(removeText, plot.quoteDecimals);
  const recorded = (plot.yourLots ?? []).map((lot) => ({
    amount: BigInt(lot.amount),
    weight: BigInt(lot.weight),
  }));
  const lots = assembleLots(recorded, yourAmount, yourWeight);
  return chanceAfterRemove(yourAmount, yourWeight, totalWeight, remove, lots);
}

function approvalMessage(plot: PoolView, amount: string, unlimited: boolean) {
  const cap = unlimited ? "" : ` (up to ${amount || "0"} ${plot.quoteSymbol})`;
  const names = plot.origins.map((origin) => origin.symbol).join(", ");
  return `You are approving HODL to send your ${plot.quoteSymbol} rewards${cap} into the ${plot.quoteSymbol} HODL pool in return for a chance to win the full lottery. Payments from ${names} are sorted by the token that earned them. This does NOT grant HODL permissions to move your Stonk tokens, and this permission can be revoked at any time.`;
}
