#![cfg(test)]
extern crate std;

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, BytesN, Env};

const U: i128 = 10_000_000;

fn setup<'a>() -> (Env, ClaimClient<'a>, token::Client<'a>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let treasury = Address::generate(&env);
    let id = env.register(Claim, (sac.address(), treasury.clone(), 1_000_000i128));
    let sender = Address::generate(&env);
    StellarAssetClient::new(&env, &sac.address()).mint(&sender, &(100 * U));
    let c = ClaimClient::new(&env, &id);
    let tk = token::Client::new(&env, &sac.address());
    (env, c, tk, sender, treasury)
}

fn sign(env: &Env, sk: &SigningKey, id: u32, to: &Address) -> BytesN<64> {
    let msg = claim_message(env, id, to);
    let mut buf = std::vec![0u8; msg.len() as usize];
    msg.copy_into_slice(&mut buf);
    BytesN::from_array(env, &sk.sign(&buf).to_bytes())
}

#[test]
fn link_is_claimed_by_the_signed_address_only() {
    let (env, c, tk, sender, _) = setup();
    let sk = SigningKey::from_bytes(&[7u8; 32]);
    let pk = BytesN::from_array(&env, &sk.verifying_key().to_bytes());
    let id = c.create(&sender, &(46 * U), &pk, &1);
    assert_eq!(c.links_of(&sender).len(), 1);
    assert_eq!(c.by_key(&pk), id);
    let tobi = Address::generate(&env);
    let sig = sign(&env, &sk, id, &tobi);
    assert_eq!(c.claim(&id, &tobi, &sig), 46 * U);
    assert_eq!(tk.balance(&tobi), 46 * U);
    assert_eq!(c.get(&id).status, Status::Claimed);
    assert_eq!(c.try_claim_back(&id), Err(Ok(Error::NotWaiting)));
}

#[test]
#[should_panic]
fn a_signature_cannot_be_redirected() {
    let (env, c, _, sender, _) = setup();
    let sk = SigningKey::from_bytes(&[9u8; 32]);
    let pk = BytesN::from_array(&env, &sk.verifying_key().to_bytes());
    let id = c.create(&sender, &(5 * U), &pk, &0);
    let tobi = Address::generate(&env);
    let thief = Address::generate(&env);
    let sig = sign(&env, &sk, id, &tobi);
    c.claim(&id, &thief, &sig);
}

#[test]
fn claim_back_returns_the_money_minus_the_fee() {
    let (env, c, tk, sender, treasury) = setup();
    let sk = SigningKey::from_bytes(&[3u8; 32]);
    let pk = BytesN::from_array(&env, &sk.verifying_key().to_bytes());
    let id = c.create(&sender, &(10 * U), &pk, &0);
    assert_eq!(c.claim_back(&id), 10 * U - 1_000_000);
    assert_eq!(tk.balance(&sender), 100 * U - 1_000_000);
    assert_eq!(tk.balance(&treasury), 1_000_000);
    let to = Address::generate(&env);
    let sig = sign(&env, &sk, id, &to);
    assert_eq!(c.try_claim(&id, &to, &sig), Err(Ok(Error::NotWaiting)));
}
