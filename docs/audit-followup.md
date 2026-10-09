# Follow-up: left in place while this is a canary

Written before shutdown. The program was upgraded after this note, the cutoff was set to 1,500 slots, the funded rounds were withdrawn, empty rounds were closed, and on 5 Oct 2026 the program itself was closed. The checklist below is the record of what was deferred. It is not a list of live funds or a pending deploy.



These items from the 3 Oct 2026 audits stay as they are for this pass. They are the test exit, the single operator key, and hygiene that does not change who can move funds today.

## Testing exemptions

### Withdraw can empty any vault

`withdraw` is authority-only and does not check epoch status. `recover_epoch` does not either. Both stay. They are how test quote and rent come back out. A public crank cannot call them.

### One key holds upgrade, config, and keeper

One key is still the upgrade authority, `config.authority`, and the keeper. There is no rotate-authority instruction. Split this before real volume: upgrade authority on a hardware wallet or multisig, and a crank key that cannot withdraw or upgrade.

### Unlimited approval stays the default

Approve entry still starts at no cap. That was the canary default. It widens a hot-key compromise from one deposit to the whole wNEAR balance. Before a public launch, default the checkbox to a finite amount.

### Do not call `reclaim`

`reclaim` is still in the program. Epochs 3, 16, and 32 hold wNEAR, and the epoch 1 and 2 vaults are empty, so `reclaim` would close config and let a stranger `initialize`. The test exit is `withdraw` and `recover_epoch`. A later upgrade should refuse to close config while any epoch vault has tokens.

Sending SOL to the treasury PDA can also brick `reclaim`. Leave that until `reclaim` is replaced.

## Not sent

Cancel epochs 3 and 16 so depositors can claim refunds (about 0.027 and 0.021 wNEAR). They closed with no randomness account, so they cannot settle. Epoch 32 can settle if Switchboard still reveals it, once the keeper scan is deployed. If that reveal fails, cancel 32 too.

The program upgrade that gates open and close is written, and it is not on mainnet yet.

## Hygiene for later

- `docker-compose.yml` publishes Postgres on 5433 with user `dev` and password `dev`. The image runs as root.
- The dev page talks to the production API and mainnet RPC.
- `keeper/index.mjs` is the old instruction layout. Unused helpers remain in `web/src/chain.ts`.
- Remove still throws. There is no user withdraw instruction.
- History sync rewrites epochs every tick. `/v1/state` reloads every epoch on each rebuild.
- `/v1/keeper` returns raw error strings. Keep URLs and keys out of those strings.
