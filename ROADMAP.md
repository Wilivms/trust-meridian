# Roadmap

How Trust Meridian was built during HackMeridian (Lisbon, 25–26 October 2026): the steps, the features as they were added, and the problems met on the way. Timing lives in the git history.

## Before the event (disclosed prior work)

- A visual mockup of the product existed before the hackathon: a single-file 3D ocean world (three.js) where each use is an island and each payment a boat, with simulated transactions. It defined the user journey and the presenter flow. No contract, wallet or chain code existed before the event.

## 1 · Contracts

- **Settle**: groups, expenses split equally, a greedy plan with at most n − 1 transfers, approval by half of the group, then every debt paid in one transaction with `transfer_from` on capped SEP-41 allowances. A new expense voids pending approvals.
- **Circle**: rotating savings circle with instalments, `collect` pulling instalments from allowances, payout signed by two different members.
  - The idle pot is parked in a **DeFindex** vault between collection and payout.
  - Security deposits are supplied to **XOXNO Lending** and returned with their interest when the circle ends; after a 48 h grace period a missed instalment is covered from the late member's deposit.
  - **Advance on your turn**: a member borrows up to half of their deposit from XOXNO now; the debt is repaid automatically from their pot when their turn comes.
  - **One payout, three uses**: `payout_combo` pays the beneficiary, clears their Settle debts and pays a Cover bill in one atomic transaction.
- **Claim**: send money to someone without a wallet. The link carries a one-time ed25519 key; the claimer signs their new address with it, so a claim seen in the mempool cannot be redirected. The sender can take the money back for 0.10 USDC while nobody has claimed.
- 16 unit tests, including XOXNO's own protocol fixture for deposits, late cover and advances.

### Problems met

- Passkey wallets are contract accounts, so classic Stellar features (claimable balances, path payments, classic multisig) are out of reach: they were replaced by a claim contract, Soroswap and smart-account policies.
- A Soroban transaction holds a single host-function call, so "one payout, three uses" had to be one contract entry point that calls Settle and the bill escrow itself.
- XOXNO's contract SDK and OpenZeppelin's smart accounts both target `soroban-sdk` 28, which fixed the SDK version for the whole workspace.
- The build environment's network policy blocked the Stellar testnet and the Rust wasm target at first.
