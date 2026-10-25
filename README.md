# Trust Meridian

**A money protocol for families spread across the world, bringing them back together.**

Built at HackMeridian (Lisbon, October 2026) · Genesis path · tracks **Stellar Composed** and **Stellar Unlocked**.

Families live across borders; their money doesn't. 281 million people live outside their country of birth and sent home $831 billion in 2022, paying on average 6.5% to send $200 (IOM World Migration Report 2024; World Bank Remittance Prices Worldwide, Q1 2025). Saving together, sharing costs and paying bills back home still run on cash, trust and spreadsheets.

Trust Meridian puts three everyday uses on one passkey wallet:

| Use | What it does | On-chain |
|---|---|---|
| **Circle** | A rotating savings circle (tontine) across countries | `contracts/circle` |
| **Settle** | Shared expenses across currencies, squared in one move | `contracts/settle` |
| **Cover** | Pay a relative's bill back home, straight to the payee | Trustless Work escrow + `contracts/claim` |

…and lets them work together: **one payout, three uses**. When your Circle turn comes, one atomic transaction pays you the pot, clears your Settle debts and pays a family bill.

## What is composed

| Building block | Role in Trust Meridian |
|---|---|
| **OpenZeppelin smart accounts** (smart-account-kit) | Passkey wallets, context rules, spending-limit policy (family allowance), guardians |
| **Sponsored relay** (`api/relay`) | Pays every fee from a sponsor account: users never hold XLM |
| **DeFindex** | The idle Circle pot is parked in a vault between collection and payout |
| **XOXNO Lending** | Security deposits are supplied while the circle runs; the *advance on your turn* is borrowed against them |
| **Trustless Work** | Escrow for Cover bills until the payment is confirmed |
| **Soroswap · Reflector** | Exact-output conversion into the payee's currency, guarded by the oracle price |
| **Claude (Anthropic)** | Reads a bill photo to pre-fill a Cover request (Sonnet, vision); sums up a combined payout in plain words (Haiku) |
| **Supabase** | Real-time harbor, request metadata and the live ledger mirror (money stays on-chain) |

## Contracts

`contracts/` is a Cargo workspace on `soroban-sdk` 28.

- **Circle**: `create`, `join`, `pay`, `collect` (pulls instalments from capped SEP-41 allowances), `cover_late` (after 48 h the deposit covers a missed instalment), `park` (DeFindex), `payout` (two different members sign), `payout_combo` (one payout, three uses), `advance` (borrow up to half of your deposit on XOXNO, repaid from your pot).
- **Settle**: `create_group`, `join`, `add_expense`, `debts` (greedy plan, at most n − 1 transfers), `approve` (at half of the group, every debt is paid in one transaction with `transfer_from`), `pay`.
- **Claim**: `create` (locks funds with the public half of a one-time ed25519 key), `claim` (the claimer signs their address with the link key, so a claim cannot be redirected), `claim_back` (0.10 USDC fee while unclaimed), `links_of`.

```bash
cargo test            # 17 tests, including XOXNO's protocol fixture
stellar contract build
```

Deployed testnet contract IDs are listed in [Deployments](#deployments).

## App

The front is the 3D ocean world: each use is an island, each payment a boat that sails only once its transaction is confirmed. `src/chain` holds the wallet and contract calls; `api/` holds the Vercel functions (fee relay, the demo's family members, Claude bill reading).

```bash
npm install
npm run dev
```

Environment variables are listed in `.env.example`. Secrets stay in Vercel and in a local `.env`, never in the repo.

## Deployments

| Contract | Testnet ID |
|---|---|
| Circle | [`CBRLDAQIKYQZQM5V2D5JZLZ5GA4JB4VNNGS5YGCZW56XPGZ7OVW22GQD`](https://stellar.expert/explorer/testnet/contract/CBRLDAQIKYQZQM5V2D5JZLZ5GA4JB4VNNGS5YGCZW56XPGZ7OVW22GQD) |
| Settle | [`CCVRSMT42L5SPEQWYTXUO5NY5B7GQSKRC4YDWYV36XBHU6AORGREQWPM`](https://stellar.expert/explorer/testnet/contract/CCVRSMT42L5SPEQWYTXUO5NY5B7GQSKRC4YDWYV36XBHU6AORGREQWPM) |
| Claim | [`CCXSVXARY5NY2GN5XRJF37SYFKHPH7I3H7BNWB5WSGMK5AW3LCEEDT3R`](https://stellar.expert/explorer/testnet/contract/CCXSVXARY5NY2GN5XRJF37SYFKHPH7I3H7BNWB5WSGMK5AW3LCEEDT3R) |
| DeFindex vault "TM Circle" | [`CBCTPTAL7E54BCDYO54GJUNM7GLEPL3UXAF6HEGWMM2MTXLFVJ7NCNSZ`](https://stellar.expert/explorer/testnet/contract/CBCTPTAL7E54BCDYO54GJUNM7GLEPL3UXAF6HEGWMM2MTXLFVJ7NCNSZ) |
| XOXNO strategy (DeFindex → XOXNO Lending) | [`CCRU56E3WHFFGEQ7LZ4HEEL6MWVZE7BBHB36H4F6Y27T6GGY4SCR2FMM`](https://stellar.expert/explorer/testnet/contract/CCRU56E3WHFFGEQ7LZ4HEEL6MWVZE7BBHB36H4F6Y27T6GGY4SCR2FMM) |
| USDC (Circle, SAC) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

Live app: https://trust-meridian-blitz-bet.vercel.app

## Try it

Open the live app on a phone, press the passkey button in the wallet sheet ("Go live on Stellar testnet") and confirm with Face ID or a fingerprint. Setup takes about two minutes: the app receives 1,000 test USDC and joins the family's circles and the Lisbon group. From then on every action is a testnet transaction, with fees sponsored. Press P for presenter mode.

## Prior work

A visual mockup of the 3D world, with simulated transactions, existed before the event. Everything on-chain (contracts, wallet integration, relayer, partner integrations) was built during HackMeridian. The journey is in [ROADMAP.md](ROADMAP.md).

## Team

Wiliams Lopes · De Vinci Blockchain (dvb.xyz)
