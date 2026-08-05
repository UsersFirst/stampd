import {useChainId, useReadContract, useReadContracts} from "wagmi";
import type {ReadContractReturnType} from "viem";
import {stampd1155Abi, stampdAddress, isDeployedOn, type Address} from "@stampd/shared";

/// Derived from the ABI rather than hand-written, so renaming or reordering a field in
/// `Stampd1155.EventData` breaks the build here instead of silently misreading at runtime.
type EventData = ReadContractReturnType<typeof stampd1155Abi, "getEvent">;

export type EventRow = EventData & {id: bigint};

export interface UseEventsResult {
    contractAddress: Address | null;
    events: EventRow[];
    isLoading: boolean;
}

/// Reads every event on the contract.
///
/// Event creation is permissionless, so this grows without bound and is a known scale problem —
/// see issue #1 item 5, which calls for `getLogs` on `EventCreated` filtered by the indexed
/// organizer topic. Kept in one place so that fix lands once rather than per component.
export function useEvents(): UseEventsResult {
    const chainId = useChainId();
    const contractAddress = isDeployedOn(chainId) ? stampdAddress(chainId) : null;

    const {data: eventCount, isLoading: countLoading} = useReadContract({
        abi: stampd1155Abi,
        address: contractAddress ?? undefined,
        functionName: "eventCount",
        query: {enabled: Boolean(contractAddress)},
    });

    const ids = eventCount ? Array.from({length: Number(eventCount)}, (_, i) => BigInt(i + 1)) : [];

    const {data: results, isLoading: eventsLoading} = useReadContracts({
        contracts: ids.map((id) => ({
            abi: stampd1155Abi,
            address: contractAddress ?? undefined,
            functionName: "getEvent" as const,
            args: [id] as const,
        })),
        query: {enabled: ids.length > 0},
    });

    const events: EventRow[] = (results ?? [])
        .map((result, index) => {
            if (result.status !== "success") return null;
            return {...(result.result as EventData), id: ids[index]};
        })
        .filter((row): row is EventRow => row !== null);

    return {contractAddress, events, isLoading: countLoading || eventsLoading};
}

/// Events the given wallet may actually issue badges for.
///
/// Filters on `signer`, not `organizer`. `mintBatch` checks `msg.sender == ev.signer`, and the two
/// are only the same address by default — an organizer who set a separate signer, or rotated one,
/// would otherwise be offered events whose mint reverts with `NotEventSigner` after they had
/// already queued a room full of attendees.
export function useSignableEvents(wallet: Address | undefined): UseEventsResult {
    const {contractAddress, events, isLoading} = useEvents();
    return {
        contractAddress,
        events: wallet ? events.filter((e) => e.signer.toLowerCase() === wallet.toLowerCase()) : [],
        isLoading,
    };
}
