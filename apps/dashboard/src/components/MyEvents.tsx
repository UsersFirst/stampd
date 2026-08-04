import {useAccount, useChainId, useReadContract, useReadContracts} from "wagmi";
import {stampd1155Abi, stampdAddress} from "@stampd/shared";

interface EventRow {
    id: bigint;
    organizer: string;
    signer: string;
    startsAt: bigint;
    endsAt: bigint;
    maxSupply: number;
    minted: number;
    transferable: boolean;
    frozen: boolean;
}

function formatWindow(startsAt: bigint, endsAt: bigint): string {
    const open = startsAt === 0n ? "now" : new Date(Number(startsAt) * 1000).toLocaleString();
    const close = endsAt === 0n ? "no end" : new Date(Number(endsAt) * 1000).toLocaleString();
    return `${open} → ${close}`;
}

export function MyEvents() {
    const {address} = useAccount();
    const chainId = useChainId();

    let contractAddress: `0x${string}` | null = null;
    try {
        contractAddress = stampdAddress(chainId);
    } catch {
        contractAddress = null;
    }

    const {data: eventCount} = useReadContract({
        abi: stampd1155Abi,
        address: contractAddress ?? undefined,
        functionName: "eventCount",
        query: {enabled: Boolean(contractAddress)},
    });

    const ids = eventCount ? Array.from({length: Number(eventCount)}, (_, i) => BigInt(i + 1)) : [];

    const {data: events} = useReadContracts({
        contracts: ids.map((id) => ({
            abi: stampd1155Abi,
            address: contractAddress ?? undefined,
            functionName: "getEvent" as const,
            args: [id] as const,
        })),
        query: {enabled: ids.length > 0},
    });

    if (!contractAddress) {
        return (
            <section className="card">
                <h2>Your events</h2>
                <p className="muted">
                    Stampd1155 is not deployed on this chain yet. Deploy it, then add the address to
                    <code> packages/shared/src/chains.ts</code>.
                </p>
            </section>
        );
    }

    const mine: EventRow[] = (events ?? [])
        .map((result, index) => {
            if (result.status !== "success") return null;
            const ev = result.result as unknown as EventRow;
            return {...ev, id: ids[index]};
        })
        .filter((row): row is EventRow => row !== null)
        .filter((row) => address && row.organizer.toLowerCase() === address.toLowerCase());

    return (
        <section className="card">
            <h2>Your events</h2>
            {mine.length === 0 ? (
                <p className="muted">Nothing yet. Create an event above and it will show up here.</p>
            ) : (
                <table className="events">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Claimed</th>
                            <th>Window</th>
                            <th>Bound</th>
                            <th>Metadata</th>
                        </tr>
                    </thead>
                    <tbody>
                        {mine.map((row) => (
                            <tr key={row.id.toString()}>
                                <td className="mono">{row.id.toString()}</td>
                                <td>
                                    {row.minted}
                                    {row.maxSupply > 0 ? ` / ${row.maxSupply}` : ""}
                                </td>
                                <td className="small">{formatWindow(row.startsAt, row.endsAt)}</td>
                                <td>{row.transferable ? "transferable" : "soulbound"}</td>
                                <td>{row.frozen ? "frozen" : "editable"}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </section>
    );
}
