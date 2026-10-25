#![no_std]
//! Trust Meridian · Circle
//!
//! A rotating savings circle (tontine) for a family spread across countries.
//! Every round each member pays the same amount in USDC; one member receives
//! the whole pot, and the turn rotates.
//!
//! Composed with the Stellar ecosystem:
//! - **DeFindex**: between collection and payout the pot is parked in a
//!   DeFindex vault, so it earns yield instead of sleeping.
//! - **XOXNO Lending**: each member's security deposit is supplied to XOXNO
//!   while the circle runs, and returned with its interest at the end.
//! - **Settle** (Trust Meridian): "one payout, three uses" pays the
//!   beneficiary, clears their Settle debts and pays a family bill (Cover
//!   escrow) in a single atomic transaction.
//!
//! Collection uses capped SEP-41 allowances: members approve this contract
//! once and `collect` pulls each instalment, so nobody has to chase anybody.
//! A payout always needs two different members to sign.

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, token,
    vec, Address, Env, IntoVal, String, Symbol, Val, Vec,
};
use xoxno_contract_sdk::lending::controller::HubAssetKey;
use xoxno_contract_sdk::{LendingAddresses, XoxnoLending};

const DAY: u32 = 17_280;
const TTL_BUMP: u32 = 60 * DAY;
const TTL_THRESHOLD: u32 = 30 * DAY;
pub const MAX_MEMBERS: u32 = 20;
/// Grace period after a round opens before the deposit can cover a missed
/// instalment.
pub const GRACE_SECS: u64 = 48 * 3600;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    NotMember = 2,
    AlreadyMember = 3,
    Full = 4,
    Closed = 5,
    BadAmount = 6,
    AlreadyPaid = 7,
    NotAllPaid = 8,
    SameSigner = 9,
    Finished = 10,
    NotAdmin = 11,
    GraceNotOver = 12,
    NoDeposit = 13,
    NotStarted = 14,
    PotTooSmall = 15,
    AdvanceTooLarge = 16,
    AlreadyAdvanced = 17,
    AlreadyReceived = 18,
    NoLending = 19,
}

/// XOXNO Lending deployment, spoke and market used for the deposits.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LendingConfig {
    pub addresses: LendingAddresses,
    pub spoke_id: u32,
    pub market: HubAssetKey,
}

/// Where the idle pot and the deposits earn yield. Both are optional so the
/// contract also runs where a partner protocol is unavailable.
pub struct YieldConfig {
    pub vault: Option<Address>,
    pub lending: Option<LendingConfig>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Circle {
    pub name: String,
    pub creator: Address,
    /// Instalment per member and per round, in token base units.
    pub amount: i128,
    /// Security deposit each member locks to join (0 = none).
    pub deposit: i128,
    pub members: Vec<Address>,
    pub max_members: u32,
    /// Open circles accept guests (the live "Hack the Meridian" circle).
    pub open: bool,
    pub started: bool,
    pub round: u32,
    pub paid: Vec<bool>,
    /// Pot held by this contract (not parked).
    pub pot: i128,
    /// DeFindex vault shares held for this circle.
    pub shares: i128,
    /// Principal each member locked as a deposit.
    pub deposits: Vec<i128>,
    /// XOXNO account holding this circle's deposits (0 = none yet).
    pub account: u64,
    pub round_start: u64,
    pub finished: bool,
    /// Rounds each member paid on time (trust stamps).
    pub stamps: Vec<u32>,
    /// Advance on a future payout borrowed from XOXNO against the deposits;
    /// repaid automatically from that member's pot.
    pub advances: Vec<i128>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Debt {
    pub to: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Admin,
    Token,
    Settle,
    Vault,
    Lending,
    NextId,
    Circle(u32),
}

#[contractclient(name = "SettleClient")]
pub trait SettleApi {
    fn pay(env: Env, id: u32, from: Address, to: Address, amount: i128);
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CircleCreated {
    #[topic]
    pub circle: u32,
    pub creator: Address,
    pub name: String,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemberJoined {
    #[topic]
    pub circle: u32,
    pub member: Address,
    pub deposit: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Contributed {
    #[topic]
    pub circle: u32,
    #[topic]
    pub member: Address,
    pub round: u32,
    pub amount: i128,
    /// "paid", "collected" or "deposit"
    pub how: Symbol,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PotParked {
    #[topic]
    pub circle: u32,
    pub amount: i128,
    pub shares: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaidOut {
    #[topic]
    pub circle: u32,
    #[topic]
    pub to: Address,
    pub round: u32,
    pub amount: i128,
    pub yield_earned: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComboPaid {
    #[topic]
    pub circle: u32,
    #[topic]
    pub to: Address,
    pub debts: i128,
    pub bill: i128,
    pub kept: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdvanceTaken {
    #[topic]
    pub circle: u32,
    #[topic]
    pub member: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdvanceRepaid {
    #[topic]
    pub circle: u32,
    #[topic]
    pub member: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DepositsReturned {
    #[topic]
    pub circle: u32,
    pub total: i128,
}

#[contract]
pub struct CircleContract;

fn load(env: &Env, id: u32) -> Result<Circle, Error> {
    let key = Key::Circle(id);
    let c: Circle = env.storage().persistent().get(&key).ok_or(Error::NotFound)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_BUMP);
    Ok(c)
}

fn save(env: &Env, id: u32, c: &Circle) {
    let key = Key::Circle(id);
    env.storage().persistent().set(&key, c);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_BUMP);
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_BUMP);
}

fn tok(env: &Env) -> token::Client<'_> {
    let a: Address = env.storage().instance().get(&Key::Token).unwrap();
    token::Client::new(env, &a)
}

fn ycfg(env: &Env) -> YieldConfig {
    YieldConfig {
        vault: env.storage().instance().get(&Key::Vault),
        lending: env.storage().instance().get(&Key::Lending),
    }
}

fn idx(c: &Circle, who: &Address) -> Result<u32, Error> {
    c.members.first_index_of(who).ok_or(Error::NotMember)
}

fn all_paid(c: &Circle) -> bool {
    c.paid.iter().all(|p| p)
}

/// Lets a nested call (vault or pool) move this contract's tokens.
fn authorize_transfer(env: &Env, token: &Address, to: &Address, amount: i128) {
    let me = env.current_contract_address();
    env.authorize_as_current_contract(vec![
        env,
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: token.clone(),
                fn_name: Symbol::new(env, "transfer"),
                args: (me, to.clone(), amount).into_val(env),
            },
            sub_invocations: vec![env],
        }),
    ]);
}

/// Parks `amount` of the pot in the DeFindex vault; returns shares minted.
fn vault_deposit(env: &Env, vault: &Address, amount: i128) -> i128 {
    let t = tok(env);
    let me = env.current_contract_address();
    let before: i128 = env.invoke_contract(vault, &Symbol::new(env, "balance"), vec![env, me.clone().into_val(env)]);
    authorize_transfer(env, &t.address, vault, amount);
    let args: Vec<Val> = vec![
        env,
        vec![env, amount].into_val(env),
        vec![env, 0i128].into_val(env),
        me.clone().into_val(env),
        true.into_val(env),
    ];
    let _: Val = env.invoke_contract(vault, &Symbol::new(env, "deposit"), args);
    let after: i128 = env.invoke_contract(vault, &Symbol::new(env, "balance"), vec![env, me.into_val(env)]);
    after - before
}

/// Burns `shares` and returns the tokens actually received.
fn vault_withdraw(env: &Env, vault: &Address, shares: i128) -> i128 {
    let t = tok(env);
    let me = env.current_contract_address();
    let before = t.balance(&me);
    let args: Vec<Val> = vec![
        env,
        shares.into_val(env),
        vec![env, 0i128].into_val(env),
        me.clone().into_val(env),
    ];
    let _: Val = env.invoke_contract(vault, &Symbol::new(env, "withdraw"), args);
    t.balance(&me) - before
}

fn lock_deposit(env: &Env, c: &mut Circle, i: u32, from: &Address) {
    if c.deposit <= 0 {
        return;
    }
    let t = tok(env);
    let me = env.current_contract_address();
    t.transfer(from, &me, &c.deposit);
    let y = ycfg(env);
    if let Some(l) = y.lending {
        if l.market.asset == t.address {
            let lending = XoxnoLending::new(env, &l.addresses);
            let stored = if c.account == 0 { None } else { Some(c.account) };
            let acc = lending.deposit(lending.resolve_account(stored), l.spoke_id, &l.market, c.deposit);
            c.account = acc;
        }
    }
    c.deposits.set(i, c.deposit);
}

/// Takes `amount` of deposits back into this contract (from XOXNO when they
/// are supplied there). Returns the tokens received.
fn unlock_deposits(env: &Env, c: &mut Circle, amount: i128, all: bool) -> i128 {
    let t = tok(env);
    let me = env.current_contract_address();
    if c.account == 0 {
        return amount;
    }
    let y = ycfg(env);
    let (addrs, market) = match y.lending {
        Some(l) => (l.addresses, l.market),
        None => return amount,
    };
    let lending = XoxnoLending::new(env, &addrs);
    let before = t.balance(&me);
    let w = if all {
        lending.withdraw_all(c.account, &market)
    } else {
        lending.withdraw(c.account, &market, amount)
    };
    if w.account_closed {
        c.account = 0;
    }
    t.balance(&me) - before
}

/// Moves the round's pot back from the vault, pays it out and opens the next
/// round. Returns (beneficiary, amount, yield earned).
fn do_payout(env: &Env, id: u32, c: &mut Circle, a: &Address, b: &Address) -> Result<(Address, i128, i128), Error> {
    if c.finished {
        return Err(Error::Finished);
    }
    if a == b {
        return Err(Error::SameSigner);
    }
    idx(c, a)?;
    idx(c, b)?;
    a.require_auth();
    b.require_auth();
    if !all_paid(c) {
        return Err(Error::NotAllPaid);
    }
    let base = c.amount * c.members.len() as i128;
    let mut pot = c.pot;
    if c.shares > 0 {
        if let Some(v) = ycfg(env).vault {
            pot += vault_withdraw(env, &v, c.shares);
        }
        c.shares = 0;
    }
    let earned = if pot > base { pot - base } else { 0 };
    let n = c.members.len();
    let bi = c.round % n;
    let to = c.members.get(bi).unwrap();
    let adv = c.advances.get(bi).unwrap();
    if adv > 0 {
        let spent = repay_advance(env, c, bi, adv);
        pot -= spent;
        c.advances.set(bi, 0);
        AdvanceRepaid { circle: id, member: to.clone(), amount: spent }.publish(env);
    }
    let me = env.current_contract_address();
    tok(env).transfer(&me, &to, &pot);
    c.pot = 0;
    PaidOut {
        circle: id,
        to: to.clone(),
        round: c.round,
        amount: pot,
        yield_earned: earned,
    }
    .publish(env);
    c.round += 1;
    c.round_start = env.ledger().timestamp();
    for i in 0..n {
        c.paid.set(i, false);
    }
    if c.round >= n {
        c.finished = true;
        return_deposits(env, id, c);
    }
    Ok((to, pot, earned))
}

/// Repays one member's advance (principal plus its share of the interest)
/// from the pot. Returns the tokens spent.
fn repay_advance(env: &Env, c: &Circle, i: u32, adv: i128) -> i128 {
    let l = match ycfg(env).lending {
        Some(l) => l,
        None => return 0,
    };
    let lending = XoxnoLending::new(env, &l.addresses);
    let total_debt = lending.debt(c.account, &l.market);
    let total_adv: i128 = c.advances.iter().sum();
    let due = if total_adv == adv { total_debt } else { total_debt * adv / total_adv + 1 };
    let _ = i;
    lending.repay(c.account, &l.market, due)
}

fn return_deposits(env: &Env, id: u32, c: &mut Circle) {
    let total: i128 = c.deposits.iter().sum();
    if total <= 0 {
        return;
    }
    let got = unlock_deposits(env, c, total, true);
    let t = tok(env);
    let me = env.current_contract_address();
    let mut sent = 0i128;
    let n = c.members.len();
    for i in 0..n {
        let d = c.deposits.get(i).unwrap();
        if d <= 0 {
            continue;
        }
        // Principal plus a pro-rata share of the interest; the last member
        // with a deposit takes the rounding remainder.
        let mut share = got * d / total;
        let last = (i + 1..n).all(|j| c.deposits.get(j).unwrap() <= 0);
        if last {
            share = got - sent;
        }
        if share > 0 {
            t.transfer(&me, &c.members.get(i).unwrap(), &share);
        }
        sent += share;
        c.deposits.set(i, 0);
    }
    DepositsReturned { circle: id, total: got }.publish(env);
}

#[contractimpl]
impl CircleContract {
    pub fn __constructor(env: Env, admin: Address, token: Address, settle: Address) {
        env.storage().instance().set(&Key::Admin, &admin);
        env.storage().instance().set(&Key::Token, &token);
        env.storage().instance().set(&Key::Settle, &settle);
        env.storage().instance().set(&Key::NextId, &0u32);
    }

    /// Points idle pots at a DeFindex vault (None turns it off).
    pub fn set_vault(env: Env, vault: Option<Address>) {
        let admin: Address = env.storage().instance().get(&Key::Admin).unwrap();
        admin.require_auth();
        match vault {
            Some(v) => env.storage().instance().set(&Key::Vault, &v),
            None => env.storage().instance().remove(&Key::Vault),
        }
    }

    /// Sends deposits to an XOXNO Lending market (None turns it off).
    pub fn set_lending(env: Env, cfg: Option<LendingConfig>) {
        let admin: Address = env.storage().instance().get(&Key::Admin).unwrap();
        admin.require_auth();
        match cfg {
            Some(c) => env.storage().instance().set(&Key::Lending, &c),
            None => env.storage().instance().remove(&Key::Lending),
        }
    }

    pub fn vault(env: Env) -> Option<Address> {
        ycfg(&env).vault
    }

    pub fn token(env: Env) -> Address {
        tok(&env).address
    }

    pub fn create(
        env: Env,
        creator: Address,
        name: String,
        amount: i128,
        deposit: i128,
        members: Vec<Address>,
        max_members: u32,
        open: bool,
    ) -> Result<u32, Error> {
        creator.require_auth();
        if amount <= 0 || deposit < 0 {
            return Err(Error::BadAmount);
        }
        let mut list = Vec::new(&env);
        list.push_back(creator.clone());
        for m in members.iter() {
            if !list.contains(&m) {
                list.push_back(m);
            }
        }
        let max = if max_members == 0 || max_members > MAX_MEMBERS { MAX_MEMBERS } else { max_members };
        if list.len() > max {
            return Err(Error::Full);
        }
        let n = list.len();
        let mut c = Circle {
            name: name.clone(),
            creator: creator.clone(),
            amount,
            deposit,
            members: list,
            max_members: max,
            open,
            started: false,
            round: 0,
            paid: Vec::new(&env),
            pot: 0,
            shares: 0,
            deposits: Vec::new(&env),
            account: 0,
            round_start: env.ledger().timestamp(),
            finished: false,
            stamps: Vec::new(&env),
            advances: Vec::new(&env),
        };
        for _ in 0..n {
            c.paid.push_back(false);
            c.deposits.push_back(0);
            c.stamps.push_back(0);
            c.advances.push_back(0);
        }
        let id: u32 = env.storage().instance().get(&Key::NextId).unwrap_or(0);
        env.storage().instance().set(&Key::NextId, &(id + 1));
        lock_deposit(&env, &mut c, 0, &creator);
        save(&env, id, &c);
        CircleCreated { circle: id, creator, name, amount }.publish(&env);
        Ok(id)
    }

    /// An invited member locks their deposit (if any), or a guest joins an
    /// open circle before it starts.
    pub fn join(env: Env, id: u32, member: Address) -> Result<(), Error> {
        member.require_auth();
        let mut c = load(&env, id)?;
        if c.finished {
            return Err(Error::Finished);
        }
        let i = match c.members.first_index_of(&member) {
            Some(i) => {
                if c.deposit <= 0 || c.deposits.get(i).unwrap() > 0 {
                    return Err(Error::AlreadyMember);
                }
                i
            }
            None => {
                if !c.open || c.started {
                    return Err(Error::Closed);
                }
                if c.members.len() >= c.max_members {
                    return Err(Error::Full);
                }
                c.members.push_back(member.clone());
                c.paid.push_back(false);
                c.deposits.push_back(0);
                c.stamps.push_back(0);
                c.advances.push_back(0);
                c.members.len() - 1
            }
        };
        lock_deposit(&env, &mut c, i, &member);
        save(&env, id, &c);
        MemberJoined { circle: id, member, deposit: c.deposit }.publish(&env);
        Ok(())
    }

    /// A member pays this round's instalment.
    pub fn pay(env: Env, id: u32, member: Address) -> Result<(), Error> {
        member.require_auth();
        let mut c = load(&env, id)?;
        if c.finished {
            return Err(Error::Finished);
        }
        let i = idx(&c, &member)?;
        if c.paid.get(i).unwrap() {
            return Err(Error::AlreadyPaid);
        }
        tok(&env).transfer(&member, &env.current_contract_address(), &c.amount);
        c.paid.set(i, true);
        c.pot += c.amount;
        c.started = true;
        c.stamps.set(i, c.stamps.get(i).unwrap() + 1);
        save(&env, id, &c);
        Contributed { circle: id, member, round: c.round, amount: c.amount, how: Symbol::new(&env, "paid") }.publish(&env);
        Ok(())
    }

    /// Pulls every unpaid instalment from the members' allowances. Anyone can
    /// call it (the relayer does). Members without enough allowance are
    /// skipped. Returns how many instalments were collected.
    pub fn collect(env: Env, id: u32) -> Result<u32, Error> {
        let mut c = load(&env, id)?;
        if c.finished {
            return Err(Error::Finished);
        }
        let t = tok(&env);
        let me = env.current_contract_address();
        let mut got = 0u32;
        for i in 0..c.members.len() {
            if c.paid.get(i).unwrap() {
                continue;
            }
            let m = c.members.get(i).unwrap();
            if t.allowance(&m, &me) < c.amount || t.balance(&m) < c.amount {
                continue;
            }
            t.transfer_from(&me, &m, &me, &c.amount);
            c.paid.set(i, true);
            c.pot += c.amount;
            c.stamps.set(i, c.stamps.get(i).unwrap() + 1);
            got += 1;
            Contributed { circle: id, member: m, round: c.round, amount: c.amount, how: Symbol::new(&env, "collected") }.publish(&env);
        }
        if got > 0 {
            c.started = true;
        }
        save(&env, id, &c);
        Ok(got)
    }

    /// After the 48 h grace period, a missed instalment is taken from the
    /// late member's deposit so the beneficiary still gets the full pot.
    pub fn cover_late(env: Env, id: u32, member: Address) -> Result<(), Error> {
        let mut c = load(&env, id)?;
        let i = idx(&c, &member)?;
        if c.paid.get(i).unwrap() {
            return Err(Error::AlreadyPaid);
        }
        if env.ledger().timestamp() < c.round_start + GRACE_SECS {
            return Err(Error::GraceNotOver);
        }
        let d = c.deposits.get(i).unwrap();
        if d < c.amount {
            return Err(Error::NoDeposit);
        }
        let amt = c.amount;
        let got = unlock_deposits(&env, &mut c, amt, false);
        c.deposits.set(i, d - c.amount);
        c.paid.set(i, true);
        c.pot += got;
        save(&env, id, &c);
        Contributed { circle: id, member, round: c.round, amount: got, how: Symbol::new(&env, "deposit") }.publish(&env);
        Ok(())
    }

    /// Parks the collected pot in the DeFindex vault until payout.
    pub fn park(env: Env, id: u32, member: Address) -> Result<i128, Error> {
        member.require_auth();
        let mut c = load(&env, id)?;
        idx(&c, &member)?;
        let vault = ycfg(&env).vault.ok_or(Error::NotStarted)?;
        if c.pot <= 0 {
            return Err(Error::PotTooSmall);
        }
        let amount = c.pot;
        let shares = vault_deposit(&env, &vault, amount);
        c.pot = 0;
        c.shares += shares;
        save(&env, id, &c);
        PotParked { circle: id, amount, shares }.publish(&env);
        Ok(shares)
    }

    /// Pays the whole pot to this round's beneficiary. Two different members
    /// must sign.
    pub fn payout(env: Env, id: u32, signer_a: Address, signer_b: Address) -> Result<i128, Error> {
        let mut c = load(&env, id)?;
        let (_, amount, _) = do_payout(&env, id, &mut c, &signer_a, &signer_b)?;
        save(&env, id, &c);
        Ok(amount)
    }

    /// "One payout, three uses": the beneficiary receives the pot, then in the
    /// same transaction clears their debts in a Settle group and pays a family
    /// bill (a Cover escrow). All or nothing.
    pub fn payout_combo(
        env: Env,
        id: u32,
        signer_a: Address,
        signer_b: Address,
        group: u32,
        debts: Vec<Debt>,
        bill_to: Option<Address>,
        bill_amount: i128,
    ) -> Result<i128, Error> {
        let mut c = load(&env, id)?;
        let (to, amount, _) = do_payout(&env, id, &mut c, &signer_a, &signer_b)?;
        save(&env, id, &c);
        if to != signer_a && to != signer_b {
            to.require_auth();
        }
        let mut used = 0i128;
        if !debts.is_empty() {
            let settle: Address = env.storage().instance().get(&Key::Settle).unwrap();
            let sc = SettleClient::new(&env, &settle);
            for d in debts.iter() {
                if d.amount <= 0 {
                    return Err(Error::BadAmount);
                }
                sc.pay(&group, &to, &d.to, &d.amount);
                used += d.amount;
            }
        }
        let mut bill = 0i128;
        if let Some(dest) = bill_to {
            if bill_amount <= 0 {
                return Err(Error::BadAmount);
            }
            tok(&env).transfer(&to, &dest, &bill_amount);
            bill = bill_amount;
        }
        if used + bill > amount {
            return Err(Error::PotTooSmall);
        }
        ComboPaid { circle: id, to, debts: used, bill, kept: amount - used - bill }.publish(&env);
        Ok(amount - used - bill)
    }

    /// An advance on your future payout: borrowed from XOXNO against the
    /// circle's deposits (up to half of your own deposit) and repaid
    /// automatically from your pot when your turn comes.
    pub fn advance(env: Env, id: u32, member: Address, amount: i128) -> Result<(), Error> {
        member.require_auth();
        let mut c = load(&env, id)?;
        if c.finished {
            return Err(Error::Finished);
        }
        let i = idx(&c, &member)?;
        if i < c.round {
            return Err(Error::AlreadyReceived);
        }
        if c.advances.get(i).unwrap() > 0 {
            return Err(Error::AlreadyAdvanced);
        }
        if amount <= 0 || amount * 2 > c.deposits.get(i).unwrap() {
            return Err(Error::AdvanceTooLarge);
        }
        let l = ycfg(&env).lending.ok_or(Error::NoLending)?;
        if c.account == 0 {
            return Err(Error::NoDeposit);
        }
        let t = tok(&env);
        let me = env.current_contract_address();
        let before = t.balance(&me);
        XoxnoLending::new(&env, &l.addresses).borrow(c.account, &l.market, amount);
        let got = t.balance(&me) - before;
        t.transfer(&me, &member, &got);
        c.advances.set(i, got);
        save(&env, id, &c);
        AdvanceTaken { circle: id, member, amount: got }.publish(&env);
        Ok(())
    }

    pub fn get_circle(env: Env, id: u32) -> Result<Circle, Error> {
        load(&env, id)
    }

    pub fn count(env: Env) -> u32 {
        env.storage().instance().get(&Key::NextId).unwrap_or(0)
    }

    /// Who receives the pot this round.
    pub fn beneficiary(env: Env, id: u32) -> Result<Address, Error> {
        let c = load(&env, id)?;
        Ok(c.members.get(c.round % c.members.len()).unwrap())
    }
}

#[cfg(test)]
mod test;
