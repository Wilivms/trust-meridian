#![no_std]
//! Trust Meridian · Settle
//!
//! Shared expenses for a group spread across countries. Balances are kept in
//! one settlement token (USDC). Anyone in the group adds an expense; when half
//! of the group approves, the contract pays every debt in one transaction with
//! `transfer_from`, using the capped allowances members granted beforehand.
//! Either everyone is settled, or nobody is.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env,
    Map, String, Vec,
};

const DAY: u32 = 17_280;
const TTL_BUMP: u32 = 60 * DAY;
const TTL_THRESHOLD: u32 = 30 * DAY;
pub const MAX_MEMBERS: u32 = 20;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    NotMember = 2,
    AlreadyMember = 3,
    GroupFull = 4,
    Closed = 5,
    BadAmount = 6,
    NothingToSettle = 7,
    AlreadyApproved = 8,
    EmptyParticipants = 9,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Group {
    pub name: String,
    pub creator: Address,
    pub members: Vec<Address>,
    /// Net position per member: positive means the group owes them.
    pub balances: Map<Address, i128>,
    /// Members who approved the current settlement proposal.
    pub approvals: Vec<Address>,
    /// Bumps every time balances change, which voids pending approvals.
    pub epoch: u32,
    pub expenses: u32,
    /// Guests may join without an invitation (live demo groups).
    pub open: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Transfer {
    pub from: Address,
    pub to: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Token,
    NextId,
    Group(u32),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GroupCreated {
    #[topic]
    pub group: u32,
    pub creator: Address,
    pub name: String,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExpenseAdded {
    #[topic]
    pub group: u32,
    #[topic]
    pub payer: Address,
    pub amount: i128,
    pub memo: String,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettleApproved {
    #[topic]
    pub group: u32,
    pub member: Address,
    pub approvals: u32,
    pub needed: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GroupSettled {
    #[topic]
    pub group: u32,
    pub transfers: Vec<Transfer>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DebtPaid {
    #[topic]
    pub group: u32,
    #[topic]
    pub from: Address,
    pub to: Address,
    pub amount: i128,
}

#[contract]
pub struct Settle;

fn load(env: &Env, id: u32) -> Result<Group, Error> {
    let key = Key::Group(id);
    let g: Group = env.storage().persistent().get(&key).ok_or(Error::NotFound)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_BUMP);
    Ok(g)
}

fn save(env: &Env, id: u32, g: &Group) {
    let key = Key::Group(id);
    env.storage().persistent().set(&key, g);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_BUMP);
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_BUMP);
}

fn token(env: &Env) -> Address {
    env.storage().instance().get(&Key::Token).unwrap()
}

fn needed(n: u32) -> u32 {
    // At least half of the group, rounded up.
    (n + 1) / 2
}

/// Greedy matching of the largest debtor with the largest creditor. For a
/// group of n people it produces at most n - 1 transfers.
pub fn plan(env: &Env, g: &Group) -> Vec<Transfer> {
    let mut debt: Vec<(Address, i128)> = Vec::new(env);
    let mut cred: Vec<(Address, i128)> = Vec::new(env);
    for m in g.members.iter() {
        let b = g.balances.get(m.clone()).unwrap_or(0);
        if b < 0 {
            debt.push_back((m, -b));
        } else if b > 0 {
            cred.push_back((m, b));
        }
    }
    let mut out = Vec::new(env);
    loop {
        let (mut di, mut dv) = (u32::MAX, 0i128);
        for (i, (_, v)) in debt.iter().enumerate() {
            if v > dv {
                dv = v;
                di = i as u32;
            }
        }
        let (mut ci, mut cv) = (u32::MAX, 0i128);
        for (i, (_, v)) in cred.iter().enumerate() {
            if v > cv {
                cv = v;
                ci = i as u32;
            }
        }
        if di == u32::MAX || ci == u32::MAX {
            break;
        }
        let amt = if dv < cv { dv } else { cv };
        let (da, _) = debt.get(di).unwrap();
        let (ca, _) = cred.get(ci).unwrap();
        out.push_back(Transfer {
            from: da.clone(),
            to: ca.clone(),
            amount: amt,
        });
        debt.set(di, (da, dv - amt));
        cred.set(ci, (ca, cv - amt));
    }
    out
}

#[contractimpl]
impl Settle {
    pub fn __constructor(env: Env, token: Address) {
        env.storage().instance().set(&Key::Token, &token);
        env.storage().instance().set(&Key::NextId, &0u32);
    }

    pub fn token(env: Env) -> Address {
        token(&env)
    }

    /// Creates a group. The creator is always a member.
    pub fn create_group(
        env: Env,
        creator: Address,
        name: String,
        members: Vec<Address>,
        open: bool,
    ) -> Result<u32, Error> {
        creator.require_auth();
        let mut list = Vec::new(&env);
        list.push_back(creator.clone());
        for m in members.iter() {
            if !list.contains(&m) {
                list.push_back(m);
            }
        }
        if list.len() > MAX_MEMBERS {
            return Err(Error::GroupFull);
        }
        let id: u32 = env.storage().instance().get(&Key::NextId).unwrap_or(0);
        env.storage().instance().set(&Key::NextId, &(id + 1));
        let g = Group {
            name: name.clone(),
            creator: creator.clone(),
            members: list,
            balances: Map::new(&env),
            approvals: Vec::new(&env),
            epoch: 0,
            expenses: 0,
            open,
        };
        save(&env, id, &g);
        GroupCreated {
            group: id,
            creator,
            name,
        }
        .publish(&env);
        Ok(id)
    }

    /// A guest joins an open group.
    pub fn join(env: Env, id: u32, member: Address) -> Result<(), Error> {
        member.require_auth();
        let mut g = load(&env, id)?;
        if !g.open {
            return Err(Error::Closed);
        }
        if g.members.contains(&member) {
            return Err(Error::AlreadyMember);
        }
        if g.members.len() >= MAX_MEMBERS {
            return Err(Error::GroupFull);
        }
        g.members.push_back(member);
        save(&env, id, &g);
        Ok(())
    }

    /// Records an expense paid by `payer`, split equally between
    /// `participants` (rounding leftovers stay with the payer).
    pub fn add_expense(
        env: Env,
        id: u32,
        payer: Address,
        amount: i128,
        participants: Vec<Address>,
        memo: String,
    ) -> Result<(), Error> {
        payer.require_auth();
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        if participants.is_empty() {
            return Err(Error::EmptyParticipants);
        }
        let mut g = load(&env, id)?;
        if !g.members.contains(&payer) {
            return Err(Error::NotMember);
        }
        for p in participants.iter() {
            if !g.members.contains(&p) {
                return Err(Error::NotMember);
            }
        }
        let n = participants.len() as i128;
        let share = amount / n;
        let rest = amount - share * n;
        let b = g.balances.get(payer.clone()).unwrap_or(0);
        g.balances.set(payer.clone(), b + amount - rest);
        for p in participants.iter() {
            let b = g.balances.get(p.clone()).unwrap_or(0);
            g.balances.set(p, b - share);
        }
        g.expenses += 1;
        g.epoch += 1;
        g.approvals = Vec::new(&env);
        save(&env, id, &g);
        ExpenseAdded {
            group: id,
            payer,
            amount,
            memo,
        }
        .publish(&env);
        Ok(())
    }

    /// The transfers that would square the group up now.
    pub fn debts(env: Env, id: u32) -> Result<Vec<Transfer>, Error> {
        let g = load(&env, id)?;
        Ok(plan(&env, &g))
    }

    /// What each debtor must have approved to this contract before the
    /// settlement can run (sum of their planned transfers).
    pub fn needed_allowance(env: Env, id: u32, member: Address) -> Result<i128, Error> {
        let g = load(&env, id)?;
        let b = g.balances.get(member).unwrap_or(0);
        Ok(if b < 0 { -b } else { 0 })
    }

    pub fn get_group(env: Env, id: u32) -> Result<Group, Error> {
        load(&env, id)
    }

    pub fn group_count(env: Env) -> u32 {
        env.storage().instance().get(&Key::NextId).unwrap_or(0)
    }

    /// A member approves the current settlement. When half of the group has
    /// approved, every debt is paid in this same transaction, pulled from each
    /// debtor's allowance. Returns true when the group was settled.
    pub fn approve(env: Env, id: u32, member: Address) -> Result<bool, Error> {
        member.require_auth();
        let mut g = load(&env, id)?;
        if !g.members.contains(&member) {
            return Err(Error::NotMember);
        }
        let transfers = plan(&env, &g);
        if transfers.is_empty() {
            return Err(Error::NothingToSettle);
        }
        if g.approvals.contains(&member) {
            return Err(Error::AlreadyApproved);
        }
        g.approvals.push_back(member.clone());
        let need = needed(g.members.len());
        SettleApproved {
            group: id,
            member,
            approvals: g.approvals.len(),
            needed: need,
        }
        .publish(&env);
        if g.approvals.len() < need {
            save(&env, id, &g);
            return Ok(false);
        }
        let tk = token::Client::new(&env, &token(&env));
        let me = env.current_contract_address();
        for t in transfers.iter() {
            tk.transfer_from(&me, &t.from, &t.to, &t.amount);
        }
        g.balances = Map::new(&env);
        g.approvals = Vec::new(&env);
        g.epoch += 1;
        save(&env, id, &g);
        GroupSettled {
            group: id,
            transfers,
        }
        .publish(&env);
        Ok(true)
    }

    /// Pays one debt directly (also used by the Circle "one payout, three
    /// uses" transaction). Moves real tokens from `from` to `to`.
    pub fn pay(env: Env, id: u32, from: Address, to: Address, amount: i128) -> Result<(), Error> {
        from.require_auth();
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        let mut g = load(&env, id)?;
        if !g.members.contains(&from) || !g.members.contains(&to) {
            return Err(Error::NotMember);
        }
        token::Client::new(&env, &token(&env)).transfer(&from, &to, &amount);
        let bf = g.balances.get(from.clone()).unwrap_or(0);
        g.balances.set(from.clone(), bf + amount);
        let bt = g.balances.get(to.clone()).unwrap_or(0);
        g.balances.set(to.clone(), bt - amount);
        g.epoch += 1;
        g.approvals = Vec::new(&env);
        save(&env, id, &g);
        DebtPaid {
            group: id,
            from,
            to,
            amount,
        }
        .publish(&env);
        Ok(())
    }
}

#[cfg(test)]
mod test;
