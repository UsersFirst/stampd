import {createPublicClient, http} from "viem";
import {mainnet} from "viem/chains";
import type {Address} from "@stampd/shared";

/// Name resolution for the attendee field, so an organizer can type `alice.eth` instead of
/// reading forty hex characters off someone's phone.
///
/// Resolved against Ethereum mainnet, not Base, because that is where ENS lives — the badge's
/// chain is irrelevant to what a name points at. Basenames come along for free: `alice.base.eth`
/// is an ENS subname whose mainnet resolver answers through CCIP-read, so one lookup covers both
/// and there is no Base resolver address to hardcode and later discover has moved.
///
/// A standalone read-only client rather than wagmi's `useEnsAddress`, deliberately. That hook
/// resolves through the wagmi config, which would mean adding mainnet to the app's chain list —
/// and that list is what the wallet offers to switch to. Nobody organizing on Base Sepolia should
/// be one mis-tap from Ethereum mainnet.
const ensClient = createPublicClient({chain: mainnet, transport: http()});

/// Cheap syntactic check, so a half-typed address never triggers a network call. Deliberately
/// permissive about the suffix: ENS is not limited to `.eth`, and guessing the full set here
/// would silently refuse names that resolve perfectly well.
export function looksLikeEnsName(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.startsWith("0x")) return false;
    if (!trimmed.includes(".")) return false;
    // No whitespace, and something either side of every dot.
    return /^[^\s.]+(\.[^\s.]+)+$/.test(trimmed);
}

/// ENSIP-19 coin type for Base mainnet: the high bit set, or'd with the chain id. A name may
/// carry a different address per chain, and for a badge on Base the Base one is the right answer
/// when it exists — someone who set it did so because that is the wallet they use here.
const BASE_COIN_TYPE = BigInt((0x80000000 | 8453) >>> 0);

/// Resolves a name to an address, or null if it does not resolve. Never throws — a lookup failure
/// and a name that simply has no address are the same thing to the person at the door, and
/// neither is a reason to break the page.
///
/// Both records are fetched together and the Base-specific one wins. Most names have only the
/// default (checked: `vitalik.eth` has no Base record, `jesse.base.eth` does), so asking for them
/// in sequence would add a round trip for almost everybody to benefit almost nobody.
export async function resolveEnsName(name: string): Promise<Address | null> {
    const normalized = name.trim().toLowerCase();
    try {
        const [baseSpecific, fallback] = await Promise.all([
            ensClient.getEnsAddress({name: normalized, coinType: BASE_COIN_TYPE}).catch(() => null),
            ensClient.getEnsAddress({name: normalized}).catch(() => null),
        ]);
        return ((baseSpecific ?? fallback) as Address | null) ?? null;
    } catch {
        return null;
    }
}
