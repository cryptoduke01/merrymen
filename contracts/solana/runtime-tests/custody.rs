//! Runtime tests use ephemeral generated keys and synthetic pools, never network wallets.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    entrypoint::ProgramResult, program_option::COption, program_pack::Pack,
};
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::{
    associated_token::spl_associated_token_account::get_associated_token_address_with_program_id,
    token_2022::spl_token_2022,
};
use base64::Engine;
use merrymen_vault::{self as vault, Vault, JUPITER, SHARED_ROUTE, USDG, WSOL};
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::program::invoke_signed;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    signature::{Keypair, Signer},
    transaction::Transaction,
};

fn mock_jupiter(_program: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    assert!(a[2].is_signer);
    assert!(!a.iter().any(|x| x.owner == &vault::ID));
    let requested = u64::from_le_bytes(data[data.len() - 19..data.len() - 11].try_into().unwrap());
    let input = if data[8] == 2 {
        requested - 10
    } else {
        requested
    };
    let output = match data[8] {
        1 => 1,
        3 => 100,
        4 => 101,
        _ => 200,
    };
    let buy = *a[7].key == USDG;
    let input_program = if buy { &a[10] } else { &a[0] };
    let output_program = if buy { &a[0] } else { &a[10] };
    let ix = spl_token_2022::instruction::transfer_checked(
        input_program.key,
        a[3].key,
        a[7].key,
        a[4].key,
        a[2].key,
        &[],
        input,
        if buy { 6 } else { 9 },
    )?;
    invoke_signed(
        &ix,
        &[
            a[3].clone(),
            a[7].clone(),
            a[4].clone(),
            a[2].clone(),
            input_program.clone(),
        ],
        &[],
    )?;
    let (_, bump) = Pubkey::find_program_address(&[b"authority", &[0]], &JUPITER);
    let ix = spl_token_2022::instruction::transfer_checked(
        output_program.key,
        a[5].key,
        a[8].key,
        a[6].key,
        a[1].key,
        &[],
        output,
        if buy { 9 } else { 6 },
    )?;
    invoke_signed(
        &ix,
        &[
            a[5].clone(),
            a[8].clone(),
            a[6].clone(),
            a[1].clone(),
            output_program.clone(),
        ],
        &[&[b"authority", &[0], &[bump]]],
    )
}
fn account(owner: Pubkey, data: Vec<u8>, extra: u64) -> Account {
    Account {
        lamports: Rent::default().minimum_balance(data.len()) + extra,
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    }
}
fn mint(program: Pubkey, decimals: u8) -> Account {
    let m = spl_token_2022::state::Mint {
        mint_authority: COption::None,
        supply: 1000000,
        decimals,
        is_initialized: true,
        freeze_authority: COption::None,
    };
    let mut d = vec![0; 82];
    spl_token_2022::state::Mint::pack(m, &mut d).unwrap();
    account(program, d, 0)
}
fn token(program: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) -> Account {
    let rent = Rent::default().minimum_balance(165);
    let native = mint == WSOL;
    let a = spl_token_2022::state::Account {
        mint,
        owner,
        amount,
        delegate: COption::None,
        state: spl_token_2022::state::AccountState::Initialized,
        is_native: if native {
            COption::Some(rent)
        } else {
            COption::None
        },
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let mut d = vec![0; 165];
    spl_token_2022::state::Account::pack(a, &mut d).unwrap();
    account(program, d, if native { amount } else { 0 })
}
fn ata(owner: &Pubkey, mint: &Pubkey, program: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(owner, mint, program)
}
struct Fixture {
    ctx: ProgramTestContext,
    owner: Keypair,
    session: Keypair,
    vault: Pubkey,
    input: Pubkey,
    output: Pubkey,
    pool_input: Pubkey,
    pool_output: Pubkey,
    authority: Pubkey,
    last_logs: Vec<String>,
    last_fee: u64,
    /// Makes every session transaction unique, so a resent identical instruction is
    /// judged by the program rather than refused by the runtime as already processed.
    nonce: u32,
}
impl Fixture {
    async fn new() -> Self {
        let owner = Keypair::new();
        let session = Keypair::new();
        let (vault, _) =
            Pubkey::find_program_address(&[b"vault", owner.pubkey().as_ref()], &vault::ID);
        let (authority, _) = Pubkey::find_program_address(&[b"authority", &[0]], &JUPITER);
        let input = ata(&vault, &USDG, &spl_token_2022::ID);
        let output = ata(&vault, &WSOL, &anchor_spl::token::ID);
        let pool_input = Pubkey::new_unique();
        let pool_output = Pubkey::new_unique();
        let mut pt = ProgramTest::new("merrymen_vault", vault::ID, None);
        // BPF_OUT_DIR makes this same suite exercise the compiled SBF custody program.
        pt.prefer_bpf(false); // Mock Jupiter stays native; custody and bundled token programs use SBF.
                              // Use ProgramTest’s bundled real SBF Token, Token-2022 and ATA programs.
        pt.add_program("mock_jupiter", JUPITER, processor!(mock_jupiter));
        pt.add_account(
            owner.pubkey(),
            account(anchor_lang::system_program::ID, vec![], 100_000_000),
        );
        pt.add_account(
            session.pubkey(),
            account(anchor_lang::system_program::ID, vec![], 1_000_000),
        );
        pt.add_account(USDG, mint(spl_token_2022::ID, 6));
        pt.add_account(WSOL, mint(anchor_spl::token::ID, 9));
        pt.add_account(input, token(spl_token_2022::ID, USDG, vault, 1000));
        pt.add_account(output, token(anchor_spl::token::ID, WSOL, vault, 0));
        pt.add_account(pool_input, token(spl_token_2022::ID, USDG, authority, 1000));
        pt.add_account(
            pool_output,
            token(anchor_spl::token::ID, WSOL, authority, 10000),
        );
        pt.add_account(
            authority,
            account(anchor_lang::system_program::ID, vec![], 1),
        );
        pt.add_account(
            ata(&owner.pubkey(), &USDG, &spl_token_2022::ID),
            token(spl_token_2022::ID, USDG, owner.pubkey(), 0),
        );
        pt.add_account(
            ata(&owner.pubkey(), &WSOL, &anchor_spl::token::ID),
            token(anchor_spl::token::ID, WSOL, owner.pubkey(), 0),
        );
        let ctx = pt.start_with_context().await;
        let mut f = Self {
            ctx,
            owner,
            session,
            vault,
            input,
            output,
            pool_input,
            pool_output,
            authority,
            last_logs: Vec::new(),
            last_fee: 0,
            nonce: 0,
        };
        let init = Instruction {
            program_id: vault::ID,
            accounts: vault::accounts::InitializeVault {
                vault: f.vault,
                owner: f.owner.pubkey(),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: vault::instruction::InitializeVault {}.data(),
        };
        let session = f.session_ix(100, 150);
        f.owner_send(vec![init, session]).await.unwrap();
        f
    }
    fn session_ix(&self, per_trade: u64, daily: u64) -> Instruction {
        self.session_caps_ix(per_trade, daily, 100, 300)
    }
    fn session_caps_ix(
        &self,
        per_trade: u64,
        daily: u64,
        per_trade_wsol: u64,
        daily_wsol: u64,
    ) -> Instruction {
        Instruction {
            program_id: vault::ID,
            accounts: vault::accounts::OwnerAuthority {
                vault: self.vault,
                owner: self.owner.pubkey(),
            }
            .to_account_metas(None),
            data: vault::instruction::CreateSession {
                session: self.session.pubkey(),
                per_trade,
                daily,
                per_trade_wsol,
                daily_wsol,
                max_ops: 10,
                expires_at: 4_000_000_000,
            }
            .data(),
        }
    }
    async fn owner_send(
        &mut self,
        ix: Vec<Instruction>,
    ) -> std::result::Result<(), solana_program_test::BanksClientError> {
        let hash = self.ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(
            &ix,
            Some(&self.ctx.payer.pubkey()),
            &[&self.ctx.payer, &self.owner],
            hash,
        );
        self.ctx.banks_client.process_transaction(tx).await
    }
    async fn swap(
        &mut self,
        ix: Instruction,
    ) -> std::result::Result<(), solana_program_test::BanksClientError> {
        let hash = self.ctx.banks_client.get_latest_blockhash().await.unwrap();
        self.nonce += 1;
        // Appended, so the instruction under test keeps index 0; the price stays zero.
        let unique = solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_limit(
            1_000_000 + self.nonce,
        );
        let tx = Transaction::new_signed_with_payer(
            &[ix, unique],
            Some(&self.ctx.payer.pubkey()),
            &[&self.ctx.payer, &self.session],
            hash,
        );
        self.last_fee = self
            .ctx
            .banks_client
            .get_fee_for_message(tx.message.clone())
            .await?
            .expect("a fresh signed message has a fee estimate");
        let result = self
            .ctx
            .banks_client
            .process_transaction_with_metadata(tx)
            .await?;
        self.last_logs = result.metadata.map(|m| m.log_messages).unwrap_or_default();
        result.result.map_err(Into::into)
    }
    fn swap_event(&self) -> vault::SwapExecuted {
        let data = self
            .last_logs
            .iter()
            .filter_map(|line| line.strip_prefix("Program data: "))
            .filter_map(|data| base64::engine::general_purpose::STANDARD.decode(data).ok())
            .find(|data| data.len() == 208 && data[..8] == [150, 166, 26, 225, 28, 89, 38, 79])
            .expect("successful swap emits its custody event");
        vault::SwapExecuted::deserialize(&mut &data[8..]).unwrap()
    }
    async fn state(&mut self) -> Vault {
        let a = self
            .ctx
            .banks_client
            .get_account(self.vault)
            .await
            .unwrap()
            .unwrap();
        Vault::try_deserialize(&mut a.data.as_slice()).unwrap()
    }
    async fn balance(&mut self, key: Pubkey) -> u64 {
        let a = self
            .ctx
            .banks_client
            .get_account(key)
            .await
            .unwrap()
            .unwrap();
        // Accounts created by the ATA program for Token-2022 carry extensions.
        spl_token_2022::extension::StateWithExtensions::<spl_token_2022::state::Account>::unpack(
            &a.data,
        )
        .unwrap()
        .base
        .amount
    }
    async fn swap_ix(&mut self, seq: u64, epoch: u64, mode: u8) -> Instruction {
        let clock: Clock = self.ctx.banks_client.get_sysvar().await.unwrap();
        let (swap, _) = Pubkey::find_program_address(
            &[b"swap", self.vault.as_ref(), &seq.to_le_bytes()],
            &vault::ID,
        );
        let buy = mode < 3;
        let (
            input_mint,
            output_mint,
            input_program,
            output_program,
            vault_input,
            vault_output,
            pool_input,
            pool_output,
            quote,
        ) = if buy {
            (
                USDG,
                WSOL,
                spl_token_2022::ID,
                anchor_spl::token::ID,
                self.input,
                self.output,
                self.pool_input,
                self.pool_output,
                200u64,
            )
        } else {
            (
                WSOL,
                USDG,
                anchor_spl::token::ID,
                spl_token_2022::ID,
                self.output,
                self.input,
                self.pool_output,
                self.pool_input,
                100u64,
            )
        };
        let temp = ata(&swap, &input_mint, &input_program);
        let mut accounts = vault::accounts::ExecuteSwap {
            vault: self.vault,
            session_signer: self.session.pubkey(),
            fee_payer: self.ctx.payer.pubkey(),
            input_mint,
            output_mint,
            vault_input,
            vault_output,
            swap_authority: swap,
            temp_input: temp,
            input_token_program: input_program,
            output_token_program: output_program,
            jupiter_program: JUPITER,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
            // Like the executor, pass the owner's refund ATA only for a waiting donation.
            owner_refund: None,
        }
        .to_account_metas(None);
        accounts.extend([
            AccountMeta::new_readonly(anchor_spl::token::ID, false),
            AccountMeta::new_readonly(self.authority, false),
            AccountMeta::new_readonly(swap, false),
            AccountMeta::new(temp, false),
            AccountMeta::new(pool_input, false),
            AccountMeta::new(pool_output, false),
            AccountMeta::new(vault_output, false),
            AccountMeta::new_readonly(input_mint, false),
            AccountMeta::new_readonly(output_mint, false),
            AccountMeta::new_readonly(JUPITER, false),
            AccountMeta::new_readonly(spl_token_2022::ID, false),
        ]);
        let mut route_data = vec![0; 32];
        route_data[..8].copy_from_slice(&SHARED_ROUTE);
        route_data[8] = mode;
        route_data[13..21].copy_from_slice(&100u64.to_le_bytes());
        route_data[21..29].copy_from_slice(&quote.to_le_bytes());
        route_data[29..31].copy_from_slice(&100u16.to_le_bytes());
        Instruction {
            program_id: vault::ID,
            accounts,
            data: vault::instruction::ExecuteSwap {
                expected_seq: seq,
                session_epoch: epoch,
                amount_in: 100,
                min_out: quote * 99 / 100,
                deadline: clock.unix_timestamp + 29,
                slippage_bps: 100,
                route_data,
            }
            .data(),
        }
    }
    /// Any swap shape: session-chosen amount, quote, minimum and slippage.
    #[allow(clippy::too_many_arguments)]
    async fn custom_ix(
        &mut self,
        seq: u64,
        epoch: u64,
        buy: bool,
        amount_in: u64,
        quote: u64,
        min_out: u64,
        bps: u16,
        mode: u8,
    ) -> Instruction {
        let mut ix = self.swap_ix(seq, epoch, if buy { 0 } else { 3 }).await;
        let n = ix.data.len();
        // ExecuteSwap data: disc, expected_seq, session_epoch, amount_in, min_out, deadline,
        // slippage_bps, then the route bytes (u32 length + 32 bytes) at the end.
        ix.data[24..32].copy_from_slice(&amount_in.to_le_bytes());
        ix.data[32..40].copy_from_slice(&min_out.to_le_bytes());
        ix.data[48..50].copy_from_slice(&bps.to_le_bytes());
        let route = n - 32;
        ix.data[route + 8] = mode;
        ix.data[route + 13..route + 21].copy_from_slice(&amount_in.to_le_bytes());
        ix.data[route + 21..route + 29].copy_from_slice(&quote.to_le_bytes());
        ix.data[route + 29..route + 31].copy_from_slice(&bps.to_le_bytes());
        ix
    }
    /// Passes the owner's canonical input ATA in the optional refund slot.
    fn with_refund(&self, mut ix: Instruction) -> Instruction {
        let refund = ata(
            &self.owner.pubkey(),
            &ix.accounts[3].pubkey,
            &ix.accounts[9].pubkey,
        );
        ix.accounts[14] = AccountMeta::new(refund, false);
        ix
    }
    /// Unsolicited tokens already in a swap's temporary input ATA.
    fn donate(&mut self, ix: &Instruction, amount: u64) {
        let (temp, authority) = (ix.accounts[8].pubkey, ix.accounts[7].pubkey);
        let (mint, program) = (ix.accounts[3].pubkey, ix.accounts[9].pubkey);
        self.ctx
            .set_account(&temp, &token(program, mint, authority, amount).into());
    }
    /// The owner closes an empty token account of theirs, as a wallet unwrap or rent reclaim does.
    async fn owner_closes(&mut self, mint: Pubkey, program: Pubkey) {
        let account = ata(&self.owner.pubkey(), &mint, &program);
        let close = spl_token_2022::instruction::close_account(
            &program,
            &account,
            &self.owner.pubkey(),
            &self.owner.pubkey(),
            &[],
        )
        .unwrap();
        self.owner_send(vec![close]).await.unwrap();
        assert!(self
            .ctx
            .banks_client
            .get_account(account)
            .await
            .unwrap()
            .is_none());
    }
    async fn exists(&mut self, key: Pubkey) -> bool {
        self.ctx.banks_client.get_account(key).await.unwrap().is_some()
    }
    async fn hold_wsol(&mut self, amount: u64) {
        self.ctx.set_account(
            &self.output,
            &token(anchor_spl::token::ID, WSOL, self.vault, amount).into(),
        );
        assert_eq!(self.balance(self.output).await, amount);
    }
}
/// The custody program's own error, not a token or runtime failure.
fn vault_error(
    result: std::result::Result<(), solana_program_test::BanksClientError>,
    expected: vault::VaultError,
) -> bool {
    custom_error(result, 6000 + expected as u32)
}
/// A specific custom error code, such as an Anchor account constraint (2000-3999).
fn custom_error(
    result: std::result::Result<(), solana_program_test::BanksClientError>,
    expected: u32,
) -> bool {
    use solana_sdk::{instruction::InstructionError, transaction::TransactionError};
    // Covers both a processed failure and a preflight simulation failure.
    match result {
        Ok(()) => false,
        Err(e) => {
            let e = e.unwrap();
            let matched = matches!(
                e,
                TransactionError::InstructionError(0, InstructionError::Custom(code))
                    if code == expected
            );
            if !matched {
                eprintln!("expected custom error {expected}, got {e:?}");
            }
            matched
        }
    }
}
/// Anchor 0.32 account-constraint codes used below.
const ANCHOR_SEEDS: u32 = 2006;
const ANCHOR_ASSOCIATED: u32 = 2009;
const ANCHOR_TOKEN_OWNER: u32 = 2015;
const ANCHOR_NOT_INITIALIZED: u32 = 3012;
#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn successful_cpi_is_bounded_replay_safe_and_budget_survives_session_replacement() {
    let mut f = Fixture::new().await;
    let ix = f.swap_ix(0, 1, 0).await;
    let temp = ix.accounts[8].pubkey;
    f.swap(ix).await.unwrap();
    assert_eq!(f.balance(f.input).await, 900);
    assert_eq!(f.balance(f.output).await, 200);
    assert!(f
        .ctx
        .banks_client
        .get_account(temp)
        .await
        .unwrap()
        .is_none());
    assert_eq!(f.state().await.seq, 1);
    let stale = f.swap_ix(0, 1, 0).await;
    assert!(f.swap(stale).await.is_err());
    let session = f.session_ix(100, 150);
    f.owner_send(vec![session]).await.unwrap();
    let state = f.state().await;
    assert_eq!(state.seq, 1);
    assert_eq!(state.session_epoch, 2);
    assert_eq!(state.debits.len(), 1);
    let too_much = f.swap_ix(1, 2, 0).await;
    assert!(f.swap(too_much).await.is_err());
    assert_eq!(f.balance(f.input).await, 900);
}
#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn failed_output_and_authority_smuggling_roll_back_every_balance_and_sequence() {
    let mut f = Fixture::new().await;
    let bad = f.swap_ix(0, 1, 1).await;
    assert!(f.swap(bad).await.is_err());
    assert_eq!(f.balance(f.input).await, 1000);
    assert_eq!(f.balance(f.output).await, 0);
    assert_eq!(f.state().await.seq, 0);
    let mut bad = f.swap_ix(0, 1, 0).await;
    bad.accounts.push(AccountMeta::new(f.input, false));
    assert!(f.swap(bad).await.is_err());
    let mut bad = f.swap_ix(0, 1, 0).await;
    bad.accounts
        .push(AccountMeta::new_readonly(f.session.pubkey(), true));
    assert!(f.swap(bad).await.is_err());
    assert_eq!(f.balance(f.input).await, 1000);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn donations_and_route_dust_return_to_custody_without_resetting_budget() {
    let mut f = Fixture::new().await;
    let ix = f.swap_ix(0, 1, 2).await;
    let ix = f.with_refund(ix);
    f.donate(&ix, 7);
    f.swap(ix).await.unwrap();
    assert_eq!(f.balance(f.input).await, 910);
    let event = f
        .last_logs
        .iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .filter_map(|data| base64::engine::general_purpose::STANDARD.decode(data).ok())
        .find(|data| data.len() == 208 && data[..8] == [150, 166, 26, 225, 28, 89, 38, 79])
        .unwrap();
    let amount_in = u64::from_le_bytes(event[184..192].try_into().unwrap());
    assert_eq!(amount_in, 1000 - f.balance(f.input).await);
    assert_eq!(amount_in, 90);

    assert_eq!(
        f.balance(ata(&f.owner.pubkey(), &USDG, &spl_token_2022::ID))
            .await,
        7
    );
    assert_eq!(f.balance(f.output).await, 200);
    assert_eq!(f.state().await.debits[0].notional, 100);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn system_prefunding_is_initialized_and_only_preexisting_lamports_offset_the_fee() {
    // Cover a top-up below token rent and excess funding above token rent.
    // Both deposits are ordinary owner-signed system transfers, not injected token state.
    for prefunding in [900_000, Rent::default().minimum_balance(165) + 1234] {
        let mut f = Fixture::new().await;
        let ix = f.swap_ix(0, 1, 0).await;
        let temp = ix.accounts[8].pubkey;
        f.owner_send(vec![solana_sdk::system_instruction::transfer(
            &f.owner.pubkey(),
            &temp,
            prefunding,
        )])
        .await
        .unwrap();
        let before = f.ctx.banks_client.get_account(temp).await.unwrap().unwrap();
        assert_eq!(before.owner, anchor_lang::system_program::ID);
        assert!(before.data.is_empty());
        assert_eq!(before.lamports, prefunding);
        let payer_before = f
            .ctx
            .banks_client
            .get_balance(f.ctx.payer.pubkey())
            .await
            .unwrap();
        // System-owned lamports are not a token donation, so no refund account is passed.
        assert_eq!(ix.accounts[14].pubkey, vault::ID);
        let owner_refund = ata(&f.owner.pubkey(), &USDG, &spl_token_2022::ID);
        let owner_lamports = f.ctx.banks_client.get_balance(owner_refund).await.unwrap();

        f.swap(ix).await.unwrap();

        assert!(f
            .ctx
            .banks_client
            .get_account(temp)
            .await
            .unwrap()
            .is_none());
        let payer_after = f
            .ctx
            .banks_client
            .get_balance(f.ctx.payer.pubkey())
            .await
            .unwrap();
        assert_eq!(payer_after, payer_before - f.last_fee + prefunding);
        assert_eq!(f.balance(owner_refund).await, 0);
        assert_eq!(
            f.ctx.banks_client.get_balance(owner_refund).await.unwrap(),
            owner_lamports
        );
        assert_eq!(f.balance(f.input).await, 900);
        assert_eq!(f.balance(f.output).await, 200);
        let event = f.swap_event();
        assert_eq!(event.input_mint, USDG);
        assert_eq!(event.amount_in, 1000 - f.balance(f.input).await);
        assert_eq!(event.amount_out, f.balance(f.output).await);
        assert_eq!(f.state().await.seq, 1);
    }
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn wsol_donation_moves_native_backing_to_owner_and_only_remaining_lamports_refund_payer() {
    let mut f = Fixture::new().await;
    let buy = f.swap_ix(0, 1, 0).await;
    f.swap(buy).await.unwrap();
    let session = f.session_ix(100, 500);
    f.owner_send(vec![session]).await.unwrap();
    let sell = f.swap_ix(1, 2, 3).await;
    let sell = f.with_refund(sell);
    let temp = sell.accounts[8].pubkey;
    let swap = sell.accounts[7].pubkey;
    let refund = sell.accounts[14].pubkey;
    let donated_tokens = 7;
    let unsynced_lamports = 13;
    f.owner_send(vec![
        anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent(
            &f.owner.pubkey(), &swap, &WSOL, &anchor_spl::token::ID,
        ),
        solana_sdk::system_instruction::transfer(&f.owner.pubkey(), &temp, donated_tokens),
        spl_token_2022::instruction::sync_native(&anchor_spl::token::ID, &temp).unwrap(),
        // An unsynced native transfer changes lamports, not the stored token amount.
        solana_sdk::system_instruction::transfer(&f.owner.pubkey(), &temp, unsynced_lamports),
    ]).await.unwrap();
    let before = f.ctx.banks_client.get_account(temp).await.unwrap().unwrap();
    let tokens = spl_token_2022::state::Account::unpack(&before.data).unwrap();
    assert_eq!(before.owner, anchor_spl::token::ID);
    assert_eq!(tokens.owner, swap);
    assert_eq!(tokens.mint, WSOL);
    assert_eq!(tokens.amount, donated_tokens);
    let reserve = match tokens.is_native {
        COption::Some(reserve) => reserve,
        _ => panic!("WSOL requires its native reserve"),
    };
    assert_eq!(
        before.lamports,
        reserve + donated_tokens + unsynced_lamports
    );
    let payer_before = f
        .ctx
        .banks_client
        .get_balance(f.ctx.payer.pubkey())
        .await
        .unwrap();
    let refund_before = f.ctx.banks_client.get_balance(refund).await.unwrap();
    let vault_input_before = f.ctx.banks_client.get_balance(f.output).await.unwrap();

    f.swap(sell).await.unwrap();

    assert!(f
        .ctx
        .banks_client
        .get_account(temp)
        .await
        .unwrap()
        .is_none());
    assert_eq!(f.balance(refund).await, donated_tokens);
    assert_eq!(
        f.ctx.banks_client.get_balance(refund).await.unwrap(),
        refund_before + donated_tokens
    );
    let payer_after = f
        .ctx
        .banks_client
        .get_balance(f.ctx.payer.pubkey())
        .await
        .unwrap();
    // This is exactly the settlement verifier's pre-lamports minus pre-token rule.
    assert_eq!(
        payer_after,
        payer_before - f.last_fee + before.lamports - tokens.amount
    );
    assert_eq!(
        f.ctx.banks_client.get_balance(f.output).await.unwrap(),
        vault_input_before - 100
    );
    assert_eq!(f.balance(f.output).await, 100);
    assert_eq!(f.balance(f.input).await, 1000);
    let event = f.swap_event();
    assert_eq!(event.input_mint, WSOL);
    assert_eq!(event.amount_in, 200 - f.balance(f.output).await);
    assert_eq!(event.amount_out, f.balance(f.input).await - 900);
    assert_eq!(f.state().await.seq, 2);
    assert_eq!(f.state().await.debits[1].notional, 100);
}
#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn sell_checks_actual_cash_proceeds_and_breaker_only_owner_can_reset() {
    let mut f = Fixture::new().await;
    let buy = f.swap_ix(0, 1, 0).await;
    f.swap(buy).await.unwrap();
    let new_session = f.session_ix(100, 500);
    f.owner_send(vec![new_session]).await.unwrap();
    let breaker = |authority, paused| Instruction {
        program_id: vault::ID,
        accounts: vault::accounts::BreakerAuthority {
            vault: f.vault,
            authority,
        }
        .to_account_metas(None),
        data: vault::instruction::SetBreaker { paused }.data(),
    };
    let pause = breaker(f.session.pubkey(), true);
    let unpause = breaker(f.session.pubkey(), false);
    f.swap(pause).await.unwrap();
    assert!(f.swap(unpause).await.is_err());
    let bad_buy = f.swap_ix(1, 2, 0).await;
    assert!(f.swap(bad_buy).await.is_err());
    let excessive = f.swap_ix(1, 2, 4).await;
    assert!(f.swap(excessive).await.is_err());
    assert_eq!(f.balance(f.input).await, 900);
    assert_eq!(f.balance(f.output).await, 200);
    let sell = f.swap_ix(1, 2, 3).await;
    f.swap(sell).await.unwrap();
    assert_eq!(f.balance(f.input).await, 1000);
    assert_eq!(f.balance(f.output).await, 100);
    assert_eq!(f.state().await.seq, 2);
}
#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn owner_recovery_works_after_revoke_and_cannot_redirect_to_other_owner() {
    let mut f = Fixture::new().await;
    let revoke = Instruction {
        program_id: vault::ID,
        accounts: vault::accounts::OwnerAuthority {
            vault: f.vault,
            owner: f.owner.pubkey(),
        }
        .to_account_metas(None),
        data: vault::instruction::RevokeAll {}.data(),
    };
    f.owner_send(vec![revoke]).await.unwrap();
    let bad = f.swap_ix(0, 1, 0).await;
    assert!(f.swap(bad).await.is_err());
    let destination = ata(&f.owner.pubkey(), &USDG, &spl_token_2022::ID);
    f.ctx.set_account(
        &destination,
        &token(spl_token_2022::ID, USDG, f.owner.pubkey(), 0).into(),
    );
    let mut withdraw = Instruction {
        program_id: vault::ID,
        accounts: vault::accounts::Withdraw {
            vault: f.vault,
            owner: f.owner.pubkey(),
            mint: USDG,
            vault_token: f.input,
            owner_token: destination,
            token_program: spl_token_2022::ID,
        }
        .to_account_metas(None),
        data: vault::instruction::Withdraw { amount: 1000 }.data(),
    };
    let good = withdraw.clone();
    withdraw.accounts[4].pubkey = f.pool_input;
    assert!(f.owner_send(vec![withdraw]).await.is_err());
    f.owner_send(vec![good]).await.unwrap();
    assert_eq!(f.balance(f.input).await, 0);
    assert_eq!(f.balance(destination).await, 1000);
    assert_eq!(f.state().await.seq, 1);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn native_recovery_preserves_rent_and_requires_owner() {
    let mut f = Fixture::new().await;
    let reserve = f.ctx.banks_client.get_balance(f.vault).await.unwrap();
    let deposit = solana_sdk::system_instruction::transfer(&f.owner.pubkey(), &f.vault, 100);
    f.owner_send(vec![deposit]).await.unwrap();
    let withdraw = |owner, amount| Instruction {
        program_id: vault::ID,
        accounts: vault::accounts::OwnerNativeWithdraw {
            vault: f.vault,
            owner,
        }
        .to_account_metas(None),
        data: vault::instruction::WithdrawSol { amount }.data(),
    };
    let bad = withdraw(f.session.pubkey(), 100);
    let excessive = withdraw(f.owner.pubkey(), 101);
    let good = withdraw(f.owner.pubkey(), 100);
    assert!(f.swap(bad).await.is_err());
    assert!(f.owner_send(vec![excessive]).await.is_err());
    f.owner_send(vec![good]).await.unwrap();
    assert_eq!(
        f.ctx.banks_client.get_balance(f.vault).await.unwrap(),
        reserve
    );
    assert_eq!(f.state().await.seq, 1);
}

#[test]
#[ignore = "run with complete custody verification suite"]
fn jupiter_discriminator_matches_official_anchor_method() {
    assert_eq!(
        SHARED_ROUTE,
        solana_sdk::hash::hash(b"global:shared_accounts_route").to_bytes()[..8]
    );
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn dust_priced_full_exit_is_refused_by_the_wsol_input_cap() {
    // Audit VAULT-1: 5000 raw WSOL, a session-chosen quote of 1 and min_out of 1 used to
    // empty custody for 1 micro-USDG, charged 1 against per_trade=100/daily=150.
    let mut f = Fixture::new().await;
    f.hold_wsol(5_000).await;
    let dust = f.custom_ix(0, 1, false, 5_000, 1, 1, 0, 1).await;
    assert!(vault_error(
        f.swap(dust).await,
        vault::VaultError::RiskLimit
    ));
    // The fair-priced full exit is refused as before (and now on input too).
    let fair = f.custom_ix(0, 1, false, 5_000, 200, 198, 100, 0).await;
    assert!(vault_error(
        f.swap(fair).await,
        vault::VaultError::RiskLimit
    ));
    // Just over the per-trade WSOL cap of 100 is refused even at a dust price.
    let over = f.custom_ix(0, 1, false, 101, 1, 1, 0, 1).await;
    assert!(vault_error(
        f.swap(over).await,
        vault::VaultError::RiskLimit
    ));
    assert_eq!(f.balance(f.output).await, 5_000);
    assert_eq!(f.balance(f.input).await, 1_000);
    let state = f.state().await;
    assert_eq!(state.seq, 0);
    assert!(state.debits.is_empty());
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn a_session_paused_breaker_does_not_reopen_the_dust_exit() {
    // Sells stay available while buys are paused, so the input cap must hold there too.
    let mut f = Fixture::new().await;
    f.hold_wsol(5_000).await;
    let pause = Instruction {
        program_id: vault::ID,
        accounts: vault::accounts::BreakerAuthority {
            vault: f.vault,
            authority: f.session.pubkey(),
        }
        .to_account_metas(None),
        data: vault::instruction::SetBreaker { paused: true }.data(),
    };
    f.swap(pause).await.unwrap();
    assert!(f.state().await.paused);
    let dust = f.custom_ix(0, 1, false, 5_000, 1, 1, 0, 1).await;
    assert!(vault_error(
        f.swap(dust).await,
        vault::VaultError::RiskLimit
    ));
    assert_eq!(f.balance(f.output).await, 5_000);
    // An exit within the cap still works while paused.
    let exit = f.custom_ix(0, 1, false, 100, 1, 1, 0, 1).await;
    f.swap(exit).await.unwrap();
    assert_eq!(f.balance(f.output).await, 4_900);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn sells_record_their_input_and_the_rolling_wsol_budget_survives_replacement() {
    let mut f = Fixture::new().await;
    f.hold_wsol(5_000).await;
    // Generous cash caps so only the WSOL caps can refuse: 100 per sell, 250 a day.
    let caps = f.session_caps_ix(1_000, 10_000, 100, 250);
    f.owner_send(vec![caps]).await.unwrap();
    let first = f.custom_ix(0, 2, false, 100, 1, 1, 0, 1).await;
    f.swap(first).await.unwrap();
    let state = f.state().await;
    assert_eq!(state.debits.len(), 1);
    assert_eq!(state.debits[0].wsol, 100);
    assert_eq!(state.debits[0].notional, 1);
    let second = f.custom_ix(1, 2, false, 100, 1, 1, 0, 1).await;
    f.swap(second).await.unwrap();
    let third = f.custom_ix(2, 2, false, 100, 1, 1, 0, 1).await;
    assert!(vault_error(
        f.swap(third).await,
        vault::VaultError::RiskLimit
    ));
    let rest = f.custom_ix(2, 2, false, 50, 1, 1, 0, 1).await;
    f.swap(rest).await.unwrap();
    assert_eq!(f.balance(f.output).await, 4_750);
    // A replacement session never resets the rolling WSOL history.
    let replacement = f.session_caps_ix(1_000, 10_000, 100, 250);
    f.owner_send(vec![replacement]).await.unwrap();
    let after = f.custom_ix(3, 3, false, 1, 1, 1, 0, 1).await;
    assert!(vault_error(
        f.swap(after).await,
        vault::VaultError::RiskLimit
    ));
    let state = f.state().await;
    assert_eq!(state.seq, 3);
    assert_eq!(state.debits.iter().map(|d| d.wsol).sum::<u64>(), 250);
    // Buys charge cash only.
    let buy = f.swap_ix(3, 3, 0).await;
    f.swap(buy).await.unwrap();
    assert_eq!(f.state().await.debits.last().unwrap().wsol, 0);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn a_session_without_a_wsol_input_bound_cannot_be_created() {
    let mut f = Fixture::new().await;
    for (per_trade_wsol, daily_wsol) in [(0, 0), (0, 100), (200, 100)] {
        let bad = f.session_caps_ix(100, 150, per_trade_wsol, daily_wsol);
        let hash = f.ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(
            &[bad],
            Some(&f.ctx.payer.pubkey()),
            &[&f.ctx.payer, &f.owner],
            hash,
        );
        assert!(vault_error(
            f.ctx.banks_client.process_transaction(tx).await,
            vault::VaultError::RiskLimit
        ));
    }
    let state = f.state().await;
    assert_eq!(state.session_epoch, 1);
    assert_eq!((state.per_trade_wsol, state.daily_wsol), (100, 300));
    assert_eq!(state.version, vault::VERSION);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn an_owner_who_closed_their_token_accounts_can_still_buy_and_exit() {
    // Audit VAULT-2: unwrapping WSOL in a wallet closes the owner's WSOL ATA. That used to
    // fail every later sell, including stop-loss exits, with AccountNotInitialized.
    let mut f = Fixture::new().await;
    f.owner_closes(USDG, spl_token_2022::ID).await;
    f.owner_closes(WSOL, anchor_spl::token::ID).await;
    let buy = f.swap_ix(0, 1, 0).await;
    assert_eq!(buy.accounts[14], AccountMeta::new_readonly(vault::ID, false));
    f.swap(buy).await.unwrap();
    assert_eq!((f.balance(f.input).await, f.balance(f.output).await), (900, 200));
    let caps = f.session_ix(100, 500);
    f.owner_send(vec![caps]).await.unwrap();
    let sell = f.swap_ix(1, 2, 3).await;
    f.swap(sell).await.unwrap();
    assert_eq!((f.balance(f.input).await, f.balance(f.output).await), (1000, 100));
    let event = f.swap_event();
    assert_eq!((event.input_mint, event.amount_in, event.amount_out), (WSOL, 100, 100));
    assert_eq!(f.state().await.seq, 2);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn a_donation_without_the_owners_refund_account_fails_closed_and_is_never_traded() {
    let mut f = Fixture::new().await;
    let refund = ata(&f.owner.pubkey(), &USDG, &spl_token_2022::ID);
    let ix = f.swap_ix(0, 1, 0).await;
    let temp = ix.accounts[8].pubkey;
    f.donate(&ix, 7);
    // Left out: the program refuses rather than counting the donation as trade input.
    assert!(vault_error(
        f.swap(ix.clone()).await,
        vault::VaultError::RefundAccount
    ));
    // The owner's account closed: it cannot be passed either, and nobody else's may stand in.
    f.owner_closes(USDG, spl_token_2022::ID).await;
    let closed = f.with_refund(ix.clone());
    assert!(custom_error(f.swap(closed).await, ANCHOR_NOT_INITIALIZED));
    assert!(vault_error(
        f.swap(ix.clone()).await,
        vault::VaultError::RefundAccount
    ));
    let stranger = Pubkey::new_unique();
    let stranger_ata = ata(&stranger, &USDG, &spl_token_2022::ID);
    f.ctx.set_account(
        &stranger_ata,
        &token(spl_token_2022::ID, USDG, stranger, 0).into(),
    );
    let mut foreign = ix.clone();
    foreign.accounts[14] = AccountMeta::new(stranger_ata, false);
    assert!(custom_error(f.swap(foreign).await, ANCHOR_TOKEN_OWNER));
    // An owner-held token account that is not the canonical ATA is refused too.
    let side = Pubkey::new_unique();
    f.ctx.set_account(
        &side,
        &token(spl_token_2022::ID, USDG, f.owner.pubkey(), 0).into(),
    );
    let mut noncanonical = ix.clone();
    noncanonical.accounts[14] = AccountMeta::new(side, false);
    assert!(custom_error(f.swap(noncanonical).await, ANCHOR_ASSOCIATED));
    assert_eq!(f.balance(temp).await, 7);
    assert_eq!(f.balance(f.input).await, 1000);
    let state = f.state().await;
    assert_eq!(state.seq, 0);
    assert!(state.debits.is_empty());
    // Reopening the account lets the same sequence run; the donation goes to the owner
    // and the receipt counts only custody's own input.
    f.owner_send(vec![
        anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent(
            &f.owner.pubkey(), &f.owner.pubkey(), &USDG, &spl_token_2022::ID,
        ),
    ])
    .await
    .unwrap();
    let reopened = f.with_refund(ix);
    f.swap(reopened).await.unwrap();
    assert_eq!(f.balance(refund).await, 7);
    assert_eq!(f.balance(f.input).await, 900);
    assert!(!f.exists(temp).await);
    let event = f.swap_event();
    assert_eq!((event.amount_in, event.amount_out), (100, 200));
    assert_eq!(f.state().await.debits[0].notional, 100);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn the_route_never_reaches_the_owners_token_accounts_whether_or_not_refund_is_passed() {
    let mut f = Fixture::new().await;
    let owner_usdg = ata(&f.owner.pubkey(), &USDG, &spl_token_2022::ID);
    let owner_wsol = ata(&f.owner.pubkey(), &WSOL, &anchor_spl::token::ID);
    for refund in [false, true] {
        for target in [owner_usdg, owner_wsol] {
            let mut ix = f.swap_ix(0, 1, 0).await;
            if refund {
                ix = f.with_refund(ix);
            }
            ix.accounts.push(AccountMeta::new(target, false));
            assert!(vault_error(f.swap(ix).await, vault::VaultError::Route));
        }
    }
    assert_eq!(f.balance(f.input).await, 1000);
    assert_eq!(f.state().await.seq, 0);
}
