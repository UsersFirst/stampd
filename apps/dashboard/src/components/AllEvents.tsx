import {useChainId} from "wagmi";
import {explorerBaseUrl} from "@stampd/shared";
import {useEventLog} from "../hooks/useEventLog";
import {shortAddress} from "../lib/qr";

export function AllEvents() {
    const chainId = useChainId();
    const {data: events, isLoading, isError} = useEventLog();
    const explorer = explorerBaseUrl(chainId);

    if (isLoading) {
        return (
            <section className="card">
                <h2>All events</h2>
                <p className="muted">Reading events from the chain…</p>
            </section>
        );
    }

    if (isError) {
        return (
            <section className="card">
                <h2>All events</h2>
                <p className="error">Could not read the event log from this network.</p>
            </section>
        );
    }

    return (
        <section className="card">
            <h2>All events</h2>
            <p className="muted">
                Every event on the contract, whoever created it — event creation is permissionless, so this is the
                whole collection rather than only yours.
            </p>

            {!events || events.length === 0 ? (
                <p className="muted">No events created yet.</p>
            ) : (
                <ul className="event-cards">
                    {events.map((event) => (
                        <li key={event.id.toString()} className="event-card">
                            {event.image ? (
                                <img className="event-art" src={event.image} alt="" loading="lazy" />
                            ) : (
                                /* The URI is organizer-supplied and may point anywhere. A missing
                                   image is a normal state, not an error worth shouting about. */
                                <div className="event-art event-art-missing muted">no art</div>
                            )}

                            <div className="event-body">
                                <h3>{event.name ?? `Event #${event.id.toString()}`}</h3>

                                <p className="muted small">
                                    {event.createdAt
                                        ? event.createdAt.toLocaleString(undefined, {
                                              dateStyle: "medium",
                                              timeStyle: "short",
                                          })
                                        : "creation time unavailable"}
                                </p>

                                <p className="muted small mono">
                                    #{event.id.toString()} · organizer {shortAddress(event.organizer)}
                                    {event.maxSupply > 0 ? ` · cap ${event.maxSupply}` : " · uncapped"}
                                </p>

                                <a
                                    className="small"
                                    href={`${explorer}/tx/${event.txHash}`}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                >
                                    Created in {shortAddress(event.txHash)} ↗
                                </a>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
