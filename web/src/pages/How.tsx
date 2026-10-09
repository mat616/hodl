import { useEffect, useState } from "react";

const SECTIONS = ["Flow", "Pots", "Productive pools", "Clash", "Redacted", "Misc"] as const;
export type GuideSection = (typeof SECTIONS)[number];

export function How({ section, onSection }: { section: GuideSection; onSection: (next: GuideSection) => void }) {
  return (
    <div className="page">
      <header className="hero">
        <div>
          <h1>How HODL Works</h1>
          <p className="lede">
            Have a chance to turn reward payouts into something more. Inspired by PoolTogether.
          </p>
        </div>
      </header>
      <div className="works-tabs">
        {SECTIONS.map((item) => (
          <button key={item} className={section === item ? "on" : ""} onClick={() => onSection(item)}>
            {item}
          </button>
        ))}
      </div>
      {section === "Flow" ? <FlowSection /> : null}
      {section === "Pots" ? <PotsSection /> : null}
      {section === "Productive pools" ? <PoolsSection /> : null}
      {section === "Clash" ? <ClashSection /> : null}
      {section === "Redacted" ? <RedactedSection /> : null}
      {section === "Misc" ? <MiscSection /> : null}
    </div>
  );
}

function FlowSection() {
  return (
    <section className="panel">
      <h2>The whole loop</h2>
      <Chain
        nodes={[
          { id: "pay", n: 1, label: "Payout", x: 90, y: 64 },
          { id: "ok", n: 2, label: "Approve", x: 250, y: 64 },
          { id: "pot", n: 3, label: "Pot", x: 410, y: 64 },
          { id: "draw", n: 4, label: "Draw", x: 570, y: 64 },
          { id: "win", n: 5, label: "Winner", x: 570, y: 196 },
          { id: "buy", n: 6, label: "Buy", x: 410, y: 196 },
          { id: "earn", n: 7, label: "Earn", x: 250, y: 196 },
        ]}
        links={[
          ["pay", "ok"],
          ["ok", "pot"],
          ["pot", "draw"],
          ["draw", "win"],
          ["draw", "buy"],
          ["buy", "earn"],
          ["earn", "pot", "back"],
        ]}
        notes={[
          "A reward token is paid into your wallet.",
          "You approve HODL to sweep that reward. Your stonk token stays untouched and no transfer fee is applied.",
          "The reward joins the correct pot (ex.- KNOTS -> STONK -> STONK pot). Earlier deposits earn more weight.",
          "10 minutes before the draw, the pot pauses. Then a winner is drawn from a Switchboard randomness value. The draw is not yet trust-minimized — see the Terms.",
          "The winner receives 95% of the pot.",
          "4% buys the productive stonk (ex.- STONK pot -> draw -> 4% buys KNOTS/STONKITTY/etc). 0.5% is used to add liquidity to the top contributor's pool. 0.5% goes to the treasury.",
          "Those stonks earn more rewards in the Tendies pools. The rewards generated in the Tendies pools are then added to the next pot.",
        ]}
      />
    </section>
  );
}

function PotsSection() {
  return (
    <section className="panel">
      <h2>One pot per reward</h2>
      <p className="lede">
        STONK, ZEC, wNEAR, and GLDX each have one pot. NEARKAT and DARK both feed wNEAR. KNOTS and STONKITTY both feed STONK. The draw is shared.
      </p>
      <Chain
        nodes={[
          { id: "in", n: 1, label: "Reward", x: 100, y: 64 },
          { id: "tag", n: 2, label: "Sorted", x: 270, y: 64 },
          { id: "pot", n: 3, label: "Pot", x: 440, y: 64 },
          { id: "wait", n: 4, label: "Weight", x: 440, y: 196 },
          { id: "stop", n: 5, label: "Pause", x: 270, y: 196 },
          { id: "win", n: 6, label: "Winner", x: 100, y: 196 },
        ]}
        links={[
          ["in", "tag"],
          ["tag", "pot"],
          ["pot", "wait"],
          ["wait", "stop"],
          ["stop", "win"],
          ["win", "in", "back"],
        ]}
        notes={[
          "A reward payment arrives in your wallet.",
          "HODL reads which stonk earned it and files it under that reward.",
          "The tokens join that reward's one shared pot.",
          "Weight equals the amount times the slots left until the draw. Earlier entry weighs more.",
          "10 minutes before the draw, new entries and removals stop.",
          "One winner takes 95%. The green arrow is the next pot opening, and the cycle starts again.",
        ]}
      />
    </section>
  );
}

function PoolsSection() {
  return (
    <section className="panel">
      <h2>The pile that keeps earning</h2>
      <p className="lede">
        Each reward has a productive pile. The 4% slice buys the stonks that earned that reward, split by where the swept tokens came from.
      </p>
      <Chain
        nodes={[
          { id: "pay", n: 1, label: "Payout", x: 120, y: 78 },
          { id: "buy", n: 2, label: "Buy", x: 300, y: 78 },
          { id: "hold", n: 3, label: "Pile", x: 480, y: 78 },
          { id: "earn", n: 4, label: "Earn", x: 300, y: 200 },
        ]}
        links={[
          ["pay", "buy"],
          ["buy", "hold"],
          ["hold", "earn"],
          ["earn", "pay", "back"],
          ["earn", "buy", "back"],
        ]}
        notes={[
          "A pot pays out.",
          "4% of it buys the stonks in that reward's pile.",
          "The pile holds those stonks.",
          "The stonks earn more of the same reward. One green arrow sends that back toward the next drawing. The other buys more of the pile.",
        ]}
      />
    </section>
  );
}

function ClashSection() {
  return (
    <section className="panel">
      <h2>Clash</h2>
      <ComingSoon />
      <Chain
        nodes={[
          { id: "clan", n: 1, label: "Clans", x: 120, y: 78 },
          { id: "pot", n: 2, label: "Clash pot", x: 320, y: 78 },
          { id: "week", n: 3, label: "Week", x: 520, y: 78 },
          { id: "global", n: 4, label: "Global pot", x: 320, y: 200 },
        ]}
        links={[
          ["clan", "pot"],
          ["pot", "week"],
          ["global", "pot"],
          ["week", "clan", "back"],
        ]}
        notes={[
          "Clans line up. Joining is closed until the competition exists.",
          "The clash pot is the weekly prize.",
          "Once a week, the fight resolves.",
          "The global pot can fall in on top of the clash pot. The green arrow is the next week starting over.",
        ]}
      />
    </section>
  );
}

function RedactedSection() {
  return (
    <section className="panel">
      <h2>Redacted</h2>
      <p className="lede">This mechanism is not published yet.</p>
    </section>
  );
}

function MiscSection() {
  return (
    <div className="page">
      <section className="panel">
        <h2>Chance to win</h2>
        <p className="lede">
          A deposit does not buy an equal ticket. It adds weight equal to the token amount times the slots still left before the draw. A later deposit of the same size adds less weight, because fewer slots remain. Adding again stacks a new slice at the new remaining time. Taking tokens out undoes the newest slice first.
        </p>
        <p className="lede">Your chance is your weight divided by the weight of everyone in that pot.</p>
        <div className="formula">chance = your weight / total weight</div>
        <p className="lede">300 weight in a pot of 1,000 weight is a 30% chance. The percent on the pot is that ratio.</p>
      </section>
      <section className="panel">
        <h2>How the winner is picked</h2>
        <Chain
          nodes={[
            { id: "commit", n: 1, label: "Commit", x: 110, y: 70 },
            { id: "reveal", n: 2, label: "Reveal", x: 280, y: 70 },
            { id: "check", n: 3, label: "Check", x: 450, y: 70 },
            { id: "mod", n: 4, label: "Remainder", x: 450, y: 190 },
            { id: "walk", n: 5, label: "Walk", x: 280, y: 190 },
            { id: "win", n: 6, label: "Winner", x: 110, y: 190 },
          ]}
          links={[
            ["commit", "reveal"],
            ["reveal", "check"],
            ["check", "mod"],
            ["mod", "walk"],
            ["walk", "win"],
          ]}
          notes={[
            "Before the value exists, a Switchboard account is committed to a future slot and saved on the epoch.",
            "After that slot, Switchboard writes a 32-byte value.",
            "The program checks it is the account stored on the epoch, that Switchboard owns it, and that the value has been revealed.",
            "The first 16 bytes, read as a little-endian number, are divided by the total weight. The remainder is the target.",
            "Depositors are walked in stored order, adding each weight.",
            "The first depositor whose running total passes the target wins.",
          ]}
        />
      </section>
      <section className="panel">
        <h2>Check a result yourself</h2>
        <ol className="steps">
          <li>Open the settled epoch and copy the Switchboard account stored on it.</li>
          <li>
            Open that account. Its owner must be the Switchboard program id set in the program, the reveal slot must be set, and the 32-byte value at byte 152 must not be all zeros.
          </li>
          <li>Take the first 16 bytes of that value and read them as a little-endian integer.</li>
          <li>Divide by the epoch's total weight and keep the remainder. That remainder is the target.</li>
          <li>Walk the depositor list in the order stored on the epoch. Add each weight. The first wallet whose running total is greater than the target is the winner.</li>
          <li>Match that wallet to the winner on the epoch and to the payout transaction.</li>
        </ol>
      </section>
    </div>
  );
}

type ChainNode = { id: string; n: number; label: string; x: number; y: number };
type ChainLink = [string, string] | [string, string, "back"];

function Chain({ nodes, links, notes }: { nodes: ChainNode[]; links: ChainLink[]; notes: string[] }) {
  return (
    <div className="chain">
      <svg viewBox="0 0 680 280" role="img" aria-label="Flow diagram">
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
            <path d="M0,0 L7,3 L0,6 Z" fill="#111" />
          </marker>
          <marker id="arrow-back" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
            <path d="M0,0 L7,3 L0,6 Z" fill="#1d4d12" />
          </marker>
        </defs>
        {links.map((link) => {
          const from = nodes.find((node) => node.id === link[0])!;
          const to = nodes.find((node) => node.id === link[1])!;
          const back = link[2] === "back";
          const d = back ? loopPath(from, to) : linePath(from, to);
          return (
            <path
              key={link.join("-")}
              d={d}
              fill="none"
              stroke={back ? "#1d4d12" : "#111"}
              strokeWidth="3"
              markerEnd={back ? "url(#arrow-back)" : "url(#arrow)"}
            />
          );
        })}
        {nodes.map((node) => (
          <g key={node.id}>
            <rect x={node.x - 58} y={node.y - 24} width="116" height="48" fill="#efe2c4" stroke="#111" strokeWidth="3" />
            <text x={node.x - 46} y={node.y - 6} fontSize="13" fontFamily="VT323, monospace">
              {node.n}
            </text>
            <text x={node.x} y={node.y + 10} textAnchor="middle" fontSize="18" fontFamily="VT323, monospace">
              {node.label}
            </text>
          </g>
        ))}
      </svg>
      <p className="loop-key">Green arrows are value looping back.</p>
      <ol className="steps">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ol>
    </div>
  );
}

function linePath(from: ChainNode, to: ChainNode) {
  const start = edgePoint(from, to);
  const end = edgePoint(to, from);
  return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
}

function edgePoint(from: ChainNode, to: ChainNode) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const sx = dx === 0 ? Number.POSITIVE_INFINITY : 58 / Math.abs(dx);
  const sy = dy === 0 ? Number.POSITIVE_INFINITY : 24 / Math.abs(dy);
  const t = Math.min(sx, sy);
  return { x: from.x + dx * t, y: from.y + dy * t };
}

function loopPath(from: ChainNode, to: ChainNode) {
  const y = Math.max(from.y, to.y) + 62;
  const mid = (from.x + to.x) / 2;
  return `M ${from.x} ${from.y + 24} Q ${mid} ${y} ${to.x} ${to.y + 24}`;
}

function ComingSoon() {
  const [dots, setDots] = useState(1);
  useEffect(() => {
    const id = setInterval(() => setDots((n) => (n % 3) + 1), 450);
    return () => clearInterval(id);
  }, []);
  return <p className="lede">Coming Soon{".".repeat(dots)}</p>;
}
