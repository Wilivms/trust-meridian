#![no_std]
//! Trust Meridian · Claim links
//!
//! Send money to a relative who has no wallet yet. The sender locks the
//! amount here with the public half of a one-time ed25519 key; the private
//! half travels in the link. Whoever opens the link creates a passkey wallet
//! and claims to it by signing their new address with the link key, so a
//! claim seen in the mempool cannot be redirected. Until someone claims, the
//! sender can take the money back for a small fee.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, xdr::ToXdr,
    Address, Bytes, BytesN, Env, Vec,
};

const DAY: u32 = 17_280;
const TTL_BUMP: u32 = 60 * DAY;
const TTL_THRESHOLD: u32 = 30 * DAY;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    NotWaiting = 2,
    BadAmount = 3,
    NotSender = 4,
    KeyUsed = 5,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Status {
    Waiting = 0,
    Claimed = 1,
    Reclaimed = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Link {
    pub sender: Address,
    pub amount: i128,
    pub key: BytesN<32>,
    pub status: Status,
    pub created: u64,
    pub claimed_by: Option<Address>,
    /// Optional Cover request this link pays.
    pub request: u32,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Token,
    Treasury,
    Fee,
    NextId,
    Link(u32),
    ByKey(BytesN<32>),
    BySender(Address),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LinkCreated {
    #[topic]
    pub link: u32,
    #[topic]
    pub sender: Address,
    pub amount: i128,
    pub request: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LinkClaimed {
    #[topic]
    pub link: u32,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LinkReclaimed {
    #[topic]
    pub link: u32,
    #[topic]
    pub sender: Address,
    pub amount: i128,
    pub fee: i128,
}

#[contract]
pub struct Claim;

fn load(env: &Env, id: u32) -> Result<Link, Error> {
    let k = Key::Link(id);
    let l: Link = env.storage().persistent().get(&k).ok_or(Error::NotFound)?;
    env.storage().persistent().extend_ttl(&k, TTL_THRESHOLD, TTL_BUMP);
    Ok(l)
}

fn save(env: &Env, id: u32, l: &Link) {
    let k = Key::Link(id);
    env.storage().persistent().set(&k, l);
    env.storage().persistent().extend_ttl(&k, TTL_THRESHOLD, TTL_BUMP);
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_BUMP);
}

fn tok(env: &Env) -> token::Client<'_> {
    let a: Address = env.storage().instance().get(&Key::Token).unwrap();
    token::Client::new(env, &a)
}

/// The message a claimer signs with the link key: "TM-CLAIM", the link id
/// (big endian) and the XDR of the receiving address.
pub fn claim_message(env: &Env, id: u32, to: &Address) -> Bytes {
    let mut m = Bytes::from_slice(env, b"TM-CLAIM");
    m.extend_from_array(&id.to_be_bytes());
    m.append(&to.clone().to_xdr(env));
    m
}

#[contractimpl]
impl Claim {
    /// `fee` is the claim-back fee in token units (0.10 USDC = 1_000_000).
    pub fn __constructor(env: Env, token: Address, treasury: Address, fee: i128) {
        env.storage().instance().set(&Key::Token, &token);
        env.storage().instance().set(&Key::Treasury, &treasury);
        env.storage().instance().set(&Key::Fee, &fee);
        env.storage().instance().set(&Key::NextId, &0u32);
    }

    pub fn create(env: Env, sender: Address, amount: i128, key: BytesN<32>, request: u32) -> Result<u32, Error> {
        sender.require_auth();
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        if env.storage().persistent().has(&Key::ByKey(key.clone())) {
            return Err(Error::KeyUsed);
        }
        tok(&env).transfer(&sender, &env.current_contract_address(), &amount);
        let id: u32 = env.storage().instance().get(&Key::NextId).unwrap_or(0);
        env.storage().instance().set(&Key::NextId, &(id + 1));
        let l = Link {
            sender: sender.clone(),
            amount,
            key: key.clone(),
            status: Status::Waiting,
            created: env.ledger().timestamp(),
            claimed_by: None,
            request,
        };
        save(&env, id, &l);
        env.storage().persistent().set(&Key::ByKey(key.clone()), &id);
        env.storage().persistent().extend_ttl(&Key::ByKey(key), TTL_THRESHOLD, TTL_BUMP);
        let sk = Key::BySender(sender.clone());
        let mut list: Vec<u32> = env.storage().persistent().get(&sk).unwrap_or(Vec::new(&env));
        list.push_back(id);
        env.storage().persistent().set(&sk, &list);
        env.storage().persistent().extend_ttl(&sk, TTL_THRESHOLD, TTL_BUMP);
        LinkCreated { link: id, sender, amount, request }.publish(&env);
        Ok(id)
    }

    /// Anyone can submit the claim (the relayer does); the signature binds it
    /// to `to`.
    pub fn claim(env: Env, id: u32, to: Address, signature: BytesN<64>) -> Result<i128, Error> {
        let mut l = load(&env, id)?;
        if l.status != Status::Waiting {
            return Err(Error::NotWaiting);
        }
        let msg = claim_message(&env, id, &to);
        env.crypto().ed25519_verify(&l.key, &msg, &signature);
        tok(&env).transfer(&env.current_contract_address(), &to, &l.amount);
        l.status = Status::Claimed;
        l.claimed_by = Some(to.clone());
        save(&env, id, &l);
        LinkClaimed { link: id, to, amount: l.amount }.publish(&env);
        Ok(l.amount)
    }

    /// The sender takes the money back while nobody has claimed it, minus
    /// the claim-back fee.
    pub fn claim_back(env: Env, id: u32) -> Result<i128, Error> {
        let mut l = load(&env, id)?;
        l.sender.require_auth();
        if l.status != Status::Waiting {
            return Err(Error::NotWaiting);
        }
        let fee: i128 = env.storage().instance().get(&Key::Fee).unwrap_or(0);
        let fee = if fee > l.amount { l.amount } else { fee };
        let t = tok(&env);
        let me = env.current_contract_address();
        if fee > 0 {
            let treasury: Address = env.storage().instance().get(&Key::Treasury).unwrap();
            t.transfer(&me, &treasury, &fee);
        }
        let back = l.amount - fee;
        if back > 0 {
            t.transfer(&me, &l.sender, &back);
        }
        l.status = Status::Reclaimed;
        save(&env, id, &l);
        LinkReclaimed { link: id, sender: l.sender.clone(), amount: back, fee }.publish(&env);
        Ok(back)
    }

    pub fn get(env: Env, id: u32) -> Result<Link, Error> {
        load(&env, id)
    }

    pub fn by_key(env: Env, key: BytesN<32>) -> Result<u32, Error> {
        env.storage().persistent().get(&Key::ByKey(key)).ok_or(Error::NotFound)
    }

    /// Every link a sender created ("My claim links").
    pub fn links_of(env: Env, sender: Address) -> Vec<u32> {
        env.storage().persistent().get(&Key::BySender(sender)).unwrap_or(Vec::new(&env))
    }

    pub fn fee(env: Env) -> i128 {
        env.storage().instance().get(&Key::Fee).unwrap_or(0)
    }
}

#[cfg(test)]
mod test;
