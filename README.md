# HODL

HODL is a prize vault for reward tokens. A wallet approves a quote token, a keeper sweeps that allowance into the open round, and each entry's chance is its amount times the slots left until the draw. Before the draw, new entries and removals stop. A randomness oracle supplies the value. The winner receives 95% of the pot.

The interface is a small pixel farm: Pots, Tendies, Clash, Bags, and a how-it-works page.

## Status

The deployment this code came from has been shut down: the vault was paused, quote and rent were withdrawn, and the program was closed. Nothing here is wired to that deployment. Fill in the placeholders before building or running it against a cluster.

About 0.01 SOL is still in accounts that had no close instruction: the config account, one lots account, two empty token accounts, and the closed-program marker. Those cannot be recovered now.

This tree is the source as it stood at shutdown. It is not a live deployment.

## How a round worked

One quote mint is the on-chain vault. The page can list more pots than are initialized. Set each mint in `server/src/catalog.ts`.

| Rule | Value |
|---|---|
| Split | 95% winner, 4.5% reserve, 0.5% treasury |
| Reserve, off chain | The keeper aimed to spend 4% of the pot buying the origin stonk and to hold 0.5% for liquidity |
| Cutoff | 1,500 slots, about 10 minutes. Deposits and removals both stop |
| Minimum entry | 0.05 wNEAR |
| Seats | 500 on a newly opened round. Older rounds stayed at 100 |
| Weight | `amount * (draw_slot - slot)` |
| Removal | Newest slice first, while the round is still open and before the cutoff |
| Draw | Switchboard On-Demand. Close and settle are authority-gated. A commit older than 400 slots is rejected |
| Exit | Authority `withdraw` and `recover_epoch`. `reclaim` closes the config and was not used |

`open_epoch` is authority-only. The draw slot has to land after the cutoff and within about three days.

## Layout

| Path | What it is |
|---|---|
| `programs/prize-canary` | Anchor program. Epoch bytes are packed by hand so a round can be 100 or 500 seats |
| `server` | API, Postgres snapshot, and the keeper. Serves `server/public` |
| `web` | React client. Vite dev server proxies `/v1` to the API |
| `keeper` | Earlier standalone keeper. The one that ran in production is `server/src/keeper.ts` |
| `AUDIT.md` | Adversarial review from 3 Oct 2026, against the program before the last upgrade |
| `docs/audit-followup.md` | Notes on what that review left in place. Written before shutdown |

## Run it locally

Postgres, the API, and the page:

```bash
docker compose up -d db
cd server && npm install && npm run dev
```

In another terminal:

```bash
cd web && npm install && npm run dev
```

The API listens on port 8787. The page is at http://127.0.0.1:5173 and proxies `/v1` there. Copy `.env.example` if you want a different RPC. Point `KEEPER_KEY` at a keypair file if you run the keeper. It does nothing on chain unless `KEEPER_SEND=1`. Leave sending off. The mainnet program is closed.

`docker compose up --build` starts Postgres and the API together. The compose file publishes Postgres on port 5433 with user `dev`, password `dev`, and database `dev`.

The program target is Solana SBPF v3 and Anchor 0.32.1:

```bash
anchor build
```

## Fill these in

| Place | What goes there |
|---|---|
| `declare_id!` and `Anchor.toml` | Program id from `anchor keys sync` |
| `PROGRAM_ID` and `VITE_PROGRAM_ID` | That same program id |
| `VITE_QUOTE_MINTS` | Comma-separated quote mints the page may approve |
| `server/src/catalog.ts` | `baseMint`, `quoteMint`, and `originMint` for each vault |
| Program `SWITCHBOARD` and `SWITCHBOARD_QUEUE` | Randomness program id and queue account |
| Program `PRODUCTIVE` and `PRODUCTIVE_WALLET` | Wallet that receives reserve releases and holds bought tokens |
| `REWARDS_API` | Rewards API base URL, or leave empty |
| `OUTPUT_MINT` | Mint bought with the backing slice, or leave empty |
| `LP_POOL` in the catalog | Pool address for the liquidity slice, or leave empty |
| `KEEPER_KEY` | Path to the vault-authority keypair. Do not commit the file |
