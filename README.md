# stampd

**Proof you were there.** A simple, focused replacement for POAP — commemorative attendance badges minted on **Base**, with the decentralized parts on-chain and the operational controls on **Cloudflare Workers + D1**.

POAP is shutting down. This is not an attempt to rebuild all of it. It is the one thing people actually used it for: an organizer runs an event, attendees scan a QR code, and each attendee ends up holding a permanent, non-transferable keepsake tied to that event.

## Design in one paragraph

The contract is deliberately dumb: a single ERC-1155 collection on Base where `tokenId == eventId`, and badges are soulbound by default. Every event carries its own signer address, and that one address authorizes both ways a badge can be issued. All of the policy — who may claim, how many, during what window, whether this QR code has already been burned — lives off-chain in a Cloudflare Worker backed by D1. That split means the badges survive independently of us, while the anti-farming controls stay flexible and cheap to change.

**The host pays.** Gas comes from a per-event float the organizer funds, not from a platform budget. That is not just a billing preference: it means a farmer who drains a float is draining the organizer's own money against the organizer's own codes, which is a support conversation rather than an incident.

## Architecture

The default path is host-funded and batched. The attendee never pays gas, never deploys a wallet, and never waits on a bundler:

```
Attendee phone              Cloudflare (control plane)        Base (settlement)
──────────────              ──────────────────────────        ─────────────────
scan QR ─────────────────▶  Worker validates code in D1
sign message (free) ─────▶  burns the code, queues the
                            address in a Durable Object
"claimed ✓" ◀────────────── flush every ~30s or N claims
                            per-event key submits ────────▶   Stampd1155.mintBatch()
                            (organizer-funded gas)            onlyEventSigner
                                                              mints soulbound badges
```

Attendees are minted to *counterfactual* smart-wallet addresses — addresses that exist but have never been deployed. An ERC-1155 mint to an address with no code skips the receiver hook, so the wallet-deployment cost moves to whenever the attendee first uses that wallet elsewhere, which may be never on the organizer's dime.

That optimisation used to double as a safety property, on the assumption that recipients with code were rare. EIP-7702 ended it: a delegated wallet is 23 bytes of `0xef0100 || implementation`, so an ordinary person's wallet now has code, and a recipient whose delegate lacks `IERC1155Receiver` would revert the whole batch. `mintBatch` therefore probes each recipient with code before minting and skips the ones that cannot receive, rather than losing a room's badges to one attendee.

The self-serve path still exists for events that want instant on-chain finality and will fund a paymaster. There the attendee (or a bundler) submits an EIP-712 voucher signed by the same per-event key, and `claim()` verifies it on-chain with ERC-1271 support:

```
attendee ──▶ Worker signs voucher ──▶ Stampd1155.claim(voucher, sig) ──▶ badge
             (paymaster sponsors the userop)
```

Both paths share the `claimed` map, so they cannot double-badge one address.

| Layer | Stack |
| --- | --- |
| Contracts | Solidity + Foundry, ERC-1155, per-event signer, Base Sepolia → Base mainnet |
| Claim app | Static SPA (Vite + React), wagmi/viem, OnchainKit + Coinbase Smart Wallet |
| API / control plane | Cloudflare Workers, D1 (SQLite), Durable Objects for rotating QR windows, Workers Secrets for the signer key |
| Dashboard | Static SPA, same build pipeline as the claim app |
| Assets | R2 for uploads, IPFS (pinned) for final immutable metadata |

## Hosting

- The static apps are built by GitHub Actions and served from **GitHub Pages** at **stampd.usersfirst.com**. Pages is static-only, which is why the front-ends are SPAs rather than server-rendered Next.js.
- DNS for `usersfirst.com` is at **name.com**, not Cloudflare.
- The Worker API is deployed to **`*.workers.dev`** — currently **https://stampd-api.pete-872.workers.dev** — and is therefore **cross-origin** to the site. It speaks CORS with an origin allowlist; preflights are cached for a day, so the cost is one extra round trip per browser session.

The dashboard needs `VITE_API_BASE_URL` set to the Worker origin at build time — a repository variable of that name, consumed by `.github/workflows/pages.yml`. Without it a production build fails loudly on the first API call rather than silently 404ing against Pages.

### Why not a same-origin `/api/*` route

A Worker route on `stampd.usersfirst.com/api/*` would remove CORS entirely, and would also allow real security headers (`frame-ancestors`, HSTS), which GitHub Pages cannot set at all. But Worker routes only fire for zones Cloudflare hosts, so it would require migrating `usersfirst.com` DNS off name.com — affecting every service on that domain, not just stampd. Deferred rather than decided; tracked in issue #1.

Note that D1 and R2 need no DNS arrangement of any kind. Only custom-hostname routing does.

### Cloudflare resources

| Kind | Name | Role |
| --- | --- | --- |
| R2 | `stampd-nfts` | Badge art and metadata, production |
| R2 | `stampd-nfts-preview` | `wrangler dev --remote` against the default env |
| R2 | `stampd-nfts-dev` | `env.dev`, so local uploads never land in the production bucket |
| D1 | `stampd` | Claim codes, claims, event drafts |
| D1 | `stampd-dev` | Same schema, for `--env dev` |

Database ids are in `apps/api/wrangler.toml`. They are account-scoped identifiers rather than
secrets, which is why they are committed instead of injected.

Provisioning these from a clean account needs two things that are easy to miss. **R2 must be
enabled once from the dashboard** before any token can create a bucket — until then the API
answers `code: 10042` no matter how the token is scoped. And the API token needs *Workers
Scripts:Edit*, *D1:Edit*, *Workers R2 Storage:Edit*, and *Account Settings:Read*; a token
missing the D1 scope fails with a bare `Authentication error [code: 10000]` that does not say
which permission is absent.

## Repository layout

```
contracts/          Foundry project — Stampd1155, voucher verification, tests
apps/claim/         Attendee-facing claim flow (QR → wallet → mint)
apps/api/           Cloudflare Worker: code validation, voucher signing, D1 schema + migrations
apps/dashboard/     Organizer console: create event, upload art, generate codes, export claimers
packages/shared/    ABIs, generated types, EIP-712 domain/type definitions shared by all apps
docs/               Design notes, threat model, migration notes
```

## Running locally

Requires Node 20.19+ or 22.12+ and pnpm 9. Foundry for the contracts.

```bash
pnpm install
pnpm --filter @stampd/api dev        # Worker + R2 + D1 on :8787
pnpm dev                             # dashboard on :5173, proxying /api to the Worker
```

The dev server proxies `/api/*` to the local Worker, so `VITE_API_BASE_URL` can stay unset locally. The dev Worker's origin allowlist covers `localhost:5173`.

`wrangler dev` runs D1 against a local SQLite file, so the schema has to be applied there once before anything reads it:

```bash
pnpm --filter @stampd/api db:migrate:local   # local SQLite, no Cloudflare account needed
pnpm --filter @stampd/api db:migrate         # the real stampd database
```

`GET /api/health` queries both bindings and returns 503 with a per-dependency breakdown, so a missing binding or an unapplied migration shows up there rather than on an organizer's first claim.

```bash
forge test --root contracts          # 52 tests
pnpm sync:abi                        # regenerate the shared ABI after a contract change
```

## Deploying the contract

```bash
cp contracts/.env.example contracts/.env   # fill in DEPLOYER_PRIVATE_KEY
cd contracts && source .env

forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
cd .. && pnpm sync:deployment              # writes the address into packages/shared
```

`--verify` reads `ETHERSCAN_API_KEY`. One Etherscan V2 key covers Base and Base Sepolia both;
there is no separate Basescan key to obtain. Verification often fails its first attempt with
`Could not detect ContractCode` — that is the indexer lagging the block, and forge retries.

Deployment goes through the deterministic CREATE2 factory with `salt = keccak256("stampd.v1")`, and the constructor takes no arguments — so the contract lands at **the same address on Base Sepolia and Base mainnet**. One address in the docs, the front-end, and every QR code, whichever chain an event lives on. Re-running the script against a chain that already has it is a no-op rather than a second deployment.

The deployer key has no ongoing role. It does not own the contract, cannot mint, and cannot touch anyone's event — every event carries its own signer, and event creation is permissionless. It only needs enough ETH to cover the deployment itself.

`packages/shared` is consumed straight from TypeScript source with no build step, so a contract change flows through `pnpm sync:abi` into both apps immediately.

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

**Phase 3 — Cloudflare control plane.** D1 schema for `organizers`, `events`, `claim_codes`, `claims`, `rate_limits` — *landed, in `apps/api/migrations/`; the endpoints on top of it are not*. Worker endpoints for code validation and voucher signing. Two code modes: one-time static codes for remote distribution, and rotating short-lived codes (Durable Object, ~30s window) for the in-person "QR on a projector" case.

**Phase 4 — Organizer dashboard.** Create an event, upload art, set supply and date window, generate N codes, live rotating-QR display mode, CSV export of claimers.

**Phase 5 — Mainnet.** Base mainnet deploy, paymaster budget controls, basic abuse monitoring.

## Explicit non-goals for v1

- Secondary market or any trading surface
- Transferable-by-default badges
- Native mobile apps
- Chains other than Base
- Importing existing POAP holder data (revisit after v1 ships)

## Status

Pre-alpha, but no longer nothing.

| What | Where |
| --- | --- |
| `Stampd1155` | [`0xfe70f7d29686Aa8423a5D20d0618aFA4929fc88b`](https://sepolia.basescan.org/address/0xfe70f7d29686aa8423a5d20d0618afa4929fc88b) on Base Sepolia, verified |
| Worker API | https://stampd-api.pete-872.workers.dev |

The contract holds no events yet, and the Worker serves uploads and health only — claim codes
and voucher signing are still Phase 3. Base mainnet is untouched; the CREATE2 salt reserves the
same address there whenever it is wanted.
