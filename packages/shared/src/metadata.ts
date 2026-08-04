import type {Address} from "./chains.js";

/// ERC-1155 metadata for a badge. `image` is whatever URI the art currently lives at:
/// an R2 URL while the event is being edited, an ipfs:// CID once the organizer freezes it.
export interface BadgeMetadata {
    name: string;
    description: string;
    image: string;
    external_url?: string;
    attributes?: Array<{trait_type: string; value: string | number}>;
}

/// Mirrors Stampd1155.EventConfig.
export interface EventConfigInput {
    signer: Address;
    startsAt: bigint;
    endsAt: bigint;
    maxSupply: number;
    transferable: boolean;
    uri: string;
}

/// What the organizer fills in on the dashboard, before it is split into
/// on-chain config and off-chain metadata.
export interface EventDraft {
    name: string;
    description: string;
    imageUrl: string;
    signer: Address;
    startsAt: Date | null;
    endsAt: Date | null;
    maxSupply: number;
    transferable: boolean;
}

export function buildBadgeMetadata(draft: EventDraft): BadgeMetadata {
    const attributes: BadgeMetadata["attributes"] = [
        {trait_type: "Transferable", value: draft.transferable ? "Yes" : "No"},
    ];
    if (draft.startsAt) {
        attributes.push({trait_type: "Claim opens", value: draft.startsAt.toISOString()});
    }
    if (draft.endsAt) {
        attributes.push({trait_type: "Claim closes", value: draft.endsAt.toISOString()});
    }
    return {
        name: draft.name,
        description: draft.description,
        image: draft.imageUrl,
        attributes,
    };
}

/// `0` is the contract's sentinel for "no bound" on all three of these fields.
export function toEventConfig(draft: EventDraft, metadataUri: string): EventConfigInput {
    return {
        signer: draft.signer,
        startsAt: draft.startsAt ? BigInt(Math.floor(draft.startsAt.getTime() / 1000)) : 0n,
        endsAt: draft.endsAt ? BigInt(Math.floor(draft.endsAt.getTime() / 1000)) : 0n,
        maxSupply: draft.maxSupply,
        transferable: draft.transferable,
        uri: metadataUri,
    };
}

/// Gateway URL for display purposes only. On-chain we always store the ipfs:// form.
export function resolveMediaUrl(uri: string, gateway = "https://ipfs.io/ipfs/"): string {
    return uri.startsWith("ipfs://") ? gateway + uri.slice("ipfs://".length) : uri;
}
