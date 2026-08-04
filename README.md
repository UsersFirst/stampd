# stampd

**Proof you were there.** A simple, focused replacement for POAP — commemorative attendance badges minted on **Base**, with the decentralized parts on-chain and the operational controls on **Cloudflare Workers + D1**.

POAP is shutting down. This is not an attempt to rebuild all of it. It is the one thing people actually used it for: an organizer runs an event, attendees scan a QR code, and each attendee ends up holding a permanent, non-transferable keepsake tied to that event.

## Design in one paragraph

The contract is deliberately dumb: a single ERC-1155 collection on Base where `tokenId == eventId`, badges are soulbound by default, and a mint is only accepted when accompanied by an EIP-712 voucher signed by the event's authorized signer. All of the policy — who may claim, how many, during what window, whether this QR code has already been burned — lives off-chain in a Cloudflare Worker backed by D1. That split means the badges survive independently of us, while the anti-farming controls stay flexible and cheap to change.

## Architecture

```
Attendee phone                Cloudflare (control plane)          Base (settlement)
─────────────                 ──────────────────────────          ─────────────────
scan QR ───────────────────▶  Worker validates code in D1
                              marks it redeemed
                              signs EIP-712 voucher ───────────▶  Stampd1155.claim()
Coinbase Smart Wallet ◀────── voucher returned                    verifies signature
mints, gas sponsored                                              mints soulbound badge
by Base Paymaster
```

| Layer | Stack |
| --- | --- |
| Contracts | Solidity + Foundry, ERC-1155, EIP-712 vouchers, Base Sepolia → Base mainnet |
| Claim app | Static SPA (Vite + React), wagmi/viem, OnchainKit + Coinbase Smart Wallet |
| API / control plane | Cloudflare Workers, D1 (SQLite), Durable Objects for rotating QR windows, Workers Secrets for the signer key |
| Dashboard | Static SPA, same build pipeline as the claim app |
| Assets | R2 for uploads, IPFS (pinned) for final immutable metadata |

## Hosting

Everything lives at **stampd.usersfirst.com**, on a single origin:

- The static apps are built by GitHub Actions and served from **GitHub Pages**. Pages is static-only, which is why the front-ends are SPAs rather than server-rendered Next.js.
- DNS sits on Cloudflare. The `stampd` record is **proxied** (orange cloud) to the Pages origin, with SSL in Full mode and GitHub's custom-domain verification in place.
- A **Worker route on `stampd.usersfirst.com/api/*`** intercepts API traffic ahead of Pages.

Because the API and the site share an origin, there is no CORS configuration and no preflight round-trip on the claim path — which matters when a room full of people all scan at once.

## Repository layout

```
contracts/          Foundry project — Stampd1155, voucher verification, tests
apps/claim/         Attendee-facing claim flow (QR → wallet → mint)
apps/api/           Cloudflare Worker: code validation, voucher signing, D1 schema + migrations
apps/dashboard/     Organizer console: create event, upload art, generate codes, export claimers
packages/shared/    ABIs, generated types, EIP-712 domain/type definitions shared by all apps
docs/               Design notes, threat model, migration notes
```

## Measured gas

L2 execution gas from `contracts/test/GasBench.t.sol` (`forge test --match-contract GasBenchTest -vv`):

| Operation | Gas |
| --- | --- |
| `createEvent` | 110,947 |
| `mintBatch`, 1 recipient | 54,311 |
| `mintBatch`, 10 recipients | 51,608 per badge |
| `mintBatch`, 200 recipients | 51,338 per badge |
| `claim` (single voucher) | 84,676 |

Batching converges to ~51.3k per badge almost immediately — the 21k base transaction cost is the only thing being amortised, because each badge still pays two cold `SSTORE`s (the `claimed` flag and the ERC-1155 balance) that no amount of batching removes. Against `claim`'s 84.7k that is roughly a 1.65× saving on execution gas.

The larger saving is outside this table: the `claim` path in production also carries ERC-4337 bundler and EntryPoint overhead, and a first-time attendee pays to deploy their smart wallet. `mintBatch` delivers to counterfactual addresses and skips both.

**These numbers exclude Base's L1 data-availability cost**, which scales with calldata (32 bytes per recipient) and is a meaningful share of the real bill. Confirm against an actual Base Sepolia transaction before quoting an organizer a per-badge price.

If per-badge cost ever needs to come down further, the available lever is replacing the `claimed` address mapping with a bitmap keyed by a Worker-assigned attendee index — 256 attendees per slot instead of one, worth roughly 20k per badge, at the cost of a more complex claim path.

## Roadmap

**Phase 1 — Contracts.** `Stampd1155` with per-event config (supply cap, claim window, transferable flag, signer address), soulbound transfer hook, EIP-712 `ClaimVoucher(eventId, claimer, nonce, expiry)`. Foundry tests covering replay, expiry, supply exhaustion, and transfer blocking. Deploy to Base Sepolia.

**Phase 2 — Claim app.** QR → `/claim/<code>` → Coinbase Smart Wallet onboarding (passkey, no seed phrase) → voucher fetch → sponsored mint. The attendee should never see the word "gas."

**Phase 3 — Cloudflare control plane.** D1 schema for `organizers`, `events`, `claim_codes`, `claims`, `rate_limits`. Worker endpoints for code validation and voucher signing. Two code modes: one-time static codes for remote distribution, and rotating short-lived codes (Durable Object, ~30s window) for the in-person "QR on a projector" case.

**Phase 4 — Organizer dashboard.** Create an event, upload art, set supply and date window, generate N codes, live rotating-QR display mode, CSV export of claimers.

**Phase 5 — Mainnet.** Base mainnet deploy, paymaster budget controls, basic abuse monitoring.

## Explicit non-goals for v1

- Secondary market or any trading surface
- Transferable-by-default badges
- Native mobile apps
- Chains other than Base
- Importing existing POAP holder data (revisit after v1 ships)

## Status

Pre-alpha. Nothing is deployed yet.
