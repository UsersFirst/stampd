import {getAddress} from "viem";
import type {Address} from "@stampd/shared";

/// Wallets do not agree on how to encode a receive address in a QR code. Observed in the wild:
///
///   0x1234…                              bare address (most hardware wallets, Rainbow)
///   ethereum:0x1234…                     EIP-831
///   ethereum:0x1234…@84532               EIP-681 with a chain id
///   ethereum:0x1234…@84532/transfer?…    EIP-681 with a function call
///   ethereum:pay-0x1234…@84532           EIP-681 "pay-" prefix
///
/// An organizer holding up a phone at an event cannot be asked which of these their attendee's
/// wallet produces, so accept all of them.
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/// Extracts a wallet address from a scanned QR payload, or null if it isn't one.
///
/// Deliberately ignores any chain id in an EIP-681 payload. It describes the chain the attendee's
/// wallet happened to be showing, not where the badge is going, and rejecting a scan because
/// someone's wallet was open on mainnet would be a confusing failure at a busy door.
export function parseWalletAddress(payload: string): Address | null {
    let candidate = payload.trim();

    if (candidate.toLowerCase().startsWith("ethereum:")) {
        candidate = candidate.slice("ethereum:".length);
    }
    if (candidate.toLowerCase().startsWith("pay-")) {
        candidate = candidate.slice("pay-".length);
    }

    // Everything from the chain-id, path, or query separator onwards is not part of the address.
    candidate = candidate.split(/[@/?#]/)[0].trim();

    if (!ADDRESS_PATTERN.test(candidate)) return null;

    // A mixed-case address carries EIP-55 checksum information; a uniformly-cased one carries
    // none. Where a checksum exists, verify it by recomputing and comparing — `getAddress` only
    // *computes* the checksummed form and will happily "fix" a corrupted address rather than
    // reject it, which would silently turn a misread into a valid-looking recipient.
    //
    // Worth being strict about: badges are soulbound, so a badge minted to a mistyped address is
    // stuck there permanently. Asking an attendee to hold their phone up again is the cheaper
    // failure by a wide margin.
    const isMixedCase = candidate !== candidate.toLowerCase() && candidate !== candidate.toUpperCase();

    try {
        const checksummed = getAddress(candidate.toLowerCase());
        if (isMixedCase && checksummed !== candidate) return null;
        return checksummed as Address;
    } catch {
        return null;
    }
}

/// Short display form. Full addresses are unreadable in a list on a phone, and an organizer
/// checking a scan against an attendee's screen compares the ends, not the middle.
export function shortAddress(address: string): string {
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
