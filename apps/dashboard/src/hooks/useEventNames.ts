import {useMemo} from "react";
import {useChainId, useReadContracts} from "wagmi";
import {useQuery} from "@tanstack/react-query";
import {stampd1155Abi, stampdDeployment, resolveMediaUrl} from "@stampd/shared";

/// Event names, keyed by event id as a string.
///
/// Names are not on-chain. `EventData` carries the signer, window and counts; the human-readable
/// name lives in the metadata document that `uri(eventId)` points at, so getting one costs a
/// contract read plus a fetch per event.
///
/// Deliberately not sourced from `useEventLog`, which already parses names out of `EventCreated`.
/// That hook can only see back as far as the RPC block-range walk reaches (#7), so an organizer
/// whose event is older than the window would watch its name vanish from this dropdown while the
/// event itself stayed selectable. Reading `uri` directly has no such horizon.
export function useEventNames(ids: bigint[]): Record<string, string | undefined> {
    const chainId = useChainId();
    const address = stampdDeployment(chainId)?.address;

    // Stable across renders so the queries below are not torn down by a new array identity.
    const key = ids.map((id) => id.toString()).join(",");

    const {data: uris} = useReadContracts({
        contracts: ids.map((id) => ({
            abi: stampd1155Abi,
            address,
            functionName: "uri" as const,
            args: [id] as const,
        })),
        query: {enabled: Boolean(address) && ids.length > 0},
    });

    const uriList = useMemo(
        () => (uris ?? []).map((r) => (r.status === "success" ? (r.result as string) : null)),
        [uris],
    );

    const {data: names} = useQuery({
        queryKey: ["event-names", chainId, key, uriList.join("|")],
        enabled: uriList.some(Boolean),
        // A name does not change unless the organizer rewrites the metadata, which is rare and
        // not worth re-fetching on every mount of the scanner.
        staleTime: 5 * 60 * 1000,
        queryFn: async () => {
            const entries = await Promise.all(
                uriList.map(async (uri, index) => {
                    const id = ids[index]?.toString();
                    if (!uri || !id) return [id ?? "", undefined] as const;
                    try {
                        const res = await fetch(resolveMediaUrl(uri), {signal: AbortSignal.timeout(8000)});
                        if (!res.ok) return [id, undefined] as const;
                        const meta = (await res.json()) as {name?: unknown};
                        return [id, typeof meta.name === "string" && meta.name ? meta.name : undefined] as const;
                    } catch {
                        // The URI is organizer-supplied and may point anywhere, including nowhere.
                        // A missing name falls back to the id rather than breaking the picker.
                        return [id, undefined] as const;
                    }
                }),
            );
            return Object.fromEntries(entries) as Record<string, string | undefined>;
        },
    });

    return names ?? {};
}
