#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, vec, Address, Env, String};

const U: i128 = 10_000_000;

struct T<'a> {
    env: Env,
    c: SettleClient<'a>,
    tk: token::Client<'a>,
    id: Address,
    m: std::vec::Vec<Address>,
}

fn setup<'a>() -> T<'a> {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let tk_addr = sac.address();
    let id = env.register(Settle, (tk_addr.clone(),));
    let c = SettleClient::new(&env, &id);
    let tk = token::Client::new(&env, &tk_addr);
    let mint = StellarAssetClient::new(&env, &tk_addr);
    let m: std::vec::Vec<Address> = (0..4).map(|_| Address::generate(&env)).collect();
    for a in &m {
        mint.mint(a, &(1_000 * U));
    }
    T { env, c, tk, id, m }
}

#[test]
fn expenses_plan_and_half_approval_settles() {
    let t = setup();
    let e = &t.env;
    let m = &t.m;
    let gid = t.c.create_group(
        &m[0],
        &String::from_str(e, "Lisbon weekend"),
        &vec![e, m[1].clone(), m[2].clone(), m[3].clone()],
        &false,
    );
    let all = vec![e, m[0].clone(), m[1].clone(), m[2].clone(), m[3].clone()];
    // m0 pays 400 for everyone, m1 pays 100 for everyone.
    t.c.add_expense(&gid, &m[0], &(400 * U), &all, &String::from_str(e, "Fado night"));
    t.c.add_expense(&gid, &m[1], &(100 * U), &all, &String::from_str(e, "Pastéis"));
    // shares: 100 + 25 = 125 each. Balances: m0 +275, m1 -25, m2 -125, m3 -125
    let plan = t.c.debts(&gid);
    assert!(plan.len() <= 3);
    let mut owed_to_m0 = 0;
    for tr in plan.iter() {
        assert_eq!(tr.to, m[0]);
        owed_to_m0 += tr.amount;
    }
    assert_eq!(owed_to_m0, 275 * U);
    assert_eq!(t.c.needed_allowance(&gid, &m[2]), 125 * U);

    // Debtors grant capped allowances to the Settle contract.
    let exp = e.ledger().sequence() + 1000;
    t.tk.approve(&m[1], &t.id, &(25 * U), &exp);
    t.tk.approve(&m[2], &t.id, &(125 * U), &exp);
    t.tk.approve(&m[3], &t.id, &(125 * U), &exp);

    assert!(!t.c.approve(&gid, &m[1]));
    assert!(t.c.approve(&gid, &m[2])); // 2 of 4 = half → settled
    assert_eq!(t.tk.balance(&m[0]), 1_275 * U);
    assert_eq!(t.tk.balance(&m[2]), 875 * U);
    assert!(t.c.debts(&gid).is_empty());
}

#[test]
fn new_expense_voids_pending_approvals() {
    let t = setup();
    let e = &t.env;
    let m = &t.m;
    let gid = t.c.create_group(&m[0], &String::from_str(e, "g"), &vec![e, m[1].clone(), m[2].clone(), m[3].clone()], &true);
    let all = vec![e, m[0].clone(), m[1].clone()];
    t.c.add_expense(&gid, &m[0], &(10 * U), &all, &String::from_str(e, "a"));
    assert!(!t.c.approve(&gid, &m[0]));
    t.c.add_expense(&gid, &m[0], &(10 * U), &all, &String::from_str(e, "b"));
    assert_eq!(t.c.get_group(&gid).approvals.len(), 0);
}

#[test]
#[should_panic]
fn settlement_fails_without_allowance_and_nothing_moves() {
    let t = setup();
    let e = &t.env;
    let m = &t.m;
    let gid = t.c.create_group(&m[0], &String::from_str(e, "g"), &vec![e, m[1].clone()], &false);
    let all = vec![e, m[0].clone(), m[1].clone()];
    t.c.add_expense(&gid, &m[0], &(10 * U), &all, &String::from_str(e, "a"));
    t.c.approve(&gid, &m[0]); // 1 of 2 = half, but m1 granted no allowance
}

#[test]
fn direct_payment_moves_tokens_and_clears_debt() {
    let t = setup();
    let e = &t.env;
    let m = &t.m;
    let gid = t.c.create_group(&m[0], &String::from_str(e, "g"), &vec![e, m[1].clone()], &false);
    let all = vec![e, m[0].clone(), m[1].clone()];
    t.c.add_expense(&gid, &m[0], &(20 * U), &all, &String::from_str(e, "a"));
    t.c.pay(&gid, &m[1], &m[0], &(10 * U));
    assert!(t.c.debts(&gid).is_empty());
    assert_eq!(t.tk.balance(&m[0]), 1_010 * U);
}

#[test]
fn guests_join_open_groups_only() {
    let t = setup();
    let e = &t.env;
    let m = &t.m;
    let open = t.c.create_group(&m[0], &String::from_str(e, "open"), &vec![e], &true);
    let closed = t.c.create_group(&m[0], &String::from_str(e, "closed"), &vec![e], &false);
    t.c.join(&open, &m[1]);
    assert_eq!(t.c.get_group(&open).members.len(), 2);
    assert_eq!(t.c.try_join(&closed, &m[1]), Err(Ok(Error::Closed)));
}
