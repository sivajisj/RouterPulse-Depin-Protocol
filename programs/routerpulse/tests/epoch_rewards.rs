use anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use litesvm_token::{get_spl_account, CreateAssociatedTokenAccount, CreateMint, MintTo};
use routerpulse::{accounts as accts, instruction as ix, ID as PROGRAM_ID};
use solana_address::Address;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_native_token::LAMPORTS_PER_SOL;
use solana_signer::Signer;
use solana_transaction::Transaction;

const REWARD_RATE: u64 = 100;
const PENALTY_BPS: u16 = 1000;
const HEARTBEAT_INTERVAL: i64 = 60;

fn program_path() -> String {
    // cargo build-sbf places the .so in the workspace-root target/deploy dir.
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/routerpulse.so").to_string()
}

struct Harness {
    svm: LiteSVM,
    authority: Keypair,
    mint: Address,
    treasury: Address,
}

fn protocol_pda() -> (Address, u8) {
    Address::find_program_address(&[b"protocol".as_slice()], &PROGRAM_ID)
}

fn router_pda(owner: &Address, router_id: &str) -> (Address, u8) {
    Address::find_program_address(
        &[b"router".as_slice(), owner.as_ref(), router_id.as_bytes()],
        &PROGRAM_ID,
    )
}

fn epoch_pda(epoch_id: u64) -> (Address, u8) {
    Address::find_program_address(
        &[b"epoch".as_slice(), &epoch_id.to_le_bytes()],
        &PROGRAM_ID,
    )
}

fn reward_pda(router: &Address, epoch_id: u64) -> (Address, u8) {
    Address::find_program_address(
        &[b"reward".as_slice(), router.as_ref(), &epoch_id.to_le_bytes()],
        &PROGRAM_ID,
    )
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, extra_signers: &[&Keypair]) {
    let msg = Message::new(ixs, Some(&payer.pubkey()));
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra_signers);
    let tx = Transaction::new(&signers, msg, svm.latest_blockhash());
    svm.send_transaction(tx).expect("transaction should succeed");
}

fn try_send(
    svm: &mut LiteSVM,
    ixs: &[Instruction],
    payer: &Keypair,
    extra_signers: &[&Keypair],
) -> Result<(), String> {
    let msg = Message::new(ixs, Some(&payer.pubkey()));
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra_signers);
    let tx = Transaction::new(&signers, msg, svm.latest_blockhash());
    svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{e:?}"))
}

/// Sets up: protocol + RPULSE mint + treasury (funded), ready for
/// open_epoch/finalize_epoch/claim_reward tests.
fn setup(treasury_funding: u64) -> Harness {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(PROGRAM_ID, program_path())
        .expect("failed to load routerpulse.so — run `cargo build-sbf` first");

    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 100 * LAMPORTS_PER_SOL).unwrap();

    let mint = CreateMint::new(&mut svm, &authority)
        .authority(&authority.pubkey())
        .decimals(9)
        .send()
        .expect("mint creation failed");

    let (protocol, _) = protocol_pda();

    let treasury_ata = anchor_spl_ata_address(&protocol, &mint);

    let init_accounts = accts::InitializeProtocol {
        protocol,
        token_mint: mint,
        treasury: treasury_ata,
        authority: authority.pubkey(),
        token_program: litesvm_token::TOKEN_ID,
        associated_token_program: spl_associated_token_account_interface::program::ID,
        system_program: solana_system_interface::program::ID,
    }
    .to_account_metas(None);

    let init_data = ix::InitializeProtocol {
        reward_rate: REWARD_RATE,
        penalty_bps: PENALTY_BPS,
        heartbeat_interval: HEARTBEAT_INTERVAL,
    }
    .data();

    send(
        &mut svm,
        &[Instruction {
            program_id: PROGRAM_ID,
            accounts: init_accounts,
            data: init_data,
        }],
        &authority,
        &[],
    );

    if treasury_funding > 0 {
        MintTo::new(&mut svm, &authority, &mint, &treasury_ata, treasury_funding)
            .send()
            .expect("funding treasury failed");
    }

    Harness {
        svm,
        authority,
        mint,
        treasury: treasury_ata,
    }
}

fn anchor_spl_ata_address(owner: &Address, mint: &Address) -> Address {
    spl_associated_token_account_interface::address::get_associated_token_address(owner, mint)
}

fn register_router(h: &mut Harness, owner: &Keypair, router_id: &str) -> Address {
    h.svm.airdrop(&owner.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();
    let (router, _) = router_pda(&owner.pubkey(), router_id);
    let (protocol, _) = protocol_pda();

    let accounts = accts::RegisterRouter {
        router,
        protocol,
        owner: owner.pubkey(),
        system_program: solana_system_interface::program::ID,
    }
    .to_account_metas(None);

    let data = ix::RegisterRouter {
        router_id: router_id.to_string(),
        location_lat: 19_076_000,
        location_long: 72_877_000,
    }
    .data();

    send(
        &mut h.svm,
        &[Instruction { program_id: PROGRAM_ID, accounts, data }],
        owner,
        &[],
    );

    router
}

fn open_epoch(
    h: &mut Harness,
    signer: &Keypair,
    epoch_id: u64,
    reward_budget: u64,
) -> Result<Address, String> {
    let (epoch, _) = epoch_pda(epoch_id);
    let (protocol, _) = protocol_pda();

    let accounts = accts::OpenEpoch {
        epoch,
        protocol,
        authority: signer.pubkey(),
        system_program: solana_system_interface::program::ID,
    }
    .to_account_metas(None);

    let data = ix::OpenEpoch {
        epoch_id,
        reward_budget,
        start_time: 1_000,
        end_time: 2_000,
    }
    .data();

    try_send(
        &mut h.svm,
        &[Instruction { program_id: PROGRAM_ID, accounts, data }],
        signer,
        &[],
    )?;

    Ok(epoch)
}

struct FinalizeInput {
    router: Address,
    service_score: u16,
    reward_weight: u64,
}

fn finalize_epoch(
    h: &mut Harness,
    signer: &Keypair,
    epoch_id: u64,
    total_network_weight: u64,
    inputs: &[FinalizeInput],
) -> Result<(), String> {
    let (epoch, _) = epoch_pda(epoch_id);
    let (protocol, _) = protocol_pda();

    let mut accounts = accts::FinalizeEpoch {
        epoch,
        protocol,
        authority: signer.pubkey(),
        system_program: solana_system_interface::program::ID,
    }
    .to_account_metas(None);

    for input in inputs {
        let (reward, _) = reward_pda(&input.router, epoch_id);
        accounts.push(solana_instruction::AccountMeta::new(reward, false));
    }

    let data = ix::FinalizeEpoch {
        proof_root: [7u8; 32],
        total_network_weight,
        inputs: inputs
            .iter()
            .map(|i| routerpulse::instructions::finalize_epoch::RewardInput {
                router: i.router,
                service_score: i.service_score,
                reward_weight: i.reward_weight,
            })
            .collect(),
    }
    .data();

    try_send(
        &mut h.svm,
        &[Instruction { program_id: PROGRAM_ID, accounts, data }],
        signer,
        &[],
    )
}

fn claim_reward(
    h: &mut Harness,
    owner: &Keypair,
    router: Address,
    epoch_id: u64,
) -> Result<(), String> {
    let (reward, _) = reward_pda(&router, epoch_id);
    let (epoch, _) = epoch_pda(epoch_id);
    let (protocol, _) = protocol_pda();
    let operator_ata = anchor_spl_ata_address(&owner.pubkey(), &h.mint);

    // Operator ATA must already exist (pass-1 simplification, see
    // claim_reward.rs docs) — create it if this is the first claim.
    if h.svm.get_account(&operator_ata).is_none() {
        CreateAssociatedTokenAccount::new(&mut h.svm, owner, &h.mint)
            .send()
            .expect("failed to create operator ATA");
    }

    let accounts = accts::ClaimReward {
        reward,
        epoch,
        router,
        protocol,
        treasury: h.treasury,
        operator_ata,
        owner: owner.pubkey(),
        token_program: litesvm_token::TOKEN_ID,
    }
    .to_account_metas(None);

    let data = ix::ClaimReward {}.data();

    try_send(
        &mut h.svm,
        &[Instruction { program_id: PROGRAM_ID, accounts, data }],
        owner,
        &[],
    )
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

#[test]
fn open_epoch_succeeds_for_authority() {
    let mut h = setup(0);
    let authority = Keypair::new_from_array(h.authority.to_bytes()[..32].try_into().unwrap());
    let result = open_epoch(&mut h, &authority, 1, 1_000_000);
    assert!(result.is_ok(), "open_epoch should succeed for the protocol authority");
}

#[test]
fn open_epoch_fails_for_non_authority() {
    let mut h = setup(0);
    let intruder = Keypair::new();
    h.svm.airdrop(&intruder.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();
    let result = open_epoch(&mut h, &intruder, 1, 1_000_000);
    assert!(result.is_err(), "open_epoch must reject a non-authority signer");
}

#[test]
fn finalize_epoch_computes_correct_reward_amount() {
    let mut h = setup(2_000_000);
    let authority = Keypair::new_from_array(h.authority.to_bytes()[..32].try_into().unwrap());

    open_epoch(&mut h, &authority, 1, 1_000_000).unwrap();

    let router_owner = Keypair::new();
    let router = register_router(&mut h, &router_owner, "router-mumbai-001");

    // Architecture doc's worked example: budget 1,000,000, weight 4,500 out
    // of a 100,000 total network weight -> 45,000.
    finalize_epoch(
        &mut h,
        &authority,
        1,
        100_000,
        &[FinalizeInput { router, service_score: 8_500, reward_weight: 4_500 }],
    )
    .expect("finalize_epoch should succeed");

    let (reward_pk, _) = reward_pda(&router, 1);
    let reward_account = h.svm.get_account(&reward_pk).expect("reward account should exist");
    let reward: routerpulse::state::Reward =
        anchor_lang::AccountDeserialize::try_deserialize(&mut &reward_account.data[..]).unwrap();

    assert_eq!(reward.reward_amount, 45_000, "reward_amount must exactly match budget * weight / total_weight");
    assert_eq!(reward.reward_weight, 4_500);
    assert_eq!(reward.service_score, 8_500);
    assert!(!reward.claimed);
}

#[test]
fn finalize_epoch_cannot_be_called_twice() {
    let mut h = setup(2_000_000);
    let authority = Keypair::new_from_array(h.authority.to_bytes()[..32].try_into().unwrap());
    open_epoch(&mut h, &authority, 1, 1_000_000).unwrap();

    let router_owner = Keypair::new();
    let router = register_router(&mut h, &router_owner, "router-mumbai-002");

    finalize_epoch(
        &mut h,
        &authority,
        1,
        100_000,
        &[FinalizeInput { router, service_score: 9_000, reward_weight: 5_000 }],
    )
    .expect("first finalize_epoch should succeed");

    // Second finalize needs a distinct reward account (the first router's
    // Reward PDA already exists), so use a second router — the guard we're
    // testing is the *epoch's* finalized flag, not per-reward creation.
    let router_owner_2 = Keypair::new();
    let router_2 = register_router(&mut h, &router_owner_2, "router-mumbai-003");

    let result = finalize_epoch(
        &mut h,
        &authority,
        1,
        100_000,
        &[FinalizeInput { router: router_2, service_score: 9_000, reward_weight: 5_000 }],
    );
    assert!(result.is_err(), "finalize_epoch must reject a second call on an already-finalized epoch");
}

#[test]
fn claim_reward_transfers_correct_amount_and_sets_claimed() {
    let mut h = setup(2_000_000);
    let authority = Keypair::new_from_array(h.authority.to_bytes()[..32].try_into().unwrap());
    open_epoch(&mut h, &authority, 1, 1_000_000).unwrap();

    let router_owner = Keypair::new();
    let router = register_router(&mut h, &router_owner, "router-mumbai-004");

    finalize_epoch(
        &mut h,
        &authority,
        1,
        100_000,
        &[FinalizeInput { router, service_score: 8_500, reward_weight: 4_500 }],
    )
    .unwrap();

    claim_reward(&mut h, &router_owner, router, 1).expect("claim_reward should succeed");

    let operator_ata = anchor_spl_ata_address(&router_owner.pubkey(), &h.mint);
    let token_account: litesvm_token::spl_token::state::Account =
        get_spl_account(&h.svm, &operator_ata).unwrap();
    assert_eq!(token_account.amount, 45_000, "operator ATA must receive exactly reward_amount");

    let (reward_pk, _) = reward_pda(&router, 1);
    let reward_account = h.svm.get_account(&reward_pk).unwrap();
    let reward: routerpulse::state::Reward =
        anchor_lang::AccountDeserialize::try_deserialize(&mut &reward_account.data[..]).unwrap();
    assert!(reward.claimed, "claimed must be set to true after a successful claim");
}

#[test]
fn claim_reward_fails_on_double_claim() {
    let mut h = setup(2_000_000);
    let authority = Keypair::new_from_array(h.authority.to_bytes()[..32].try_into().unwrap());
    open_epoch(&mut h, &authority, 1, 1_000_000).unwrap();

    let router_owner = Keypair::new();
    let router = register_router(&mut h, &router_owner, "router-mumbai-005");

    finalize_epoch(
        &mut h,
        &authority,
        1,
        100_000,
        &[FinalizeInput { router, service_score: 8_500, reward_weight: 4_500 }],
    )
    .unwrap();

    claim_reward(&mut h, &router_owner, router, 1).expect("first claim should succeed");
    let second = claim_reward(&mut h, &router_owner, router, 1);
    assert!(second.is_err(), "a second claim_reward on the same Reward PDA must fail");
}

#[test]
fn claim_reward_fails_if_epoch_not_finalized() {
    let mut h = setup(2_000_000);
    let authority = Keypair::new_from_array(h.authority.to_bytes()[..32].try_into().unwrap());
    open_epoch(&mut h, &authority, 1, 1_000_000).unwrap();

    let router_owner = Keypair::new();
    let router = register_router(&mut h, &router_owner, "router-mumbai-006");

    // No finalize_epoch call — the Reward PDA doesn't even exist yet, so
    // this must fail (either at account-resolution or the finalized check,
    // depending on which the runtime hits first — both are correct
    // rejections of "claim before finalize").
    let result = claim_reward(&mut h, &router_owner, router, 1);
    assert!(result.is_err(), "claim_reward must fail before the epoch is finalized");
}
