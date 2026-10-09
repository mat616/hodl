use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke_signed};
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer},
};

// Program id. Replace with the keypair from `anchor keys sync` before building.
declare_id!("11111111111111111111111111111111");

pub const MAX_DEPOSITORS: usize = 500;
const LEGACY_DEPOSITORS: usize = 100;
const OLD_MAX_DEPOSITORS: usize = 16;
const DEPOSITOR_SIZE: usize = 32 + 8 + 16 + 1;
const EPOCH_HEAD: usize = 8 + 1 + 8 + 16 + 8 + 1;
const OLD_EPOCH_TAIL: usize = 32 + 8 + 8 + 8 + 32 + 1;
const EPOCH_TAIL: usize = OLD_EPOCH_TAIL + 32;
const OLD_EPOCH_LEN: usize = 8 + EPOCH_HEAD + DEPOSITOR_SIZE * OLD_MAX_DEPOSITORS + OLD_EPOCH_TAIL;
const OLD_TAIL_OFF: usize = 8 + EPOCH_HEAD + DEPOSITOR_SIZE * OLD_MAX_DEPOSITORS;
const EPOCH_DISC: [u8; 8] = [0x5d, 0x53, 0x78, 0x59, 0x97, 0x8a, 0x98, 0x6c];
const OFF_ID: usize = 8;
const OFF_STATUS: usize = 16;
const OFF_TOTAL: usize = 17;
const OFF_WEIGHT: usize = 25;
const OFF_DRAW: usize = 41;
const OFF_COUNT: usize = 49;
const OFF_DEPOSITORS: usize = 50;
const REL_WINNER: usize = 0;
const REL_PRIZE: usize = 32;
const REL_RESERVE: usize = 40;
const REL_TREASURY: usize = 48;
const REL_SEED: usize = 56;
const REL_RANDOMNESS: usize = 88;
const REL_BUMP: usize = 120;
// Switchboard On-Demand program id.
const SWITCHBOARD: Pubkey = pubkey!("11111111111111111111111111111111");
const SWITCHBOARD_DISC: [u8; 8] = [10, 66, 229, 135, 220, 239, 217, 114];
const SB_AUTHORITY: usize = 8;
const SB_QUEUE: usize = 40;
const SB_SEED_SLOT: usize = 104;
const SB_REVEAL_SLOT: usize = 144;
const SB_VALUE: usize = 152;
/// Queue PDA for the default Switchboard On-Demand mainnet queue.
// Switchboard On-Demand queue account for this deployment.
const SWITCHBOARD_QUEUE: Pubkey = pubkey!("11111111111111111111111111111111");
/// A commit older than this can no longer be bound. About 2.5 minutes.
const RANDOMNESS_FRESH_SLOTS: u64 = 400;
/// Longest deposit window after the cutoff. About three days. Stops a forever-lock.
const MAX_DRAW_EXTRA: u64 = 650_000;
/// 0.05 wNEAR. One base unit must not be able to fill a depositor slot.
const MIN_DEPOSIT: u64 = 50_000_000;
const MAX_LOTS: usize = 32;
const LOT_SIZE: usize = 8 + 16;
const LOTS_SPACE: usize = 1 + LOT_SIZE * MAX_LOTS;
// Productive-pool wallet. `release_reserve` only sends the reserve to a token
// account owned by this address. Replace the placeholder before deploying.
const PRODUCTIVE: Pubkey = pubkey!("11111111111111111111111111111111");
const STATUS_OPEN: u8 = 0;
const STATUS_CLOSED: u8 = 1;
const STATUS_SETTLED: u8 = 2;
const STATUS_CANCELLED: u8 = 3;
pub const WINNER_BPS: u16 = 9_500;
pub const RESERVE_BPS: u16 = 450;
pub const TREASURY_BPS: u16 = 50;
pub const BPS_DENOM: u16 = 10_000;
const EPOCH_ONE_ID: [u8; 8] = 1u64.to_le_bytes();
const EPOCH_TWO_ID: [u8; 8] = 2u64.to_le_bytes();
/// 10 minutes at a 400 ms slot target. Deposits and removals stop for this long before the draw.
pub const DEFAULT_CUTOFF_SLOTS: u64 = 1_500;

#[program]
pub mod prize_canary {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        max_user_deposit: u64,
        max_epoch_deposits: u64,
        cutoff_slots: u64,
    ) -> Result<()> {
        require!(max_user_deposit > 0, CanaryError::BadCap);
        require!(max_epoch_deposits >= max_user_deposit, CanaryError::BadCap);
        require!(cutoff_slots > 0, CanaryError::BadCap);

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.mint = ctx.accounts.mint.key();
        config.max_user_deposit = max_user_deposit;
        config.max_epoch_deposits = max_epoch_deposits;
        config.cutoff_slots = cutoff_slots;
        config.paused = false;
        config.bump = ctx.bumps.config;
        config.next_epoch = 1;
        config.collecting_epoch = 0;
        Ok(())
    }

    pub fn set_paused(ctx: Context<Auth>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    pub fn set_cutoff(ctx: Context<Auth>, cutoff_slots: u64) -> Result<()> {
        require!(cutoff_slots > 0 && cutoff_slots <= 100_000, CanaryError::BadCap);
        ctx.accounts.config.cutoff_slots = cutoff_slots;
        Ok(())
    }

    pub fn open_epoch(ctx: Context<OpenEpoch>, draw_slot: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, CanaryError::Paused);
        require_keys_eq!(
            ctx.accounts.crank.key(),
            ctx.accounts.config.authority,
            CanaryError::NotAuthority
        );
        require!(
            ctx.accounts.config.collecting_epoch == 0,
            CanaryError::AlreadyCollecting
        );
        let now = Clock::get()?.slot;
        let earliest = now
            .checked_add(ctx.accounts.config.cutoff_slots)
            .ok_or(CanaryError::Overflow)?;
        let latest = earliest
            .checked_add(MAX_DRAW_EXTRA)
            .ok_or(CanaryError::Overflow)?;
        require!(
            draw_slot > earliest && draw_slot <= latest,
            CanaryError::BadDrawSlot
        );
        let id = ctx.accounts.config.next_epoch;
        {
            let epoch = ctx.accounts.epoch.to_account_info();
            let mut data = epoch.try_borrow_mut_data()?;
            data[..8].copy_from_slice(&EPOCH_DISC);
            write_u64(&mut data, OFF_ID, id);
            data[OFF_STATUS] = STATUS_OPEN;
            write_u64(&mut data, OFF_DRAW, draw_slot);
            let bump_at = off_tail(data.len())? + REL_BUMP;
            data[bump_at] = ctx.bumps.epoch;
        }
        ctx.accounts.config.next_epoch = id
            .checked_add(1)
            .ok_or(CanaryError::Overflow)?;
        ctx.accounts.config.collecting_epoch = id;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        let now = Clock::get()?.slot;
        let owner = ctx.accounts.depositor.key();
        let (prior_amt, prior_w, slice_w) = credit(
            &ctx.accounts.epoch,
            &ctx.accounts.config,
            owner,
            amount,
            now,
        )?;
        record_lot(
            &ctx.accounts.lots.to_account_info(),
            &ctx.accounts.depositor.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            epoch_id_of(&ctx.accounts.epoch.to_account_info())?,
            owner,
            prior_amt,
            prior_w,
            amount,
            slice_w,
        )?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.depositor_ata.to_account_info(),
                    to: ctx.accounts.vault_ata.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }

    /// Pull wNEAR the user already allowed the vault to move. StonkFun pays the
    /// wallet, not this program. The vault PDA is the SPL delegate and signs
    /// the transfer. Amount 0 takes the remaining allowance, capped by the
    /// wallet balance. Past cutoff, this fails and the tokens stay put for the
    /// next collecting epoch.
    pub fn sweep(ctx: Context<Sweep>, amount: u64) -> Result<()> {
        let delegate = match ctx.accounts.user_ata.delegate {
            COption::Some(key) => key,
            COption::None => return err!(CanaryError::NotDelegated),
        };
        require!(
            delegate == ctx.accounts.config.key(),
            CanaryError::NotDelegated
        );
        let available = ctx
            .accounts
            .user_ata
            .amount
            .min(ctx.accounts.user_ata.delegated_amount);
        let owner = ctx.accounts.user.key();
        let room = with_epoch(&ctx.accounts.epoch, |data| {
            Ok(deposit_room(data, &ctx.accounts.config, owner))
        })?;
        let capped = available.min(room);
        let amount = if amount == 0 { capped } else { amount.min(capped) };
        require!(amount >= MIN_DEPOSIT, CanaryError::DustDeposit);
        require!(
            amount <= ctx.accounts.user_ata.delegated_amount,
            CanaryError::NotDelegated
        );

        let now = Clock::get()?.slot;
        let (prior_amt, prior_w, slice_w) = credit(
            &ctx.accounts.epoch,
            &ctx.accounts.config,
            owner,
            amount,
            now,
        )?;
        record_lot(
            &ctx.accounts.lots.to_account_info(),
            &ctx.accounts.crank.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            epoch_id_of(&ctx.accounts.epoch.to_account_info())?,
            owner,
            prior_amt,
            prior_w,
            amount,
            slice_w,
        )?;

        let bump = ctx.accounts.config.bump;
        let seeds: &[&[u8]] = &[b"config", &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_ata.to_account_info(),
                    to: ctx.accounts.vault_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }

    /// Move the 4.5% quote reserve to the productive pool wallet.
    pub fn release_reserve(ctx: Context<ReleaseReserve>) -> Result<()> {
        require_keys_eq!(ctx.accounts.destination.owner, PRODUCTIVE, CanaryError::BadDestination);
        let amount = ctx.accounts.reserve_ata.amount;
        require!(amount > 0, CanaryError::ZeroAmount);
        let bump = ctx.accounts.config.bump;
        let seeds: &[&[u8]] = &[b"config", &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.reserve_ata.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }

    /// Pull quote the program is holding back to the authority. Used to exit a test.
    /// A public crank cannot call this.
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let amount = ctx.accounts.source.amount;
        require!(amount > 0, CanaryError::ZeroAmount);
        require_keys_eq!(
            ctx.accounts.source.owner,
            ctx.accounts.source_authority.key(),
            CanaryError::NotProgramVault
        );
        let config_bump = ctx.accounts.config.bump;
        let config_key = ctx.accounts.config.key();
        let (treasury, treasury_bump) = Pubkey::find_program_address(&[b"treasury"], ctx.program_id);
        let source_auth = ctx.accounts.source_authority.key();

        if source_auth == config_key {
            let seeds: &[&[u8]] = &[b"config", &[config_bump]];
            transfer_signed(
                &ctx.accounts.token_program,
                &ctx.accounts.source,
                &ctx.accounts.destination,
                &ctx.accounts.source_authority.to_account_info(),
                seeds,
                amount,
            )?;
        } else if source_auth == treasury {
            let seeds: &[&[u8]] = &[b"treasury", &[treasury_bump]];
            transfer_signed(
                &ctx.accounts.token_program,
                &ctx.accounts.source,
                &ctx.accounts.destination,
                &ctx.accounts.source_authority.to_account_info(),
                seeds,
                amount,
            )?;
        } else {
            let (id, bump) = with_epoch(&ctx.accounts.source_authority, |data| {
                Ok((read_u64(data, OFF_ID).to_le_bytes(), data[off_tail(data.len())? + REL_BUMP]))
            })?;
            let seeds: &[&[u8]] = &[b"epoch", id.as_ref(), &[bump]];
            transfer_signed(
                &ctx.accounts.token_program,
                &ctx.accounts.source,
                &ctx.accounts.destination,
                &ctx.accounts.source_authority.to_account_info(),
                seeds,
                amount,
            )?;
        }
        Ok(())
    }

    /// Close an empty epoch and its token account, returning the rent to the authority.
    pub fn recover_epoch(ctx: Context<RecoverEpoch>) -> Result<()> {
        require!(ctx.accounts.vault_ata.amount == 0, CanaryError::VaultNotEmpty);
        let (id, bump) = with_epoch(&ctx.accounts.epoch, |data| {
            Ok((read_u64(data, OFF_ID).to_le_bytes(), data[off_tail(data.len())? + REL_BUMP]))
        })?;
        let id_num = u64::from_le_bytes(id);
        let seeds: &[&[u8]] = &[b"epoch", id.as_ref(), &[bump]];
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault_ata.to_account_info(),
                destination: ctx.accounts.authority.to_account_info(),
                authority: ctx.accounts.epoch.to_account_info(),
            },
            &[seeds],
        ))?;
        drain(
            ctx.accounts.epoch.to_account_info(),
            ctx.accounts.authority.to_account_info(),
        )?;
        if ctx.accounts.config.collecting_epoch == id_num {
            ctx.accounts.config.collecting_epoch = 0;
        }
        Ok(())
    }

    /// Grow an epoch that was allocated for 16 wallets to 100. The depositor
    /// list sits in the middle of the account, so the winner and payout fields
    /// are copied to their new offset. Already-grown epochs are left as they are.
    pub fn grow_epoch(ctx: Context<GrowEpoch>) -> Result<()> {
        let epoch = ctx.accounts.epoch.to_account_info();
        let new_len = 8 + Epoch::SIZE;
        let old_len = epoch.data_len();
        if old_len == new_len {
            return Ok(());
        }
        require!(old_len == OLD_EPOCH_LEN, CanaryError::BadEpochSize);

        let mut id_bytes = [0u8; 8];
        let mut preserved = [0u8; 88];
        let bump_byte;
        {
            let data = epoch.try_borrow_data()?;
            id_bytes.copy_from_slice(&data[8..16]);
            preserved.copy_from_slice(&data[OLD_TAIL_OFF..OLD_TAIL_OFF + 88]);
            bump_byte = data[OLD_TAIL_OFF + 88];
        }
        let (expected, _) =
            Pubkey::find_program_address(&[b"epoch", &id_bytes], ctx.program_id);
        require_keys_eq!(epoch.key(), expected);
        require_keys_eq!(*epoch.owner, *ctx.program_id);

        let rent = Rent::get()?;
        let need = rent.minimum_balance(new_len);
        let have = epoch.lamports();
        if need > have {
            let pay = need.checked_sub(have).ok_or(CanaryError::Overflow)?;
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: epoch.clone(),
                    },
                ),
                pay,
            )?;
        }

        epoch.resize(new_len)?;
        let new_tail_off = 8 + EPOCH_HEAD + DEPOSITOR_SIZE * MAX_DEPOSITORS;
        {
            let mut data = epoch.try_borrow_mut_data()?;
            for byte in &mut data[OLD_TAIL_OFF..new_tail_off] {
                *byte = 0;
            }
            data[new_tail_off..new_tail_off + 88].copy_from_slice(&preserved);
            data[new_tail_off + REL_BUMP] = bump_byte;
        }
        Ok(())
    }

    /// Send reserve and treasury wNEAR to the authority, then close the vault
    /// accounts and return their rent. Epoch vaults must already be empty.
    pub fn reclaim(ctx: Context<Reclaim>) -> Result<()> {
        require!(
            ctx.accounts.epoch_one_vault.amount == 0 && ctx.accounts.epoch_two_vault.amount == 0,
            CanaryError::VaultNotEmpty
        );
        let config_bump = ctx.accounts.config.bump;
        let config_seeds: &[&[u8]] = &[b"config", &[config_bump]];
        let treasury_bump = ctx.bumps.treasury_auth;
        let treasury_seeds: &[&[u8]] = &[b"treasury", &[treasury_bump]];

        let reserve_amt = ctx.accounts.reserve_ata.amount;
        if reserve_amt > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.reserve_ata.to_account_info(),
                        to: ctx.accounts.authority_ata.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    &[config_seeds],
                ),
                reserve_amt,
            )?;
        }
        let treasury_amt = ctx.accounts.treasury_ata.amount;
        if treasury_amt > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.treasury_ata.to_account_info(),
                        to: ctx.accounts.authority_ata.to_account_info(),
                        authority: ctx.accounts.treasury_auth.to_account_info(),
                    },
                    &[treasury_seeds],
                ),
                treasury_amt,
            )?;
        }

        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.reserve_ata.to_account_info(),
                destination: ctx.accounts.authority.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[config_seeds],
        ))?;
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.treasury_ata.to_account_info(),
                destination: ctx.accounts.authority.to_account_info(),
                authority: ctx.accounts.treasury_auth.to_account_info(),
            },
            &[treasury_seeds],
        ))?;

        let one_bump = ctx.bumps.epoch_one;
        let one_seeds: &[&[u8]] = &[b"epoch", EPOCH_ONE_ID.as_ref(), &[one_bump]];
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.epoch_one_vault.to_account_info(),
                destination: ctx.accounts.authority.to_account_info(),
                authority: ctx.accounts.epoch_one.to_account_info(),
            },
            &[one_seeds],
        ))?;
        let two_bump = ctx.bumps.epoch_two;
        let two_seeds: &[&[u8]] = &[b"epoch", EPOCH_TWO_ID.as_ref(), &[two_bump]];
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.epoch_two_vault.to_account_info(),
                destination: ctx.accounts.authority.to_account_info(),
                authority: ctx.accounts.epoch_two.to_account_info(),
            },
            &[two_seeds],
        ))?;

        drain(
            ctx.accounts.epoch_one.to_account_info(),
            ctx.accounts.authority.to_account_info(),
        )?;
        drain(
            ctx.accounts.epoch_two.to_account_info(),
            ctx.accounts.authority.to_account_info(),
        )?;
        drain(
            ctx.accounts.treasury_auth.to_account_info(),
            ctx.accounts.authority.to_account_info(),
        )?;
        drain(
            ctx.accounts.config.to_account_info(),
            ctx.accounts.authority.to_account_info(),
        )?;
        Ok(())
    }

    pub fn close_epoch(ctx: Context<CrankClose>) -> Result<()> {
        require!(!ctx.accounts.config.paused, CanaryError::Paused);
        require_keys_eq!(
            ctx.accounts.crank.key(),
            ctx.accounts.config.authority,
            CanaryError::NotAuthority
        );
        let (seed_slot, reveal_slot, _, sb_authority, sb_queue) =
            read_switchboard(&ctx.accounts.randomness.to_account_info())?;
        let now = Clock::get()?.slot;
        require!(seed_slot > 0 && reveal_slot == 0, CanaryError::BadRandomness);
        require!(
            now < seed_slot || now - seed_slot <= RANDOMNESS_FRESH_SLOTS,
            CanaryError::BadRandomness
        );
        require_keys_eq!(sb_authority, ctx.accounts.config.authority, CanaryError::BadRandomness);
        require_keys_eq!(sb_queue, SWITCHBOARD_QUEUE, CanaryError::BadRandomness);
        let randomness = ctx.accounts.randomness.key();
        let id = with_epoch(&ctx.accounts.epoch, |data| {
            require!(data[OFF_STATUS] == STATUS_OPEN, CanaryError::EpochNotOpen);
            let draw_slot = read_u64(data, OFF_DRAW);
            require!(
                now.checked_add(ctx.accounts.config.cutoff_slots)
                    .ok_or(CanaryError::Overflow)?
                    > draw_slot,
                CanaryError::BeforeCutoff
            );
            data[OFF_STATUS] = STATUS_CLOSED;
            let rand_at = off_tail(data.len())? + REL_RANDOMNESS;
            data[rand_at..rand_at + 32].copy_from_slice(randomness.as_ref());
            Ok(read_u64(data, OFF_ID))
        })?;
        if ctx.accounts.config.collecting_epoch == id {
            ctx.accounts.config.collecting_epoch = 0;
        }
        Ok(())
    }

    pub fn cancel_epoch(ctx: Context<AuthEpoch>) -> Result<()> {
        let id = with_epoch(&ctx.accounts.epoch, |data| {
            require!(
                data[OFF_STATUS] == STATUS_OPEN || data[OFF_STATUS] == STATUS_CLOSED,
                CanaryError::NotCancellable
            );
            data[OFF_STATUS] = STATUS_CANCELLED;
            Ok(read_u64(data, OFF_ID))
        })?;
        if ctx.accounts.config.collecting_epoch == id {
            ctx.accounts.config.collecting_epoch = 0;
        }
        Ok(())
    }

    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        let (amount, epoch_id, bump) = with_epoch(&ctx.accounts.epoch, |data| {
            require!(data[OFF_STATUS] == STATUS_CANCELLED, CanaryError::NotCancelled);
            let owner = ctx.accounts.depositor.key();
            let count = data[OFF_COUNT] as usize;
            let mut found = None;
            for i in 0..count {
                if depositor_wallet(data, i) == owner {
                    found = Some(i);
                    break;
                }
            }
            let i = found.ok_or(CanaryError::NotDepositor)?;
            require!(!depositor_refunded(data, i), CanaryError::AlreadyRefunded);
            let amount = depositor_amount(data, i);
            set_depositor_refunded(data, i, true);
            Ok((amount, read_u64(data, OFF_ID).to_le_bytes(), data[off_tail(data.len())? + REL_BUMP]))
        })?;
        let seeds: &[&[u8]] = &[b"epoch", epoch_id.as_ref(), &[bump]];
        transfer_signed(
            &ctx.accounts.token_program,
            &ctx.accounts.vault_ata,
            &ctx.accounts.depositor_ata,
            &ctx.accounts.epoch.to_account_info(),
            seeds,
            amount,
        )?;
        Ok(())
    }

    /// Take tokens back before the cutoff. Newest credited slice leaves first.
    pub fn remove(ctx: Context<Remove>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, CanaryError::Paused);
        require!(amount > 0, CanaryError::ZeroAmount);
        let now = Clock::get()?.slot;
        let owner = ctx.accounts.depositor.key();
        let (epoch_id, bump) = with_epoch(&ctx.accounts.epoch, |data| {
            require!(data[OFF_STATUS] == STATUS_OPEN, CanaryError::EpochNotOpen);
            require!(
                read_u64(data, OFF_ID) == ctx.accounts.config.collecting_epoch,
                CanaryError::NotCollecting
            );
            let draw_slot = read_u64(data, OFF_DRAW);
            require!(
                now.checked_add(ctx.accounts.config.cutoff_slots)
                    .ok_or(CanaryError::Overflow)?
                    <= draw_slot,
                CanaryError::PastCutoff
            );
            let (user_amt, user_w, index) = depositor_index(data, owner)?;
            require!(amount <= user_amt, CanaryError::BadLots);
            let weight_out = weight_to_remove(
                &ctx.accounts.lots.to_account_info(),
                read_u64(data, OFF_ID),
                owner,
                user_amt,
                user_w,
                amount,
            )?;
            let next_amt = user_amt.checked_sub(amount).ok_or(CanaryError::Overflow)?;
            let next_w = user_w.checked_sub(weight_out).ok_or(CanaryError::Overflow)?;
            set_depositor_amount(data, index, next_amt);
            set_depositor_weight(data, index, next_w);
            write_u64(
                data,
                OFF_TOTAL,
                read_u64(data, OFF_TOTAL).checked_sub(amount).ok_or(CanaryError::Overflow)?,
            );
            write_u128(
                data,
                OFF_WEIGHT,
                read_u128(data, OFF_WEIGHT).checked_sub(weight_out).ok_or(CanaryError::Overflow)?,
            );
            Ok((read_u64(data, OFF_ID).to_le_bytes(), data[off_tail(data.len())? + REL_BUMP]))
        })?;
        let seeds: &[&[u8]] = &[b"epoch", epoch_id.as_ref(), &[bump]];
        transfer_signed(
            &ctx.accounts.token_program,
            &ctx.accounts.vault_ata,
            &ctx.accounts.depositor_ata,
            &ctx.accounts.epoch.to_account_info(),
            seeds,
            amount,
        )?;
        Ok(())
    }

    /// Pays the winner from the Switchboard value bound at close.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        require!(!ctx.accounts.config.paused, CanaryError::Paused);
        require!(
            ctx.accounts.winner_ata.owner == ctx.accounts.winner.key(),
            CanaryError::WinnerAta
        );
        require!(
            ctx.accounts.winner_ata.mint == ctx.accounts.config.mint,
            CanaryError::WinnerAta
        );

        let (seed_slot, reveal_slot, seed, _, _) =
            read_switchboard(&ctx.accounts.randomness.to_account_info())?;
        require!(seed_slot > 0 && reveal_slot > 0, CanaryError::BadRandomness);
        require!(seed != [0u8; 32], CanaryError::BadRandomness);
        let (winner, prize, reserve_cut, treasury_cut, epoch_id, bump) =
            with_epoch(&ctx.accounts.epoch, |data| {
                require!(data[OFF_STATUS] == STATUS_CLOSED, CanaryError::EpochNotClosed);
                let rand_at = off_tail(data.len())? + REL_RANDOMNESS;
                require!(
                    data[rand_at..rand_at + 32] == ctx.accounts.randomness.key().to_bytes(),
                    CanaryError::BadRandomness
                );
                let draw_slot = read_u64(data, OFF_DRAW);
                require!(Clock::get()?.slot >= draw_slot, CanaryError::BeforeDraw);
                let total_weight = read_u128(data, OFF_WEIGHT);
                require!(total_weight > 0, CanaryError::EmptyEpoch);
                let winner = pick_winner(data, data[OFF_COUNT] as usize, total_weight, &seed)?;
                require!(winner == ctx.accounts.winner.key(), CanaryError::WrongWinner);
                let (prize, reserve_cut, treasury_cut) = split_amounts(read_u64(data, OFF_TOTAL))?;
                Ok((
                    winner,
                    prize,
                    reserve_cut,
                    treasury_cut,
                    read_u64(data, OFF_ID).to_le_bytes(),
                    data[off_tail(data.len())? + REL_BUMP],
                ))
            })?;
        let seeds: &[&[u8]] = &[b"epoch", epoch_id.as_ref(), &[bump]];

        transfer_signed(
            &ctx.accounts.token_program,
            &ctx.accounts.vault_ata,
            &ctx.accounts.winner_ata,
            &ctx.accounts.epoch.to_account_info(),
            seeds,
            prize,
        )?;
        transfer_signed(
            &ctx.accounts.token_program,
            &ctx.accounts.vault_ata,
            &ctx.accounts.reserve_ata,
            &ctx.accounts.epoch.to_account_info(),
            seeds,
            reserve_cut,
        )?;
        transfer_signed(
            &ctx.accounts.token_program,
            &ctx.accounts.vault_ata,
            &ctx.accounts.treasury_ata,
            &ctx.accounts.epoch.to_account_info(),
            seeds,
            treasury_cut,
        )?;

        with_epoch(&ctx.accounts.epoch, |data| {
            data[OFF_STATUS] = STATUS_SETTLED;
            let tail = off_tail(data.len())?;
            data[tail + REL_WINNER..tail + REL_WINNER + 32].copy_from_slice(winner.as_ref());
            write_u64(data, tail + REL_PRIZE, prize);
            write_u64(data, tail + REL_RESERVE, reserve_cut);
            write_u64(data, tail + REL_TREASURY, treasury_cut);
            data[tail + REL_SEED..tail + REL_SEED + 32].copy_from_slice(&seed);
            Ok(())
        })?;
        Ok(())
    }

    pub fn publish_twab(
        ctx: Context<PublishTwab>,
        twab_epoch: u64,
        root: [u8; 32],
        total: u128,
        blob_hash: [u8; 32],
    ) -> Result<()> {
        require!(total > 0, CanaryError::EmptyEpoch);
        let report = &mut ctx.accounts.report;
        report.twab_epoch = twab_epoch;
        report.root = root;
        report.total = total;
        report.blob_hash = blob_hash;
        report.authority = ctx.accounts.authority.key();
        report.slot = Clock::get()?.slot;
        report.bump = ctx.bumps.report;
        Ok(())
    }
}

fn drain(from: AccountInfo, to: AccountInfo) -> Result<()> {
    let lamports = from.lamports();
    **from.try_borrow_mut_lamports()? = 0;
    **to.try_borrow_mut_lamports()? = to
        .lamports()
        .checked_add(lamports)
        .ok_or(CanaryError::Overflow)?;
    Ok(())
}

fn credit(
    epoch: &UncheckedAccount,
    config: &Config,
    owner: Pubkey,
    amount: u64,
    now: u64,
) -> Result<(u64, u128, u128)> {
    with_epoch(epoch, |data| {
        let (prior_amt, prior_w) = depositor_position(data, owner);
        let dw = credit_into(data, config, owner, amount, now)?;
        Ok((prior_amt, prior_w, dw))
    })
}

fn credit_into(
    data: &mut [u8],
    config: &Config,
    owner: Pubkey,
    amount: u64,
    now: u64,
) -> Result<u128> {
    require!(!config.paused, CanaryError::Paused);
    require!(amount >= MIN_DEPOSIT, CanaryError::DustDeposit);
    require!(data[OFF_STATUS] == STATUS_OPEN, CanaryError::EpochNotOpen);
    require!(
        read_u64(data, OFF_ID) == config.collecting_epoch,
        CanaryError::NotCollecting
    );
    let draw_slot = read_u64(data, OFF_DRAW);
    require!(
        now.checked_add(config.cutoff_slots)
            .ok_or(CanaryError::Overflow)?
            <= draw_slot,
        CanaryError::PastCutoff
    );
    let remaining = draw_slot
        .checked_sub(now)
        .ok_or(CanaryError::PastCutoff)?;
    let dw = (amount as u128)
        .checked_mul(remaining as u128)
        .ok_or(CanaryError::Overflow)?;
    let next_total = read_u64(data, OFF_TOTAL)
        .checked_add(amount)
        .ok_or(CanaryError::Overflow)?;
    require!(
        next_total <= config.max_epoch_deposits,
        CanaryError::EpochCap
    );

    let count = data[OFF_COUNT] as usize;
    let mut found = None;
    for i in 0..count {
        if depositor_wallet(data, i) == owner {
            found = Some(i);
            break;
        }
    }
    match found {
        Some(i) => {
            let next = depositor_amount(data, i)
                .checked_add(amount)
                .ok_or(CanaryError::Overflow)?;
            require!(next <= config.max_user_deposit, CanaryError::UserCap);
            let weight = depositor_weight(data, i)
                .checked_add(dw)
                .ok_or(CanaryError::Overflow)?;
            set_depositor_amount(data, i, next);
            set_depositor_weight(data, i, weight);
        }
        None => {
            require!(count < epoch_slots(data.len())?, CanaryError::EpochFull);
            require!(amount <= config.max_user_deposit, CanaryError::UserCap);
            set_depositor(data, count, owner, amount, dw, false);
            data[OFF_COUNT] = count
                .checked_add(1)
                .ok_or(CanaryError::Overflow)? as u8;
        }
    }
    write_u64(data, OFF_TOTAL, next_total);
    let next_weight = read_u128(data, OFF_WEIGHT)
        .checked_add(dw)
        .ok_or(CanaryError::Overflow)?;
    write_u128(data, OFF_WEIGHT, next_weight);
    Ok(dw)
}

fn depositor_position(data: &[u8], owner: Pubkey) -> (u64, u128) {
    let count = data[OFF_COUNT] as usize;
    for i in 0..count {
        if depositor_wallet(data, i) == owner {
            return (depositor_amount(data, i), depositor_weight(data, i));
        }
    }
    (0, 0)
}

fn depositor_index(data: &[u8], owner: Pubkey) -> Result<(u64, u128, usize)> {
    let count = data[OFF_COUNT] as usize;
    for i in 0..count {
        if depositor_wallet(data, i) == owner {
            return Ok((depositor_amount(data, i), depositor_weight(data, i), i));
        }
    }
    err!(CanaryError::NotDepositor)
}

fn epoch_id_of(epoch: &AccountInfo) -> Result<u64> {
    let data = epoch.try_borrow_data().map_err(|_| error!(CanaryError::BadEpochSize))?;
    require!(data.len() > OFF_ID + 8, CanaryError::BadEpochSize);
    Ok(read_u64(&data, OFF_ID))
}

fn lots_pda(epoch_id: u64, owner: Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"lots", epoch_id.to_le_bytes().as_ref(), owner.as_ref()],
        &crate::ID,
    )
}

fn record_lot<'a>(
    lots: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    epoch_id: u64,
    owner: Pubkey,
    prior_amt: u64,
    prior_w: u128,
    amount: u64,
    weight: u128,
) -> Result<()> {
    let (pda, bump) = lots_pda(epoch_id, owner);
    require_keys_eq!(lots.key(), pda, CanaryError::BadLots);
    if lots.data_is_empty() {
        let lamports = Rent::get()?.minimum_balance(LOTS_SPACE);
        let id_bytes = epoch_id.to_le_bytes();
        let bump_seed = [bump];
        let seeds: &[&[u8]] = &[b"lots", id_bytes.as_ref(), owner.as_ref(), &bump_seed];
        invoke_signed(
            &system_instruction::create_account(payer.key, lots.key, lamports, LOTS_SPACE as u64, &crate::ID),
            &[payer.clone(), lots.clone(), system.clone()],
            &[seeds],
        )?;
    } else {
        require_keys_eq!(*lots.owner, crate::ID, CanaryError::BadLots);
    }
    let mut data = lots.try_borrow_mut_data().map_err(|_| error!(CanaryError::BadLots))?;
    require!(data.len() >= LOTS_SPACE, CanaryError::BadLots);
    if data[0] == 0 && prior_amt > 0 {
        push_lot(&mut data, prior_amt, prior_w)?;
    }
    push_lot(&mut data, amount, weight)
}

fn weight_to_remove(
    lots: &AccountInfo,
    epoch_id: u64,
    owner: Pubkey,
    user_amt: u64,
    user_w: u128,
    remove: u64,
) -> Result<u128> {
    if lots.data_is_empty() || lots.try_borrow_data().map(|d| d.is_empty() || d[0] == 0).unwrap_or(true) {
        return Ok(user_w
            .checked_mul(remove as u128)
            .ok_or(CanaryError::Overflow)?
            / user_amt as u128);
    }
    let (pda, _) = lots_pda(epoch_id, owner);
    require_keys_eq!(lots.key(), pda, CanaryError::BadLots);
    require_keys_eq!(*lots.owner, crate::ID, CanaryError::BadLots);
    let mut data = lots.try_borrow_mut_data().map_err(|_| error!(CanaryError::BadLots))?;
    let mut sum_amt = 0u64;
    let mut sum_w = 0u128;
    let count = data[0] as usize;
    for i in 0..count {
        let (amt, w) = read_lot(&data, i);
        sum_amt = sum_amt.checked_add(amt).ok_or(CanaryError::Overflow)?;
        sum_w = sum_w.checked_add(w).ok_or(CanaryError::Overflow)?;
    }
    require!(sum_amt == user_amt && sum_w == user_w, CanaryError::BadLots);
    lifo_take(&mut data, remove)
}

fn lifo_take(data: &mut [u8], remove: u64) -> Result<u128> {
    let mut count = data[0] as usize;
    let mut left = remove;
    let mut taken = 0u128;
    while left > 0 && count > 0 {
        let (amt, weight) = read_lot(data, count - 1);
        require!(amt > 0, CanaryError::BadLots);
        let take = left.min(amt);
        let slice_w = weight
            .checked_mul(take as u128)
            .ok_or(CanaryError::Overflow)?
            / amt as u128;
        taken = taken.checked_add(slice_w).ok_or(CanaryError::Overflow)?;
        if take == amt {
            count -= 1;
        } else {
            write_lot(data, count - 1, amt - take, weight - slice_w);
        }
        left -= take;
    }
    require!(left == 0, CanaryError::BadLots);
    data[0] = count as u8;
    Ok(taken)
}

fn push_lot(data: &mut [u8], amount: u64, weight: u128) -> Result<()> {
    let count = data[0] as usize;
    require!(count < MAX_LOTS, CanaryError::TooManyLots);
    write_lot(data, count, amount, weight);
    data[0] = (count + 1) as u8;
    Ok(())
}

fn lot_at(index: usize) -> usize {
    1 + index * LOT_SIZE
}

fn read_lot(data: &[u8], index: usize) -> (u64, u128) {
    let at = lot_at(index);
    (read_u64(data, at), read_u128(data, at + 8))
}

fn write_lot(data: &mut [u8], index: usize, amount: u64, weight: u128) {
    let at = lot_at(index);
    write_u64(data, at, amount);
    write_u128(data, at + 8, weight);
}

fn split_amounts(total: u64) -> Result<(u64, u64, u64)> {
    let winner = mul_bps(total, WINNER_BPS)?;
    let reserve = mul_bps(total, RESERVE_BPS)?;
    let treasury = mul_bps(total, TREASURY_BPS)?;
    let paid = winner
        .checked_add(reserve)
        .and_then(|v| v.checked_add(treasury))
        .ok_or(CanaryError::Overflow)?;
    let dust = total.saturating_sub(paid);
    Ok((
        winner.checked_add(dust).ok_or(CanaryError::Overflow)?,
        reserve,
        treasury,
    ))
}

fn mul_bps(amount: u64, bps: u16) -> Result<u64> {
    let n = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(CanaryError::Overflow)?
        / BPS_DENOM as u128;
    u64::try_from(n).map_err(|_| CanaryError::Overflow.into())
}

fn pick_winner(
    data: &[u8],
    count: usize,
    total_weight: u128,
    seed: &[u8; 32],
) -> Result<Pubkey> {
    require!(count > 0 && count <= epoch_slots(data.len())?, CanaryError::EmptyEpoch);
    require!(total_weight > 0, CanaryError::EmptyEpoch);
    let mut wide = [0u8; 16];
    wide.copy_from_slice(&seed[..16]);
    let target = u128::from_le_bytes(wide) % total_weight;
    let mut acc: u128 = 0;
    for i in 0..count {
        acc = acc
            .checked_add(depositor_weight(data, i))
            .ok_or(CanaryError::Overflow)?;
        if target < acc {
            return Ok(depositor_wallet(data, i));
        }
    }
    Ok(depositor_wallet(data, count - 1))
}

fn read_switchboard(account: &AccountInfo) -> Result<(u64, u64, [u8; 32], Pubkey, Pubkey)> {
    require_keys_eq!(*account.owner, SWITCHBOARD, CanaryError::BadRandomness);
    let data = account
        .try_borrow_data()
        .map_err(|_| error!(CanaryError::BadRandomness))?;
    require!(data.len() >= SB_VALUE + 32, CanaryError::BadRandomness);
    require!(data[..8] == SWITCHBOARD_DISC, CanaryError::BadRandomness);
    let sb_authority = Pubkey::new_from_array(data[SB_AUTHORITY..SB_AUTHORITY + 32].try_into().unwrap());
    let sb_queue = Pubkey::new_from_array(data[SB_QUEUE..SB_QUEUE + 32].try_into().unwrap());
    let seed_slot = u64::from_le_bytes(data[SB_SEED_SLOT..SB_SEED_SLOT + 8].try_into().unwrap());
    let reveal_slot = u64::from_le_bytes(data[SB_REVEAL_SLOT..SB_REVEAL_SLOT + 8].try_into().unwrap());
    let mut value = [0u8; 32];
    value.copy_from_slice(&data[SB_VALUE..SB_VALUE + 32]);
    Ok((seed_slot, reveal_slot, value, sb_authority, sb_queue))
}

fn deposit_room(data: &[u8], config: &Config, owner: Pubkey) -> u64 {
    let total = read_u64(data, OFF_TOTAL);
    let epoch_room = config.max_epoch_deposits.saturating_sub(total);
    let count = data[OFF_COUNT] as usize;
    if count >= epoch_slots(data.len()).unwrap_or(0) && !(0..count).any(|i| depositor_wallet(data, i) == owner) {
        return 0;
    }
    let user_have = (0..count)
        .find(|i| depositor_wallet(data, *i) == owner)
        .map(|i| depositor_amount(data, i))
        .unwrap_or(0);
    let user_room = config.max_user_deposit.saturating_sub(user_have);
    epoch_room.min(user_room)
}

fn with_epoch<T>(
    epoch: &UncheckedAccount,
    f: impl FnOnce(&mut [u8]) -> Result<T>,
) -> Result<T> {
    let info = epoch.to_account_info();
    require_keys_eq!(*info.owner, crate::ID);
    let mut borrowed = info
        .try_borrow_mut_data()
        .map_err(|_| error!(CanaryError::BadEpochSize))?;
    let data: &mut [u8] = &mut **borrowed;
    let _slots = epoch_slots(data.len())?;
    require!(data[..8] == EPOCH_DISC, CanaryError::BadEpochSize);
    let mut id_bytes = [0u8; 8];
    id_bytes.copy_from_slice(&data[OFF_ID..OFF_ID + 8]);
    let bump = data[off_tail(data.len())? + REL_BUMP];
    let pda = Pubkey::create_program_address(&[b"epoch", &id_bytes, &[bump]], &crate::ID)
        .map_err(|_| error!(CanaryError::BadEpochSize))?;
    require_keys_eq!(info.key(), pda);
    f(data)
}

fn epoch_slots(len: usize) -> Result<usize> {
    let tail = off_tail(len)?;
    Ok((tail - OFF_DEPOSITORS) / DEPOSITOR_SIZE)
}

fn off_tail(len: usize) -> Result<usize> {
    require!(len >= OFF_DEPOSITORS + EPOCH_TAIL, CanaryError::BadEpochSize);
    let body = len - OFF_DEPOSITORS;
    require!(
        body >= EPOCH_TAIL && (body - EPOCH_TAIL) % DEPOSITOR_SIZE == 0,
        CanaryError::BadEpochSize
    );
    let slots = (body - EPOCH_TAIL) / DEPOSITOR_SIZE;
    require!(
        slots == LEGACY_DEPOSITORS || slots == MAX_DEPOSITORS,
        CanaryError::BadEpochSize
    );
    Ok(OFF_DEPOSITORS + DEPOSITOR_SIZE * slots)
}

fn depositor_at(i: usize) -> usize {
    OFF_DEPOSITORS + i * DEPOSITOR_SIZE
}

fn depositor_wallet(data: &[u8], i: usize) -> Pubkey {
    let at = depositor_at(i);
    Pubkey::new_from_array(data[at..at + 32].try_into().unwrap())
}

fn depositor_amount(data: &[u8], i: usize) -> u64 {
    read_u64(data, depositor_at(i) + 32)
}

fn depositor_weight(data: &[u8], i: usize) -> u128 {
    read_u128(data, depositor_at(i) + 40)
}

fn depositor_refunded(data: &[u8], i: usize) -> bool {
    data[depositor_at(i) + 56] == 1
}

fn set_depositor_amount(data: &mut [u8], i: usize, amount: u64) {
    write_u64(data, depositor_at(i) + 32, amount);
}

fn set_depositor_weight(data: &mut [u8], i: usize, weight: u128) {
    write_u128(data, depositor_at(i) + 40, weight);
}

fn set_depositor_refunded(data: &mut [u8], i: usize, refunded: bool) {
    data[depositor_at(i) + 56] = u8::from(refunded);
}

fn set_depositor(data: &mut [u8], i: usize, wallet: Pubkey, amount: u64, weight: u128, refunded: bool) {
    let at = depositor_at(i);
    data[at..at + 32].copy_from_slice(wallet.as_ref());
    write_u64(data, at + 32, amount);
    write_u128(data, at + 40, weight);
    data[at + 56] = u8::from(refunded);
}

fn read_u64(data: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(data[at..at + 8].try_into().unwrap())
}

fn read_u128(data: &[u8], at: usize) -> u128 {
    u128::from_le_bytes(data[at..at + 16].try_into().unwrap())
}

fn write_u64(data: &mut [u8], at: usize, value: u64) {
    data[at..at + 8].copy_from_slice(&value.to_le_bytes());
}

fn write_u128(data: &mut [u8], at: usize, value: u128) {
    data[at..at + 16].copy_from_slice(&value.to_le_bytes());
}

fn transfer_signed<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: from.to_account_info(),
                to: to.to_account_info(),
                authority: authority.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        space = 8 + Config::SIZE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = config
    )]
    pub reserve_ata: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = treasury_auth
    )]
    pub treasury_ata: Account<'info, TokenAccount>,
    /// CHECK: PDA used only as ATA owner so treasury is not the same account as reserve.
    #[account(seeds = [b"treasury"], bump)]
    pub treasury_auth: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Auth<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct OpenEpoch<'info> {
    #[account(mut)]
    pub crank: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(address = config.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = crank,
        space = 8 + Epoch::SIZE,
        seeds = [b"epoch", config.next_epoch.to_le_bytes().as_ref()],
        bump
    )]
    /// CHECK: created here and written field by field. The 100-wallet list does not fit on the stack.
    pub epoch: UncheckedAccount<'info>,
    #[account(
        init,
        payer = crank,
        associated_token::mint = mint,
        associated_token::authority = epoch
    )]
    pub vault_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, Config>,
    /// CHECK: PDA, discriminator, and length are checked in load_epoch.
    #[account(mut)]
    pub epoch: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = depositor
    )]
    pub depositor_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = epoch
    )]
    pub vault_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    /// CHECK: PDA [lots, epoch_id, depositor]. Created on the first credit.
    #[account(mut)]
    pub lots: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Remove<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, Config>,
    /// CHECK: PDA, discriminator, and length are checked in with_epoch.
    #[account(mut)]
    pub epoch: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = depositor
    )]
    pub depositor_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = epoch
    )]
    pub vault_ata: Account<'info, TokenAccount>,
    /// CHECK: slice list, or an empty account when the stake is still one combined slice.
    #[account(mut)]
    pub lots: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Reclaim<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority, has_one = mint)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = authority
    )]
    pub authority_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = config
    )]
    pub reserve_ata: Account<'info, TokenAccount>,
    /// CHECK: treasury PDA, closed at the end of reclaim.
    #[account(mut, seeds = [b"treasury"], bump)]
    pub treasury_auth: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = treasury_auth
    )]
    pub treasury_ata: Account<'info, TokenAccount>,
    /// CHECK: epoch 1 PDA. Closed at the end of reclaim.
    #[account(mut, seeds = [b"epoch", EPOCH_ONE_ID.as_ref()], bump)]
    pub epoch_one: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = epoch_one
    )]
    pub epoch_one_vault: Account<'info, TokenAccount>,
    /// CHECK: epoch 2 PDA. Closed at the end of reclaim.
    #[account(mut, seeds = [b"epoch", EPOCH_TWO_ID.as_ref()], bump)]
    pub epoch_two: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = epoch_two
    )]
    pub epoch_two_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ReleaseReserve<'info> {
    pub crank: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = config
    )]
    pub reserve_ata: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Sweep<'info> {
    pub crank: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, Config>,
    /// CHECK: PDA, discriminator, and length are checked in load_epoch.
    #[account(mut)]
    pub epoch: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    /// CHECK: wNEAR owner. Not a signer; the vault delegate moves the tokens.
    pub user: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = user
    )]
    pub user_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = epoch
    )]
    pub vault_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    /// CHECK: PDA [lots, epoch_id, user]. Created on the first sweep of this wallet.
    #[account(mut)]
    pub lots: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GrowEpoch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: resized in the instruction. The 16-wallet layout cannot deserialize as Epoch.
    #[account(mut)]
    pub epoch: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, Config>,
    /// CHECK: PDA, discriminator, and length are checked in load_epoch.
    #[account(mut)]
    pub epoch: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = depositor
    )]
    pub depositor_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = epoch
    )]
    pub vault_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AuthEpoch<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: PDA, discriminator, and length are checked in load_epoch.
    #[account(mut)]
    pub epoch: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CrankClose<'info> {
    pub crank: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: PDA, discriminator, and length are checked in load_epoch.
    #[account(mut)]
    pub epoch: UncheckedAccount<'info>,
    /// CHECK: Switchboard randomness committed to a future slot. Bound onto the epoch.
    pub randomness: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    pub crank: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, Config>,
    /// CHECK: PDA, discriminator, and length are checked in load_epoch.
    #[account(mut)]
    pub epoch: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    /// CHECK: must match pick_winner; enforced in handler.
    pub winner: UncheckedAccount<'info>,
    #[account(mut)]
    pub winner_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = epoch
    )]
    pub vault_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = config
    )]
    pub reserve_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = treasury_auth
    )]
    pub treasury_ata: Account<'info, TokenAccount>,
    /// CHECK: treasury ATA owner PDA.
    #[account(seeds = [b"treasury"], bump)]
    pub treasury_auth: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Switchboard randomness account bound at close. Owner and layout are checked.
    pub randomness: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub authority: Signer<'info>,
    #[account(has_one = authority, seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint)]
    pub source: Account<'info, TokenAccount>,
    /// CHECK: config, treasury, or an epoch account. Must own `source`.
    pub source_authority: UncheckedAccount<'info>,
    #[account(mut, token::mint = mint, token::authority = authority)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RecoverEpoch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: closed after its token account is empty.
    #[account(mut)]
    pub epoch: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = config.mint,
        associated_token::authority = epoch
    )]
    pub vault_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(twab_epoch: u64)]
pub struct PublishTwab<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = authority,
        space = 8 + TwabReport::SIZE,
        seeds = [b"twab", twab_epoch.to_le_bytes().as_ref()],
        bump
    )]
    pub report: Account<'info, TwabReport>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub max_user_deposit: u64,
    pub max_epoch_deposits: u64,
    pub cutoff_slots: u64,
    pub next_epoch: u64,
    pub collecting_epoch: u64,
    pub paused: bool,
    pub bump: u8,
}

impl Config {
    pub const SIZE: usize = 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 1;
}

pub struct Epoch;

impl Epoch {
    pub const SIZE: usize = EPOCH_HEAD + DEPOSITOR_SIZE * MAX_DEPOSITORS + EPOCH_TAIL;
}

#[account]
pub struct TwabReport {
    pub twab_epoch: u64,
    pub root: [u8; 32],
    pub total: u128,
    pub blob_hash: [u8; 32],
    pub authority: Pubkey,
    pub slot: u64,
    pub bump: u8,
}

impl TwabReport {
    pub const SIZE: usize = 8 + 32 + 16 + 32 + 32 + 8 + 1;
}

#[error_code]
pub enum CanaryError {
    #[msg("cap must be positive and epoch cap >= user cap")]
    BadCap,
    #[msg("program is paused")]
    Paused,
    #[msg("amount must be > 0")]
    ZeroAmount,
    #[msg("deposit is below the minimum")]
    DustDeposit,
    #[msg("only the vault authority can do this")]
    NotAuthority,
    #[msg("epoch is not open for deposits")]
    EpochNotOpen,
    #[msg("epoch is not closed")]
    EpochNotClosed,
    #[msg("user deposit cap exceeded")]
    UserCap,
    #[msg("epoch deposit cap exceeded")]
    EpochCap,
    #[msg("epoch depositor list is full")]
    EpochFull,
    #[msg("no deposits")]
    EmptyEpoch,
    #[msg("winner account does not match the seed draw")]
    WrongWinner,
    #[msg("winner ATA owner or mint is wrong")]
    WinnerAta,
    #[msg("checked math overflow")]
    Overflow,
    #[msg("draw_slot must be after now + cutoff")]
    BadDrawSlot,
    #[msg("deposit cutoff has passed")]
    PastCutoff,
    #[msg("cannot close before the cutoff")]
    BeforeCutoff,
    #[msg("cannot settle before draw_slot")]
    BeforeDraw,
    #[msg("epoch cannot be cancelled after settle")]
    NotCancellable,
    #[msg("refunds only after cancel")]
    NotCancelled,
    #[msg("wallet did not deposit")]
    NotDepositor,
    #[msg("already refunded")]
    AlreadyRefunded,
    #[msg("another epoch is still collecting; close it first")]
    AlreadyCollecting,
    #[msg("an epoch vault still holds quote")]
    VaultNotEmpty,
    #[msg("wNEAR allowance is not granted to this vault")]
    NotDelegated,
    #[msg("deposit only against the live collecting epoch")]
    NotCollecting,
    #[msg("epoch account is not the 16-wallet size this upgrade grows")]
    BadEpochSize,
    #[msg("switchboard randomness is missing or not ready")]
    BadRandomness,
    #[msg("token account is not held by this vault")]
    NotProgramVault,
    #[msg("reserve can only move to the productive pool")]
    BadDestination,
    #[msg("credited slices do not match this stake")]
    BadLots,
    #[msg("too many credited slices in this pot")]
    TooManyLots,
}
