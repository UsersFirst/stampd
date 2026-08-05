import {useAccount} from "wagmi";
import {useEvents} from "../hooks/useEvents";

function formatWindow(startsAt: bigint, endsAt: bigint): string {
    const open = startsAt === 0n ? "now" : new Date(Number(startsAt) * 1000).toLocaleString();
    const close = endsAt === 0n ? "no end" : new Date(Number(endsAt) * 1000).toLocaleString();
    return `${open} → ${close}`;
}

export function MyEvents() {
    const {address} = useAccount();
    const {contractAddress, events} = useEvents();

    if (!contractAddress) {
        return (
            <section className="card">
                <h2>Your events</h2>
                <p className="muted">
                    Stampd1155 is not deployed on this chain yet. Deploy it, then run
                    <code> pnpm sync:deployment</code>.
                </p>
            </section>
        );
    }

    const mine = events.filter((row) => address && row.organizer.toLowerCase() === address.toLowerCase());

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
                            <th>Issued</th>
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
