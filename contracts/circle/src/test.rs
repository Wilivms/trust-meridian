#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl, testutils::Address as _, testutils::Ledger as _, token, vec, Address,
    Env, String,
};
use xoxno_contract_sdk::testutils::{LendingFixture, MarketConfig};

const U: i128 = 10_000_000;

/// Minimal DeFindex-like vault: one asset, shares 1:1, plus a `bonus` the
/// test can add to simulate strategy yield.
#[contract]
pub struct MockVault;

#[contracttype]
enum VK {
    Asset,
    Shares(Address),
    Total,
}

#[contractimpl]
impl MockVault {
    pub fn __constructor(env: Env, asset: Address) {
        env.storage().instance().set(&VK::Asset, &asset);
    }
    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().instance().get(&VK::Shares(id)).unwrap_or(0)
    }
    pub fn deposit(env: Env, amounts_desired: Vec<i128>, _min: Vec<i128>, from: Address, _invest: bool) -> (Vec<i128>, i128) {
        from.require_auth();
        let asset: Address = env.storage().instance().get(&VK::Asset).unwrap();
        let a = amounts_desired.get(0).unwrap();
        token::Client::new(&env, &asset).transfer(&from, &env.current_contract_address(), &a);
        let s: i128 = env.storage().instance().get(&VK::Shares(from.clone())).unwrap_or(0);
        env.storage().instance().set(&VK::Shares(from), &(s + a));
        let t: i128 = env.storage().instance().get(&VK::Total).unwrap_or(0);
        env.storage().instance().set(&VK::Total, &(t + a));
        (amounts_desired, a)
    }
    pub fn withdraw(env: Env, df_amount: i128, _min: Vec<i128>, from: Address) -> Vec<i128> {
        from.require_auth();
        let asset: Address = env.storage().instance().get(&VK::Asset).unwrap();
        let tk = token::Client::new(&env, &asset);
        let me = env.current_contract_address();
        let total: i128 = env.storage().instance().get(&VK::Total).unwrap();
        let out = tk.balance(&me) * df_amount / total;
        let s: i128 = env.storage().instance().get(&VK::Shares(from.clone())).unwrap_or(0);
        env.storage().instance().set(&VK::Shares(from.clone()), &(s - df_amount));
        env.storage().instance().set(&VK::Total, &(total - df_amount));
        tk.transfer(&me, &from, &out);
        vec![&env, out]
    }
}

struct T<'a> {
    env: Env,
    circle: CircleContractClient<'a>,
    cid: Address,
    settle: tm_settle::SettleClient<'a>,
    tk: token::Client<'a>,
    sac: token::StellarAssetClient<'a>,
    tka: Address,
    m: std::vec::Vec<Address>,
    fx: LendingFixture<'a>,
    market: HubAssetKey,
}

fn setup<'a>() -> T<'a> {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let fx = LendingFixture::deploy(&env, &admin);
    let mk = fx.create_market(&MarketConfig::usdc());
    let tk_addr = mk.token.address.clone();
    let settle_id = env.register(tm_settle::Settle, (tk_addr.clone(),));
    let cid = env.register(CircleContract, (admin.clone(), tk_addr.clone(), settle_id.clone()));
    let circle = CircleContractClient::new(&env, &cid);
    let m: std::vec::Vec<Address> = (0..4).map(|_| Address::generate(&env)).collect();
    for a in &m {
        mk.sac.mint(a, &(10_000 * U));
    }
    let market = mk.key.clone();
    T {
        circle,
        cid,
        settle: tm_settle::SettleClient::new(&env, &settle_id),
        tk: token::Client::new(&env, &tk_addr),
        sac: token::StellarAssetClient::new(&env, &tk_addr),
        tka: tk_addr.clone(),
        m,
        fx,
        market,
        env,
    }
}

fn members(t: &T) -> Vec<Address> {
    vec![&t.env, t.m[1].clone(), t.m[2].clone(), t.m[3].clone()]
}

#[test]
fn rounds_rotate_and_pay_the_whole_pot() {
    let t = setup();
    let e = &t.env;
    let id = t.circle.create(&t.m[0], &String::from_str(e, "Paris–Lagos savers"), &(100 * U), &0, &members(&t), &0, &false);
    for r in 0..4u32 {
        for a in &t.m {
            t.circle.pay(&id, a);
        }
        let before = t.tk.balance(&t.m[r as usize]);
        let got = t.circle.payout(&id, &t.m[(r as usize + 1) % 4], &t.m[(r as usize + 2) % 4]);
        assert_eq!(got, 400 * U);
        assert_eq!(t.tk.balance(&t.m[r as usize]), before + 400 * U);
    }
    let c = t.circle.get_circle(&id);
    assert!(c.finished);
    assert_eq!(c.stamps.get(0).unwrap(), 4);
}

#[test]
fn payout_needs_everyone_paid_and_two_distinct_signers() {
    let t = setup();
    let e = &t.env;
    let id = t.circle.create(&t.m[0], &String::from_str(e, "c"), &(10 * U), &0, &members(&t), &0, &false);
    t.circle.pay(&id, &t.m[0]);
    assert_eq!(t.circle.try_payout(&id, &t.m[1], &t.m[2]), Err(Ok(Error::NotAllPaid)));
    for a in &t.m[1..] {
        t.circle.pay(&id, a);
    }
    assert_eq!(t.circle.try_payout(&id, &t.m[1], &t.m[1]), Err(Ok(Error::SameSigner)));
    let outsider = Address::generate(e);
    assert_eq!(t.circle.try_payout(&id, &t.m[1], &outsider), Err(Ok(Error::NotMember)));
}

#[test]
fn collect_pulls_from_allowances_and_skips_the_rest() {
    let t = setup();
    let e = &t.env;
    let id = t.circle.create(&t.m[0], &String::from_str(e, "c"), &(50 * U), &0, &members(&t), &0, &false);
    let exp = e.ledger().sequence() + 10_000;
    for a in &t.m[0..3] {
        t.tk.approve(a, &t.cid, &(200 * U), &exp);
    }
    assert_eq!(t.circle.collect(&id), 3);
    let c = t.circle.get_circle(&id);
    assert_eq!(c.pot, 150 * U);
    assert!(!c.paid.get(3).unwrap());
}

#[test]
fn idle_pot_earns_in_the_vault() {
    let t = setup();
    let e = &t.env;
    let vault = e.register(MockVault, (t.tka.clone(),));
    t.circle.set_vault(&Some(vault.clone()));
    let id = t.circle.create(&t.m[0], &String::from_str(e, "c"), &(100 * U), &0, &members(&t), &0, &false);
    for a in &t.m {
        t.circle.pay(&id, a);
    }
    t.circle.park(&id, &t.m[1]);
    assert_eq!(t.tk.balance(&vault), 400 * U);
    t.sac.mint(&vault, &(2 * U)); // strategy yield
    let before = t.tk.balance(&t.m[0]);
    let got = t.circle.payout(&id, &t.m[1], &t.m[2]);
    assert_eq!(got, 402 * U);
    assert_eq!(t.tk.balance(&t.m[0]), before + 402 * U);
}

#[test]
fn deposits_go_to_xoxno_and_cover_a_late_member() {
    let t = setup();
    let e = &t.env;
    t.circle.set_lending(&Some(LendingConfig {
        addresses: t.fx.addresses(),
        spoke_id: t.fx.spoke_id,
        market: t.market.clone(),
    }));
    let id = t.circle.create(&t.m[0], &String::from_str(e, "c"), &(100 * U), &(100 * U), &members(&t), &0, &false);
    for a in &t.m[1..] {
        t.circle.join(&id, a);
    }
    let c = t.circle.get_circle(&id);
    assert!(c.account != 0);
    // The contract holds no idle deposit: it sits in XOXNO.
    assert_eq!(t.tk.balance(&t.cid), 0);
    for a in &t.m[0..3] {
        t.circle.pay(&id, a);
    }
    assert_eq!(t.circle.try_cover_late(&id, &t.m[3]), Err(Ok(Error::GraceNotOver)));
    e.ledger().with_mut(|l| l.timestamp += GRACE_SECS + 1);
    t.circle.cover_late(&id, &t.m[3]);
    let got = t.circle.payout(&id, &t.m[1], &t.m[2]);
    assert!(got >= 400 * U - 2);
    assert_eq!(t.circle.get_circle(&id).deposits.get(3).unwrap(), 0);
}

#[test]
fn guests_join_the_open_live_circle() {
    let t = setup();
    let e = &t.env;
    let id = t.circle.create(&t.m[0], &String::from_str(e, "Hack the Meridian"), &U, &0, &vec![e], &15, &true);
    for a in &t.m[1..] {
        t.circle.join(&id, a);
    }
    assert_eq!(t.circle.get_circle(&id).members.len(), 4);
    t.circle.pay(&id, &t.m[0]);
    let late = Address::generate(e);
    assert_eq!(t.circle.try_join(&id, &late), Err(Ok(Error::Closed)));
}

#[test]
fn one_payout_three_uses_is_atomic() {
    let t = setup();
    let e = &t.env;
    // Settle: m1 paid 120 for m0 and m1 → m0 owes m1 60.
    let gid = t.settle.create_group(&t.m[0], &String::from_str(e, "Lisbon weekend"), &vec![e, t.m[1].clone()], &false);
    t.settle.add_expense(&gid, &t.m[1], &(120 * U), &vec![e, t.m[0].clone(), t.m[1].clone()], &String::from_str(e, "Fado"));
    let id = t.circle.create(&t.m[0], &String::from_str(e, "c"), &(100 * U), &0, &members(&t), &0, &false);
    for a in &t.m {
        t.circle.pay(&id, a);
    }
    let escrow = Address::generate(e);
    let m0 = t.tk.balance(&t.m[0]);
    let m1 = t.tk.balance(&t.m[1]);
    let kept = t.circle.payout_combo(
        &id, &t.m[1], &t.m[2], &gid,
        &vec![e, Debt { to: t.m[1].clone(), amount: 60 * U }],
        &Some(escrow.clone()), &(48 * U),
    );
    assert_eq!(kept, 292 * U);
    assert_eq!(t.tk.balance(&t.m[0]), m0 + 292 * U);
    assert_eq!(t.tk.balance(&t.m[1]), m1 + 60 * U);
    assert_eq!(t.tk.balance(&escrow), 48 * U);
    assert!(t.settle.debts(&gid).is_empty());
}

#[test]
fn advance_on_a_future_turn_is_repaid_from_that_pot() {
    let t = setup();
    let e = &t.env;
    t.circle.set_lending(&Some(LendingConfig {
        addresses: t.fx.addresses(),
        spoke_id: t.fx.spoke_id,
        market: t.market.clone(),
    }));
    let id = t.circle.create(&t.m[0], &String::from_str(e, "c"), &(100 * U), &(100 * U), &members(&t), &0, &false);
    for a in &t.m[1..] {
        t.circle.join(&id, a);
    }
    // m2 receives in round 2 but needs 40 now.
    assert_eq!(t.circle.try_advance(&id, &t.m[2], &(60 * U)), Err(Ok(Error::AdvanceTooLarge)));
    let b = t.tk.balance(&t.m[2]);
    t.circle.advance(&id, &t.m[2], &(40 * U));
    assert_eq!(t.tk.balance(&t.m[2]), b + 40 * U);
    for r in 0..3u32 {
        for a in &t.m {
            t.circle.pay(&id, a);
        }
        let got = t.circle.payout(&id, &t.m[(r as usize + 1) % 4], &t.m[(r as usize + 3) % 4]);
        if r == 2 {
            // pot minus the advance and a little interest
            assert!(got < 360 * U + 1 && got > 359 * U);
        }
    }
    assert_eq!(t.circle.get_circle(&id).advances.get(2).unwrap(), 0);
    for a in &t.m {
        t.circle.pay(&id, a);
    }
    t.circle.payout(&id, &t.m[1], &t.m[2]);
    assert!(t.circle.get_circle(&id).finished);
}
