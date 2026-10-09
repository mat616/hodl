# Hodl / `prize-canary` — adversarial audit (revised)

This review is from 3 Oct 2026, before the last program upgrade and before shutdown. The mainnet program was closed on 5 Oct 2026. Findings below describe the program as it was on that date, not a live deployment.



Revised 3 Oct 2026. This version merges the original audit, the first reviewer's 14 findings, and the second reviewer's adjudication. Corrections from both are applied.

## Scope and method

- **Program:** `prize-canary`, plus `server/`, `web/` and `keeper/`. The program id in this tree is a placeholder.
- **Bytecode pin:** the current `programs/prize-canary/src/lib.rs` was rebuilt (SBPF v3) and compared to the mainnet program data. The bytes are identical and the trailing space is zeros. Every program finding below applies to what is deployed.
- **PoCs:** six exploits were run in litesvm against an SBPF v0 build of the same source. All six succeed. They are marked "PoC" below.
- **Mainnet:** read-only RPC queries at about slot 453,087,000. Nothing was sent to mainnet.

## Verdict

This is a trusted-authority canary, not a trust-minimized lottery, and it has one flaw that breaks even that model: an outsider can choose the winner. Four further program issues are High. One key holds every privileged role.

Funds at risk today are small: 0.253 wNEAR sits in epoch vaults, plus any wNEAR allowances users have granted to the config PDA.

**Do not run `reclaim` on the deployed program.** See H-4.

## Mainnet state

| Item | Value |
|---|---|
| Upgrade authority, config authority, keeper key | one operator key |
| Mint | the configured quote mint, with no freeze authority |
| Caps | 100 wNEAR per user, 100 wNEAR per epoch, cutoff 4,500 slots |
| Collecting epoch | 34 (open, empty) |
| Closed epochs holding funds | 3 (0.027), 16 (0.021), 32 (0.205) wNEAR |
| Treasury | 0.005 wNEAR; treasury PDA holds 0 lamports |

## Critical

### C-1. Anyone can choose the winner — PoC

- **Where:** `close_epoch`, `lib.rs:455`; `settle`, `lib.rs:527`.
- **Cause:** `close_epoch` has no authority check. It accepts any Switchboard-owned randomness account with `seed_slot > 0` and `reveal_slot == 0`. It does not check seed-slot freshness, the queue, or the account's authority.
- **Exploit:** the attacker commits many randomness accounts in advance and fetches each reveal off-chain, where the gateway hands the value to the requester. Once deposits freeze, they bind the account whose value selects them, land the reveal, and call `settle`, which is also permissionless.
- **PoC result:** with 0.31% of the weight and a 0.5 token stake, the attacker took 47.975 of a 50.5 pot after 206 candidates.
- **What is and is not proven:** the program accepting a stale, attacker-owned account is proven. The off-chain pre-reveal is Switchboard's documented behaviour; the PoC models the account with `setAccount` and did not call the real oracle.
- **Fix:**
  - Gate `close_epoch` to the authority or a keeper key.
  - Require `seed_slot == clock.slot - 1`, so the commit lands in the same transaction as the bind.
  - Pin the queue and the randomness account's authority.
  - Commit at draw time, not at cutoff.
  - Add a timeout so an unrevealed draw can be re-requested or cancelled.
- **Do not** bind randomness at `open_epoch`, as the first review suggested. The value would then be knowable before deposits.

## High

### H-1. Dust fills the 100-slot depositor list — PoC

- **Where:** `credit_into`, `lib.rs:699`.
- **Cause:** there is no minimum deposit. 100 wallets depositing 1 base unit each make every new wallet fail with `EpochFull`.
- **Limit:** wallets already in the list can still add. The attack works when the attacker fills the slots at open.
- **Aggravation:** the keeper sweeps any allowance of at least 0.0001 wNEAR, so it will pay the fees for the attacker's entries.
- **Fix:** a meaningful minimum deposit, or per-depositor PDAs instead of a fixed array.

### H-2. `open_epoch` is permissionless with an unbounded `draw_slot` — PoC

- **Where:** `lib.rs:85`.
- **Cause:** only a signer is required, and `draw_slot` has no upper bound.
- **Exploit:** when no epoch is collecting, anyone opens one with a draw slot near `u64::MAX`, then cranks `sweep` to pull users' approved wNEAR into it. `close_epoch` fails with `BeforeCutoff` forever. Only `cancel_epoch` by the authority frees the funds.
- **Also:** a bot can race the keeper at every cutoff and set its own window.
- **Fix:** gate it to the authority or keeper key and bound the deposit window.

### H-3. `withdraw` empties any vault in any state — PoC

- **Where:** `lib.rs:218`.
- **Cause:** no epoch-status check. The authority can drain an open or closed epoch.
- **Consequences:**
  - `claim_refund` and `settle` then revert on insufficient funds. `settle` pays from the ledger total, but each epoch has its own vault, so nothing is overpaid.
  - With the permissionless `sweep`, the authority can take every outstanding allowance, not only deposits.
  - `recover_epoch` (`lib.rs:269`) has no status guard either. After a `withdraw`, it erases the depositor ledger.
- **Fix:** remove `withdraw`, or restrict it to residue in settled epochs. Restrict `recover_epoch` to settled or fully refunded epochs.

### H-4. `reclaim` closes the config and anyone can re-initialize — PoC

- **Where:** `reclaim`, `lib.rs:353`; `initialize`, `lib.rs:57`.
- **Cause:** `reclaim` drains the config PDA. `initialize` then succeeds for any caller, who becomes authority. User allowances still point at the same config address.
- **PoC result:** a stranger re-initialized, swept a victim's standing approval and withdrew 40 tokens.
- **Live status:** only the authority can call `reclaim`, and it would succeed today because the epoch 1 and 2 vaults are empty. It checks no other epochs. Epochs 3, 16 and 32 hold 0.253 wNEAR, which a re-initializing stranger could also `withdraw`.
- **Fix:** never close the config; set a tombstone flag instead. Restrict `initialize` to the upgrade authority.

### H-5. One hot key holds every role

- **Evidence:** one key is the upgrade authority, the config authority and the keeper key. That key file is mounted into the API container.
- **Impact:** a server compromise allows a malicious upgrade and the drain of all vaults and allowances.
- **Also:** the program has no instruction to rotate `config.authority`.
- **Fix:** move the upgrade authority to a multisig or hardware wallet. Give the keeper a separate key that can only crank. Add an authority-rotation instruction.

### H-6. The UI defaults to an unlimited approval

- **Where:** `web/src/App.tsx:21`, `web/src/pages/Pool.tsx:176`.
- **Cause:** "Approve entry" approves `u64::MAX` unless the user ticks "Approve a specific amount". The copy says "rewards", but the delegation covers all wNEAR in the wallet.
- **Impact:** it widens H-2, H-3, H-4 and H-5 from deposits to whole wallet balances.
- **Fix:** default to a finite amount.

## Medium

### M-1. Funds are stuck on mainnet now

- **Epochs 3 and 16:** closed before randomness binding existed, so no randomness account is bound. They can never settle. Only `cancel_epoch` frees them.
- **Epoch 32:** bound and closed, but orphaned. The keeper only looks at `collecting - 1` (`server/src/keeper.ts:164`), and epoch 33 rolled before epoch 32's draw slot.
- **Open question:** whether Switchboard will still reveal epoch 32's commit, which is hours old. If not, it also needs `cancel_epoch`.
- **Fix:** have the keeper scan every closed, funded epoch, not only the previous one.

### M-2. `POST /v1/watch` is unauthenticated and unbounded

- **Where:** `server/src/routes.ts:107`.
- **Impact:** anyone can insert unlimited wallets. Each costs an RPC call per keeper tick. No endpoint has rate limiting.
- **Note:** the API serves public data with no sessions, so the open CORS policy by itself exposes nothing.

### M-3. The productive key signs Jupiter's transaction unseen

- **Where:** `server/src/acquire.ts:54`.
- **Impact:** a compromised or spoofed Jupiter endpoint can drain the productive wallet. Slippage is fixed at 1%.
- **Fix:** decode the transaction and check programs, accounts and minimum output before signing.

### M-4. Pause is partial

- Pause blocks `open_epoch`, `deposit` and `sweep`.
- It does not block `close_epoch`, `settle`, `withdraw` or `release_reserve`. C-1 therefore works while paused.

### M-5. Sweeps revert for wallets above the per-user cap

- **Where:** `sweep`, `lib.rs:160`; keeper always passes amount 0.
- **Impact:** amount 0 takes the whole allowance or balance. If that exceeds the cap, the call fails with `UserCap`, the wallet is never swept, and its batch fails.
- **Fix:** have the program clamp to the remaining cap.

## Low

- **L-1. `reclaim` can be bricked.** Sending 890,880 lamports to the treasury PDA makes `reclaim` revert, because the program debits an account it does not own (PoC). Nobody has done this yet; it costs about 0.00089 SOL.
- **L-2. Container and database defaults.** `docker-compose.yml` publishes Postgres on 5433 with user `dev` and password `dev`. The image runs as root and uses `npm install` with caret ranges.
- **L-3. No security headers.** The live Fly response has no `Content-Security-Policy`, `Strict-Transport-Security` or `X-Frame-Options`.
- **L-4. `rng_secret` stored in Postgres** (`server/src/oracle.ts:66`). The keypair is only the randomness account's address; the authority is the keeper key. A leak gives no control over the draw. Stop storing it anyway.
- **L-5. Approve mint comes from the API** (`web/src/App.tsx:213`). The delegate is always the config PDA and `sweep` only accepts `config.mint`, so an approval on another mint is unusable today. Add a mint allowlist in the client.
- **L-6. The dev server talks to production.** The dev client was pointed at the hosted API and the app uses the mainnet RPC. The README says the page will not touch mainnet. `web/.env.development` was not readable and may override the API base.
- **L-7. Stale code and docs.**
  - `keeper/index.mjs` uses the old instruction layouts and would fail against the deployed program.
  - `chain.ts` has an old `settle`, an old `close_epoch` builder, and unused helpers that store a secret key in `localStorage`. These are tree-shaken out of the built bundles.
  - The README says the authority opens, closes and settles. All three are permissionless.
- **L-8. Remove button cannot remove** (`web/src/pages/Pool.tsx:195`). Confirm always fails with "needs a program update". Not a security issue.
- **L-9. Efficiency.**
  - `syncHistory` re-reads and rewrites every epoch on each 20-second tick.
  - `upsertEpoch` deletes and reinserts depositors without a transaction.
  - `/v1/state` selects all epochs and depositors on every rebuild.

## Informational

- **Keeper errors are public.** `/v1/keeper` and `/v1/state` return raw error strings. A fallback RPC URL is not written into them now, and the code paths make a leak unlikely, but it is not ruled out.

## Still unverified

| Item | What is missing |
|---|---|
| C-1, off-chain half | A run against the real Switchboard gateway |
| M-1, epoch 32 | Whether an old commit can still be revealed |
| L-4 | Reveal and close signer requirements were read from the SDK, not tested on-chain |
| L-6 | Contents of `web/.env.development` |

## Fix order

1. Cancel epochs 3, 16 and 32 so depositors can claim refunds.
2. Upgrade the program for C-1, H-1, H-2, H-3 and H-4 before real volume arrives.
3. Split the keys (H-5) and change the approval default (H-6).
4. Rate-limit and authenticate `/v1/watch`, validate Jupiter transactions, fix the keeper's settle scan.
5. Add lifecycle tests to the repo; none exist today.
