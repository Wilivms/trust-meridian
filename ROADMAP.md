# Roadmap

How Trust Meridian was built during HackMeridian (Lisbon, 25–26 October 2026): the steps, the features as they were added, and the problems met on the way. Timing lives in the git history.

## Before the event (disclosed prior work)

-An early version of the concept (then called Trust Circle) was pitched at a Stellar workshop before the event. We reworked and extended it during HackMeridian: all code, smart contracts, the app and the designs were written during the hackathon, using open-source libraries (OpenZeppelin smart accounts and smart-account-kit, Stellar SDK, three.js).

## 1 · Contracts

- **Settle**: groups, expenses split equally, a greedy plan with at most n − 1 transfers, approval by half of the group, then every debt paid in one transaction with `transfer_from` on capped SEP-41 allowances. A new expense voids pending approvals.
- **Circle**: rotating savings circle with instalments, `collect` pulling instalments from allowances, payout signed by two different members.
  - The idle pot is parked in a **DeFindex** vault between collection and payout.
  - Security deposits are supplied to **XOXNO Lending** and returned with their interest when the circle ends; after a 48 h grace period a missed instalment is covered from the late member's deposit.
  - **Advance on your turn**: a member borrows up to half of their deposit from XOXNO now; the debt is repaid automatically from their pot when their turn comes.
  - **One payout, three uses**: `payout_combo` pays the beneficiary, clears their Settle debts and pays a Cover bill in one atomic transaction.
- **Claim**: send money to someone without a wallet. The link carries a one-time ed25519 key; the claimer signs their new address with it, so a claim seen in the mempool cannot be redirected. The sender can take the money back for 0.10 USDC while nobody has claimed.
- 17 unit tests, including XOXNO's own protocol fixture for deposits, late cover and advances.

### Problems met

- Passkey wallets are contract accounts, so classic Stellar features (claimable balances, path payments, classic multisig) are out of reach: they were replaced by a claim contract, Soroswap and smart-account policies.
- A Soroban transaction holds a single host-function call, so "one payout, three uses" had to be one contract entry point that calls Settle and the bill escrow itself.
- XOXNO's contract SDK and OpenZeppelin's smart accounts both target `soroban-sdk` 28, which fixed the SDK version for the whole workspace.
- The build environment's network policy blocked the Stellar testnet and the Rust wasm target at first.

## 2 · Testnet

- Deployed Settle, Circle and Claim on testnet with the Circle USDC (the asset XOXNO and Trustless Work use). Contract IDs are in `deployments/testnet.json`.
- Demo family accounts (Léa, Hugo, Inès, Noah, Emma), an admin and a treasury are funded by friendbot and buy their USDC on the testnet DEX (`scripts/setup.mjs`).
- `scripts/e2e.mjs` runs the whole flow for real: a circle with XOXNO deposits, an advance borrowed on XOXNO, three instalments, a payout signed by two members; a Settle group with an expense, capped allowances and a half-group approval that pays everyone in one transaction; a claim link redeemed by signature.

### Problems met

- Uploading contract code cost 400 to 1,300 testnet XLM: the testnet's live state is above its target size, so rent is multiplied. The Circle upload's resource fee did not fit the 32-bit transaction fee, so deployments are wrapped in a fee bump transaction (64-bit fee).
- Contracts first extended their storage TTL to 60 days on every write; at the current rent rate that made creating a circle cost over 12,000 XLM. TTL extensions now keep entries alive 8 days and only bump when below 1 day: creating a circle costs about 5 XLM, or about 98 XLM when it opens a new XOXNO account.
- XOXNO calls are not fully predictable at simulation time (prices move), so submissions add a 30% instruction margin.
- The DeFindex testnet vaults hold Blend's test USDC, a different asset from the Circle USDC used by XOXNO and Trustless Work.

## 3 · DeFindex × XOXNO

- The DeFindex testnet vaults hold another test USDC, so Trust Meridian ships its own **DeFindex strategy backed by XOXNO Lending** (`contracts/xoxno-strategy`): same interface as the official strategies (`asset`, `deposit`, `withdraw`, `balance`, `harvest`), supplying the vault's USDC to XOXNO.
- A DeFindex vault for Circle USDC was created through the official DeFindex factory with that strategy, and Circle parks its idle pot there: pot → DeFindex vault → XOXNO supply, and back at payout. Verified on testnet by `scripts/e2e.mjs park`.

### Problems met

- The vault constructor trapped without an error code: the vault name is prefixed with "DeFindex-Vault-" and a long name broke it. A short name fixed it.

## 4 · Live app

- Deployed on Vercel (public URL in the README). The 3D world now drives real testnet transactions: a passkey wallet (OpenZeppelin smart account through smart-account-kit) signs, `/api/relay` pays every fee from a sponsor account, and each confirmation shows its stellar.expert link. Anything not on-chain is labelled "Simulated".
- Onboarding: one Face ID creates the wallet, then the server gives 1,000 test USDC and sets up the family's two circles and the Lisbon group with its expenses. Each step retries on a busy network.
- The family's instalments are pulled by one `collect` from capped allowances instead of five separate payments.
- Claude runs for real: `/api/read-bill` reads a bill photo (the sample PNG or your own) and fills the Cover request; `/api/plain` writes the one-sentence summary of a combined payout.
- Presenter mode walks the demo with a clicker; S switches the whole demo to simulation if the network fails. The QR in the Harbor opens the app on testnet.
- The demo family refills its test USDC on the DEX before each onboarding, so many people can try the app in a row.

### Problems met

- Passkey signatures failed until each authorization entry carried its context rule ids; the kit's lookup goes through an indexer that does not know new testnet wallets, so the app binds the Default rule (id 0).
- Each new wallet costs the demo family about 1,000 test USDC; without automatic refills the third visitor's onboarding failed.
- Several bot transactions in parallel from the same sponsor account collided on sequence numbers: family approvals now run one after another.
- The intro's last shot was framed too close: the poles of the meridian to trace were off screen. The camera distance is now computed from the field of view.

## 5 · Everything real

- No simulation left: an action either is a testnet transaction or it is gone from the app. Without a wallet, the app asks for one first.
- **Trustless Work**: each Cover request gets a single-release escrow (`api/escrow.js`): the payee is service provider and receiver, Trust Meridian approves and releases. The passkey wallet funds it with a plain USDC transfer; the Circle `payout_combo` can fund it inside the payout. Deploy, fund and release verified on testnet.
- **Bill agent**: one Face ID adds a context rule to the wallet: the agent's key (a delegated signer), USDC transfers only, OpenZeppelin's spending-limit policy as a weekly cap. Claude picks the bills due; the server signs as the agent (`api/agent.js`). Verified: within the cap a payment goes through, over it the wallet refuses on-chain.
- **Anchor deposit**: SEP-45 web auth signed by the passkey, then a SEP-24 interactive deposit with the Stellar test anchor. Verified: 5 USD in, 4.50 USDC received in the contract wallet.
- **Reflector**: the testnet fiat oracle publishes EUR, GBP, CAD, MXN and BRL, so the family moved to Paris, London, Toronto, Mexico City and São Paulo, with new monuments.
- Help requests are saved in Supabase; SEP-7 links pay the payee's real testnet account; creating a circle or a shared account is on-chain.
- The intro opens by drawing a circle (inspired by why.zero, where you draw a zero to enter).

### Problems met

- The kit's signed entry and our SEP-45 entries came from two copies of the XDR types: the challenge answer is encoded by hand.
- Delegated signers need a second authorization entry: the agent signs `__check_auth(digest)` on the wallet, where the digest binds the context rule id.
- The combined payout first passed no bill destination: the bill now goes into the request's escrow.
- Creating two wallets at once made the shared deployer collide and the relay time out.

## 6 · Hardening for judges

- Claim links work end to end: the receiver opens the link, creates a passkey wallet and claims; the money arrives in seconds.
- The advance on your turn is in the app and in the presenter: the deposit goes to XOXNO, half of it is borrowed now and the pot repays it.
- Several people at once: the relay rotates over eight fee sponsors and retries a dropped submission, a failed wallet deployment is retried without a new Face ID, and onboarding runs in short idempotent steps. Verified with three wallets created in parallel.
- Your Cover requests come back from Supabase after a reload.

### Problems met

- One onboarding step chained six transactions and passed Vercel's 60-second limit under load; a retried step paid the welcome USDC twice.
- Allowance top-ups set too low let one family member's settlement fail; they are now kept far above what a settlement needs.
