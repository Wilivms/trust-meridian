#![no_std]
//! Trust Meridian · DeFindex strategy backed by XOXNO Lending
//!
//! A DeFindex strategy (same interface as the official ones: `asset`,
//! `deposit`, `withdraw`, `balance`, `harvest`) that supplies the vault's
//! USDC to an XOXNO Lending market. The Circle's idle pot goes into a
//! DeFindex vault, and this strategy makes that vault earn XOXNO's supply
//! rate. Depositors (normally one vault) own shares of a single XOXNO account
//! held by this contract; interest accrues to the shares.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Bytes,
    Env, IntoVal, Val, Vec,
};
use xoxno_contract_sdk::lending::controller::HubAssetKey;
use xoxno_contract_sdk::{LendingAddresses, XoxnoLending};

const DAY: u32 = 17_280;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum StrategyError {
    NotInitialized = 401,
    NegativeNotAllowed = 410,
    InvalidArgument = 411,
    InsufficientBalance = 412,
    OnlyPositiveAmountAllowed = 417,
}

#[contracttype]
#[derive(Clone)]
struct Config {
    asset: Address,
    lending: LendingAddresses,
    spoke_id: u32,
    market: HubAssetKey,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Config,
    Account,
    TotalShares,
    Shares(Address),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StrategyMoved {
    #[topic]
    pub from: Address,
    pub deposited: i128,
    pub withdrawn: i128,
    pub balance: i128,
}

#[contract]
pub struct XoxnoStrategy;

fn cfg(e: &Env) -> Config {
    e.storage().instance().extend_ttl(DAY, 8 * DAY);
    e.storage().instance().get(&Key::Config).unwrap()
}
fn account(e: &Env) -> u64 {
    e.storage().instance().get(&Key::Account).unwrap_or(0)
}
fn total_shares(e: &Env) -> i128 {
    e.storage().instance().get(&Key::TotalShares).unwrap_or(0)
}
fn shares_of(e: &Env, who: &Address) -> i128 {
    e.storage().persistent().get(&Key::Shares(who.clone())).unwrap_or(0)
}
fn set_shares(e: &Env, who: &Address, v: i128) {
    let k = Key::Shares(who.clone());
    e.storage().persistent().set(&k, &v);
    e.storage().persistent().extend_ttl(&k, DAY, 8 * DAY);
}
/// Underlying value of the whole XOXNO position.
fn total_value(e: &Env, c: &Config) -> i128 {
    let acc = account(e);
    if acc == 0 {
        return 0;
    }
    XoxnoLending::new(e, &c.lending).collateral(acc, &c.market)
}
fn value_of(e: &Env, c: &Config, who: &Address) -> i128 {
    let ts = total_shares(e);
    if ts == 0 {
        return 0;
    }
    shares_of(e, who) * total_value(e, c) / ts
}

#[contractimpl]
impl XoxnoStrategy {
    /// `init_args`: [controller, pool, position_nft, spoke_id: u32, hub_id: u32]
    pub fn __constructor(e: Env, asset: Address, init_args: Vec<Val>) {
        let a = |i: u32| -> Val { init_args.get(i).unwrap() };
        let lending = LendingAddresses {
            controller: a(0).into_val(&e),
            pool: a(1).into_val(&e),
            position_nft: a(2).into_val(&e),
        };
        let spoke_id: u32 = a(3).into_val(&e);
        let hub_id: u32 = a(4).into_val(&e);
        let market = HubAssetKey { asset: asset.clone(), hub_id };
        e.storage().instance().set(&Key::Config, &Config { asset, lending, spoke_id, market });
    }

    pub fn asset(e: Env) -> Result<Address, StrategyError> {
        Ok(cfg(&e).asset)
    }

    pub fn deposit(e: Env, amount: i128, from: Address) -> Result<i128, StrategyError> {
        if amount <= 0 {
            return Err(StrategyError::OnlyPositiveAmountAllowed);
        }
        from.require_auth();
        let c = cfg(&e);
        let me = e.current_contract_address();
        let before_value = total_value(&e, &c);
        let ts = total_shares(&e);
        token::Client::new(&e, &c.asset).transfer(&from, &me, &amount);
        let lending = XoxnoLending::new(&e, &c.lending);
        let stored = if account(&e) == 0 { None } else { Some(account(&e)) };
        let acc = lending.deposit(lending.resolve_account(stored), c.spoke_id, &c.market, amount);
        e.storage().instance().set(&Key::Account, &acc);
        let minted = if ts == 0 || before_value == 0 { amount } else { amount * ts / before_value };
        set_shares(&e, &from, shares_of(&e, &from) + minted);
        e.storage().instance().set(&Key::TotalShares, &(ts + minted));
        let bal = value_of(&e, &c, &from);
        StrategyMoved { from: from.clone(), deposited: amount, withdrawn: 0, balance: bal }.publish(&e);
        Ok(bal)
    }

    /// Interest accrues inside the XOXNO position; nothing to claim.
    pub fn harvest(e: Env, _from: Address, _data: Option<Bytes>) -> Result<(), StrategyError> {
        cfg(&e);
        Ok(())
    }

    pub fn balance(e: Env, from: Address) -> Result<i128, StrategyError> {
        let c = cfg(&e);
        Ok(value_of(&e, &c, &from))
    }

    pub fn withdraw(e: Env, amount: i128, from: Address, to: Address) -> Result<i128, StrategyError> {
        if amount <= 0 {
            return Err(StrategyError::OnlyPositiveAmountAllowed);
        }
        from.require_auth();
        let c = cfg(&e);
        let mine = value_of(&e, &c, &from);
        if amount > mine {
            return Err(StrategyError::InsufficientBalance);
        }
        let tv = total_value(&e, &c);
        let ts = total_shares(&e);
        let mut burn = (amount * ts + tv - 1) / tv;
        let have = shares_of(&e, &from);
        if burn > have {
            burn = have;
        }
        let me = e.current_contract_address();
        let t = token::Client::new(&e, &c.asset);
        let before = t.balance(&me);
        let lending = XoxnoLending::new(&e, &c.lending);
        let w = if burn == ts { lending.withdraw_all(account(&e), &c.market) } else { lending.withdraw(account(&e), &c.market, amount) };
        if w.account_closed {
            e.storage().instance().set(&Key::Account, &0u64);
        }
        let got = t.balance(&me) - before;
        t.transfer(&me, &to, &got);
        set_shares(&e, &from, have - burn);
        e.storage().instance().set(&Key::TotalShares, &(ts - burn));
        let bal = value_of(&e, &c, &from);
        StrategyMoved { from, deposited: 0, withdrawn: got, balance: bal }.publish(&e);
        Ok(bal)
    }
}

#[cfg(test)]
mod test {
    extern crate std;
    use super::*;
    use soroban_sdk::{testutils::Address as _, vec, Env};
    use xoxno_contract_sdk::testutils::{LendingFixture, MarketConfig};

    #[test]
    fn vault_deposits_earn_on_xoxno_and_withdraw() {
        let e = Env::default();
        e.mock_all_auths();
        let fx = LendingFixture::deploy(&e, &Address::generate(&e));
        let m = fx.create_market(&MarketConfig::usdc());
        let a = fx.addresses();
        let args: Vec<Val> = vec![&e, a.controller.into_val(&e), a.pool.into_val(&e), a.position_nft.into_val(&e), fx.spoke_id.into_val(&e), m.key.hub_id.into_val(&e)];
        let id = e.register(XoxnoStrategy, (m.key.asset.clone(), args));
        let s = XoxnoStrategyClient::new(&e, &id);
        let vault = Address::generate(&e);
        m.sac.mint(&vault, &(1_000 * 10_000_000));
        assert_eq!(s.asset(), m.key.asset);
        let bal = s.deposit(&(100 * 10_000_000), &vault);
        assert!(bal >= 100 * 10_000_000 - 2);
        let after = s.withdraw(&(40 * 10_000_000), &vault, &vault);
        assert!(after >= 60 * 10_000_000 - 2);
        assert!(m.token.balance(&vault) >= 940 * 10_000_000 - 2);
    }
}
