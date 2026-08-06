import {useChainId, usePublicClient} from "wagmi";
import {useQuery} from "@tanstack/react-query";
import {stampd1155Abi, stampdDeployment, type Address} from "@stampd/shared";

export interface LoggedEvent {
    id: bigint;
    organizer: Address;
    signer: Address;
    uri: string;
    maxSupply: number;
    /// When `createEvent` was mined, not the event's own claim window.
    createdAt: Date | null;
    txHash: Address;
    blockNumber: bigint;
    /// From the metadata document at `uri`. Null while loading, or if it could not be read —
    /// the URI is organizer-supplied and may point anywhere, including nowhere.
    name: string | null;
    image: string | null;
}

/// The public Base RPC rejects any `eth_getLogs` spanning more than this: `query exceeds max
/// block range 2000`. Not a viem limit and not tunable from here — the query has to be split.
const MAX_BLOCK_RANGE = 2000n;

/// Ceiling on how far back to walk, so the page cannot fire hundreds of requests as the chain
/// ages. At Base's ~2s blocks this is roughly two days of history, which covers a live event but
/// is emphatically not "all events" once the contract has been around a while. The real fix is
/// indexing `EventCreated` server-side; tracked in #7.
const MAX_WINDOWS = 50;

/// Runs `fn` over `items` with a bounded number in flight. Fifty sequential round trips would be
/// visibly slow, and fifty at once gets rate-limited.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({length: Math.min(limit, items.length)}, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    });
    await Promise.all(workers);
    return results;
}

/// Every event ever created, read from `EventCreated` logs.
///
/// Logs rather than a loop over `eventCount` — that pattern (issue #1 item 5) grows without bound
/// because event creation is permissionless, and costs one RPC round trip per event. One
/// `getLogs` returns the lot, and only logs carry the transaction hash, which is the only way to
/// link an event to the transaction that created it.
export function useEventLog() {
    const chainId = useChainId();
    const client = usePublicClient();
    const deployment = stampdDeployment(chainId);

    return useQuery({
        queryKey: ["event-log", chainId, deployment?.address],
        enabled: Boolean(client && deployment?.address),
        queryFn: async (): Promise<LoggedEvent[]> => {
            if (!client || !deployment?.address) return [];

            const latest = await client.getBlockNumber();
            const floor = deployment.deployedAtBlock ? BigInt(deployment.deployedAtBlock) : 0n;

            // Newest-first, because the window may be cut short and the recent end is the part
            // worth having. Each window is `MAX_BLOCK_RANGE` because the public Base RPC answers
            // anything wider with `query exceeds max block range 2000`.
            const windows: Array<{from: bigint; to: bigint}> = [];
            let cursor = latest;
            while (cursor >= floor && windows.length < MAX_WINDOWS) {
                const from = cursor - MAX_BLOCK_RANGE + 1n;
                windows.push({from: from > floor ? from : floor, to: cursor});
                if (from <= floor) break;
                cursor = from - 1n;
            }

            // `getContractEvents` rather than `getLogs`, so `log.args` is typed from the ABI
            // instead of needing a cast that would silently survive a contract change.
            const batches = await mapWithConcurrency(windows, 8, ({from, to}) =>
                client.getContractEvents({
                    address: deployment.address,
                    abi: stampd1155Abi,
                    eventName: "EventCreated",
                    fromBlock: from,
                    toBlock: to,
                }),
            );
            const logs = batches.flat();

            // One timestamp lookup per distinct block rather than per event, since a batch of
            // events created together shares a block.
            const blocks = new Map<bigint, Promise<bigint>>();
            const timestampOf = (blockNumber: bigint) => {
                if (!blocks.has(blockNumber)) {
                    blocks.set(
                        blockNumber,
                        client.getBlock({blockNumber}).then((b) => b.timestamp),
                    );
                }
                return blocks.get(blockNumber)!;
            };

            const events = await Promise.all(
                logs.map(async (log) => {
                    const args = log.args;

                    let createdAt: Date | null = null;
                    try {
                        createdAt = new Date(Number(await timestampOf(log.blockNumber)) * 1000);
                    } catch {
                        // A missing timestamp is not worth dropping the whole row over.
                    }

                    return {
                        id: args.eventId ?? 0n,
                        organizer: (args.organizer ?? "0x") as Address,
                        signer: (args.signer ?? "0x") as Address,
                        uri: args.uri ?? "",
                        maxSupply: Number(args.maxSupply ?? 0),
                        createdAt,
                        txHash: log.transactionHash as Address,
                        blockNumber: log.blockNumber,
                        name: null as string | null,
                        image: null as string | null,
                    };
                }),
            );

            // Metadata lives off-chain at an organizer-supplied URL. One bad or slow document must
            // not blank the whole table, so each is settled independently and failures degrade to
            // the on-chain id alone.
            const withMetadata = await Promise.all(
                events.map(async (event) => {
                    if (!event.uri) return event;
                    try {
                        const res = await fetch(resolveUri(event.uri), {signal: AbortSignal.timeout(8000)});
                        if (!res.ok) return event;
                        const meta = (await res.json()) as {name?: string; image?: string};
                        return {
                            ...event,
                            name: typeof meta.name === "string" ? meta.name : null,
                            image: typeof meta.image === "string" ? resolveUri(meta.image) : null,
                        };
                    } catch {
                        return event;
                    }
                }),
            );

            return withMetadata.sort((a, b) => Number(b.id - a.id));
        },
    });
}

/// ipfs:// is not fetchable by a browser. Gateway it for display only — the on-chain value is
/// left exactly as the organizer set it.
function resolveUri(uri: string): string {
    return uri.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${uri.slice("ipfs://".length)}` : uri;
}
