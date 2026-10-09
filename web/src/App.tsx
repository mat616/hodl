import { useCallback, useEffect, useMemo, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchState, shortKey, watchWallet, type FarmState } from "./api";
import { Clash } from "./pages/Clash";
import { Engine } from "./pages/Engine";
import { How, type GuideSection } from "./pages/How";
import { Pool } from "./pages/Pool";
import { Portfolio } from "./pages/Portfolio";
import { Legal, TERMS_VERSION, type LegalDoc } from "./pages/Legal";
import { isMuted, play, toggleMute } from "./sound";
import { Ticker } from "./Ticker";
import {
  CLUSTERS,
  DEFAULT_PROGRAM_ID,
  QUOTE_MINTS,
  approveQuote,
  configPda,
  removeStake,
  revokeQuote,
  type TxSigner,
} from "./chain";
import { connectPhantom, disconnectPhantom, phantomInstalled } from "./phantom";

const MAX_APPROVAL = (1n << 64n) - 1n;

const TABS = [
  { id: "pots", label: "Pots" },
  { id: "tendies", label: "Tendies" },
  { id: "clash", label: "Clash" },
  { id: "bags", label: "Bags" },
  { id: "works", label: "How" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const DIRT_DOTS = [
  ["7%", "51%", "0s", "6.2s"],
  ["16%", "67%", "-1.4s", "8.1s"],
  ["24%", "84%", "-3.1s", "7.4s"],
  ["31%", "58%", "-2.2s", "9s"],
  ["39%", "76%", "-4.6s", "6.8s"],
  ["46%", "91%", "-0.8s", "8.6s"],
  ["54%", "63%", "-5.2s", "7.1s"],
  ["61%", "80%", "-1.9s", "9.4s"],
  ["68%", "54%", "-3.7s", "6.5s"],
  ["74%", "72%", "-2.8s", "8.3s"],
  ["82%", "88%", "-4.1s", "7.7s"],
  ["89%", "60%", "-0.4s", "9.2s"],
  ["13%", "93%", "-5.5s", "6.9s"],
  ["48%", "49%", "-3.3s", "8.8s"],
  ["93%", "78%", "-1.1s", "7.9s"],
] as const;

export function App() {
  const [tab, setTab] = useState<Tab>("pots");
  const [guide, setGuide] = useState<GuideSection>("Flow");
  const [state, setState] = useState<FarmState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wallet, setWallet] = useState<TxSigner | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("Sound is off until you turn it on.");
  const [muted, setMuted] = useState(true);
  const [legal, setLegal] = useState<LegalDoc | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [accepted, setAccepted] = useState<boolean>(() => {
    try {
      return localStorage.getItem("hodl-terms") === TERMS_VERSION;
    } catch {
      return false;
    }
  });
  const connection = useMemo(() => new Connection(CLUSTERS.mainnet, "confirmed"), []);
  const programId = DEFAULT_PROGRAM_ID;

  const load = useCallback(async () => {
    try {
      const next = await fetchState(wallet?.publicKey.toBase58());
      setState(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [wallet]);

  useEffect(() => {
    let inflight = false;
    const pull = async () => {
      if (inflight) return;
      inflight = true;
      try {
        await load();
      } finally {
        inflight = false;
      }
    };
    void pull();
    const id = setInterval(() => void pull(), 10_000);
    return () => clearInterval(id);
  }, [load]);

  // Only reconnect silently once the current terms have been accepted on this device.
  useEffect(() => {
    if (!accepted) return;
    void connectPhantom(true)
      .then(setWallet)
      .catch(() => undefined);
  }, [accepted]);

  useEffect(() => {
    if (!wallet) return;
    void watchWallet(wallet.publicKey.toBase58()).catch(() => undefined);
  }, [wallet]);

  function go(next: Tab) {
    if (next === "works") setGuide("Flow");
    setTab(next);
    play("page");
  }

  function openMisc() {
    setGuide("Misc");
    setTab("works");
    play("page");
  }

  async function run(label: string, fn: () => Promise<string>) {
    setBusy(true);
    play("click");
    try {
      const sig = await fn();
      play("coin");
      setLog(`${label}\n${sig}`);
      await load();
    } catch (err) {
      play("deny");
      const raw = err instanceof Error ? err.message : String(err);
      setLog(`${label} failed\n${raw.slice(0, 400)}`);
    } finally {
      setBusy(false);
    }
  }

  function connect() {
    return run("Connect Phantom", async () => {
      const signer = await connectPhantom();
      setWallet(signer);
      return signer.publicKey.toBase58();
    });
  }

  function onConnectClick() {
    if (accepted) {
      void connect();
    } else {
      setConsentOpen(true);
    }
  }

  function acceptAndConnect() {
    try {
      localStorage.setItem("hodl-terms", TERMS_VERSION);
    } catch {
      // private mode: acceptance holds for this session only
    }
    setAccepted(true);
    setConsentOpen(false);
    void connect();
  }

  function showLegal(doc: LegalDoc) {
    setConsentOpen(false);
    setLegal(doc);
    play("page");
  }

  const canAct = Boolean(wallet && !busy);
  const raw = (text: string, decimals = 9) => {
    const [whole, frac = ""] = text.split(".");
    const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
    return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
  };

  return (
    <div className="world">
      <div className="sky" aria-hidden>
        <div className="sun" />
        <div className="cloud c1" />
        <div className="cloud c2" />
        <div className="cloud c3" />
      </div>
      <div className="ground" aria-hidden />
      <div className="grassbits" aria-hidden />
      {DIRT_DOTS.map(([left, top, delay, duration]) => (
        <span key={`${left}-${top}`} className="orb" style={{ left, top, animationDelay: delay, animationDuration: duration }} />
      ))}
      <span className="drip" style={{ left: "22%" }} />
      <span className="drip" style={{ left: "58%", animationDelay: "-1s" }} />
      <span className="drip" style={{ left: "81%", animationDelay: "-1.8s" }} />

      <header className="hud">
        <div className="brand">
          <span className="hodl-mark" aria-hidden>
            <span />
          </span>
          <div>
            <strong>HODL</strong>
            <small>mainnet</small>
          </div>
        </div>
        <div className="hud-actions">
          <button
            onClick={() => {
              const next = toggleMute();
              setMuted(next);
              setLog(next ? "Sound off." : "Sound on. A quiet tune.");
            }}
          >
            {muted || isMuted() ? "Sound off" : "Sound on"}
          </button>
          {wallet ? (
            <button
              onClick={() =>
                run("Disconnect", async () => {
                  await disconnectPhantom();
                  setWallet(null);
                  return "disconnected";
                })
              }
            >
              {shortKey(wallet.publicKey.toBase58())}
            </button>
          ) : (
            <button className="primary" onClick={onConnectClick}>
              {phantomInstalled() ? "Connect" : "Get Phantom"}
            </button>
          )}
        </div>
      </header>

      {error ? <div className="banner bad">API down · {error}</div> : null}
      {state?.paused ? <div className="banner warn">Pots are paused.</div> : null}

      <main className="stage" key={legal ?? tab}>
        {legal ? (
          <div className="page">
            <button className="text-link" onClick={() => setLegal(null)}>
              &lt;- Back
            </button>
            <Legal doc={legal} />
          </div>
        ) : !state ? (
          <p className="lede">Loading the world…</p>
        ) : tab === "pots" ? (
          <Pool
            state={state}
            canAct={canAct}
            onSeeMore={openMisc}
            onAllow={(plot, amount, noCap) => {
              if (plot.status !== "live" || !plot.quoteMint) throw new Error("This pot is not open on chain yet.");
              if (!QUOTE_MINTS.has(plot.quoteMint)) throw new Error("This reward token is not on the allowlist.");
              const mint = new PublicKey(plot.quoteMint);
              play("chest");
              return run("Approve entry", () =>
                approveQuote(connection, wallet!, mint, configPda(programId), noCap ? MAX_APPROVAL : raw(amount, plot.quoteDecimals)),
              );
            }}
            onRevoke={(plot) => {
              if (plot.status !== "live" || !plot.quoteMint) throw new Error("This pot is not open on chain yet.");
              return run("Revoke", () => revokeQuote(connection, wallet!, new PublicKey(plot.quoteMint!)));
            }}
            onRemove={(plot, amount) => {
              if (plot.status !== "live" || !plot.quoteMint || !plot.epochId) {
                throw new Error("This pot is not open on chain yet.");
              }
              return run("Remove", () =>
                removeStake(
                  connection,
                  wallet!,
                  programId,
                  new PublicKey(plot.quoteMint!),
                  BigInt(plot.epochId!),
                  raw(amount, plot.quoteDecimals),
                ),
              );
            }}
          />
        ) : tab === "clash" ? (
          <Clash state={state} />
        ) : tab === "tendies" ? (
          <Engine state={state} />
        ) : tab === "works" ? (
          <How section={guide} onSection={setGuide} />
        ) : (
          <Portfolio
            state={state}
            connected={Boolean(wallet)}
            canAct={canAct}
            onAllow={(plot, amount, noCap) => {
              if (plot.status !== "live" || !plot.quoteMint) throw new Error("This pot is not open on chain yet.");
              if (!QUOTE_MINTS.has(plot.quoteMint)) throw new Error("This reward token is not on the allowlist.");
              const mint = new PublicKey(plot.quoteMint);
              play("chest");
              return run("Approve entry", () =>
                approveQuote(connection, wallet!, mint, configPda(programId), noCap ? MAX_APPROVAL : raw(amount, plot.quoteDecimals)),
              );
            }}
            onRevoke={(plot) => {
              if (plot.status !== "live" || !plot.quoteMint) throw new Error("This pot is not open on chain yet.");
              return run("Revoke", () => revokeQuote(connection, wallet!, new PublicKey(plot.quoteMint!)));
            }}
            onRemove={(plot, amount) => {
              if (plot.status !== "live" || !plot.quoteMint || !plot.epochId) {
                throw new Error("This pot is not open on chain yet.");
              }
              return run("Remove", () =>
                removeStake(
                  connection,
                  wallet!,
                  programId,
                  new PublicKey(plot.quoteMint!),
                  BigInt(plot.epochId!),
                  raw(amount, plot.quoteDecimals),
                ),
              );
            }}
          />
        )}
      </main>

      <nav className="hotbar">
        {TABS.map((item) => (
          <button key={item.id} className={tab === item.id ? "on" : ""} onClick={() => go(item.id)}>
            <Ticker
              small
              bob={false}
              id={
                item.id === "works"
                  ? "stonk"
                  : item.id === "tendies"
                    ? "knots"
                    : item.id === "bags"
                      ? "gp"
                      : item.id === "clash"
                        ? "zcat"
                        : "nearkat"
              }
            />
            {item.label}
          </button>
        ))}
      </nav>
      <p className="logline">{log}</p>
      <footer className="legal-foot">
        <button className="text-link" onClick={() => showLegal("Terms")}>
          Terms
        </button>
        <span aria-hidden>·</span>
        <button className="text-link" onClick={() => showLegal("Privacy")}>
          Privacy
        </button>
      </footer>

      {consentOpen ? (
        <div className="modal-back" onClick={() => setConsentOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="x" onClick={() => setConsentOpen(false)} aria-label="Close">
              X
            </button>
            <h3>Before you connect</h3>
            <p>
              HODL is an experimental, pay-to-enter prize draw. Most entries do not win and are not refunded. It is not
              offered where you are if your country is a Restricted Territory.
            </p>
            <p>
              Please read the{" "}
              <button className="text-link" onClick={() => showLegal("Terms")}>
                Terms
              </button>{" "}
              and{" "}
              <button className="text-link" onClick={() => showLegal("Privacy")}>
                Privacy Policy
              </button>
              . Connecting your wallet confirms you accept both and are eligible to take part.
            </p>
            <div className="row">
              <button className="primary" onClick={acceptAndConnect}>
                I accept — connect
              </button>
              <button onClick={() => setConsentOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
