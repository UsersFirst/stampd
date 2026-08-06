import {useCallback, useEffect, useState} from "react";
import {useGoogleAuth} from "../hooks/useGoogleAuth";
import {useEventLog} from "../hooks/useEventLog";
import {apiUrl} from "../lib/api";
import {shortAddress} from "../lib/qr";

/// Shared with the Tandemonium dashboard — one OAuth client with several authorized origins,
/// which is why the id looks nothing like stampd.
///
/// Inline rather than a build-time variable, matching how Tandemonium's dashboard does it. A
/// client id is not a secret: it is embedded in every page that uses it, and it ends up in this
/// bundle either way. Keeping it in the source means a mismatch with the Worker's
/// GOOGLE_CLIENT_ID shows up in a diff instead of hiding in repository settings — which is not
/// hypothetical, since setting the variable alone silently did nothing until the Pages workflow
/// was taught to pass it through.
///
/// Must match `GOOGLE_CLIENT_ID` in apps/api/wrangler.toml. The Worker checks a token's audience
/// against its own copy, so a drift here fails every operator request.
const CLIENT_ID = "640682648249-dp1dou0mmpkm6m697oakbe9odabt1dui.apps.googleusercontent.com";

interface QueueRow {
    sha256: string;
    object_key: string | null;
    attempts: number;
    last_error: string | null;
    submitted_by: string | null;
    checked_at: number;
    awaiting_review: number;
}

interface EventRow {
    sha256: string;
    outcome: string;
    source: string;
    attempt: number;
    reasons: string | null;
    error: string | null;
    reviewed_by: string | null;
    created_at: number;
}

interface ModerationPayload {
    operator: string;
    screening: string;
    queue: QueueRow[];
    recent: EventRow[];
}

function when(seconds: number): string {
    return new Date(seconds * 1000).toLocaleString(undefined, {dateStyle: "short", timeStyle: "short"});
}

export function Operator() {
    const auth = useGoogleAuth(CLIENT_ID);
    const {data: events} = useEventLog();

    const [data, setData] = useState<ModerationPayload | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!auth.token) return;
        setError(null);
        try {
            const res = await fetch(apiUrl("/api/admin/moderation"), {
                headers: {authorization: `Bearer ${auth.token}`},
            });
            if (!res.ok) {
                const body = (await res.json().catch(() => ({}))) as {error?: string};
                throw new Error(body.error ?? `Request failed (${res.status})`);
            }
            setData((await res.json()) as ModerationPayload);
        } catch (caught) {
            setData(null);
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    }, [auth.token]);

    useEffect(() => {
        void load();
    }, [load]);

    async function decide(sha256: string, verdict: "allow" | "reject") {
        if (!auth.token) return;
        setBusy(sha256);
        setError(null);
        try {
            const res = await fetch(apiUrl(`/api/admin/moderation/${sha256}`), {
                method: "POST",
                headers: {authorization: `Bearer ${auth.token}`, "content-type": "application/json"},
                body: JSON.stringify({verdict}),
            });
            if (!res.ok) {
                const body = (await res.json().catch(() => ({}))) as {error?: string};
                throw new Error(body.error ?? `Request failed (${res.status})`);
            }
            await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(null);
        }
    }

    if (!CLIENT_ID) {
        return (
            <section className="card">
                <h2>Operator</h2>
                <p className="muted">
                    Operator access is not configured for this build. Set <code>VITE_GOOGLE_CLIENT_ID</code> and
                    rebuild, and set <code>GOOGLE_CLIENT_ID</code> and <code>OPERATOR_EMAILS</code> on the Worker.
                </p>
            </section>
        );
    }

    return (
        <>
            <section className="card">
                <h2>Operator</h2>
                {auth.token ? (
                    <p className="muted">
                        Signed in as <strong>{auth.email}</strong>{" "}
                        <button type="button" className="btn btn-ghost small" onClick={auth.signOut}>
                            Sign out
                        </button>
                    </p>
                ) : (
                    <>
                        <p className="muted">
                            Sign in to review images that automated screening could not settle. Event data below is
                            public either way — it is read from the chain.
                        </p>
                        {/* Google's own button: their branding terms require it, and it carries
                            the popup and account chooser for free. */}
                        <div ref={auth.buttonRef} />
                        {!auth.isReady && <p className="muted small">Loading Google Sign-In…</p>}
                    </>
                )}
                {auth.error && <p className="error">{auth.error}</p>}
                {error && <p className="error">{error}</p>}
            </section>

            {auth.token && data && (
                <section className="card">
                    <h2>
                        Unscreened images <span className="chip">{data.queue.length}</span>
                    </h2>
                    <p className="muted small">
                        Screening is <strong>{data.screening}</strong>. Images reach this list when Vision could not
                        be reached; those marked <em>awaiting review</em> have exhausted their retries and will not
                        resolve on their own.
                    </p>

                    {data.queue.length === 0 ? (
                        <p className="muted">Nothing unscreened. </p>
                    ) : (
                        <ul className="queue">
                            {data.queue.map((row) => (
                                <li key={row.sha256} className="review-row">
                                    {row.object_key && (
                                        // The point of a human review is looking at the image.
                                        <img
                                            className="event-art"
                                            src={apiUrl(`/api/asset/${row.object_key}`)}
                                            alt=""
                                            loading="lazy"
                                        />
                                    )}
                                    <div className="event-body">
                                        <p className="mono small">{row.sha256.slice(0, 16)}…</p>
                                        <p className="muted small">
                                            {row.awaiting_review ? "awaiting review" : "retrying"} ·{" "}
                                            {row.attempts} attempt{row.attempts === 1 ? "" : "s"} · {when(row.checked_at)}
                                        </p>
                                        {row.submitted_by && (
                                            <p className="muted small mono">from {shortAddress(row.submitted_by)}</p>
                                        )}
                                        {row.last_error && <p className="muted small">{row.last_error}</p>}
                                    </div>
                                    <div className="wallet-actions">
                                        <button
                                            type="button"
                                            className="btn btn-ghost small"
                                            disabled={busy === row.sha256}
                                            onClick={() => void decide(row.sha256, "allow")}
                                        >
                                            Allow
                                        </button>
                                        <button
                                            type="button"
                                            className="btn btn-warn small"
                                            disabled={busy === row.sha256}
                                            onClick={() => void decide(row.sha256, "reject")}
                                        >
                                            Reject
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            )}

            {auth.token && data && (
                <section className="card">
                    <h2>Recent screening decisions</h2>
                    {data.recent.length === 0 ? (
                        <p className="muted">Nothing screened yet.</p>
                    ) : (
                        <table className="events">
                            <thead>
                                <tr>
                                    <th>When</th>
                                    <th>Outcome</th>
                                    <th>Source</th>
                                    <th>Detail</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.recent.map((row, index) => (
                                    <tr key={`${row.sha256}-${row.created_at}-${index}`}>
                                        <td className="small">{when(row.created_at)}</td>
                                        <td>{row.outcome}</td>
                                        <td className="small">
                                            {row.source}
                                            {row.attempt ? ` #${row.attempt}` : ""}
                                        </td>
                                        <td className="small">
                                            {row.reviewed_by ?? row.reasons ?? row.error ?? ""}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </section>
            )}

            <section className="card">
                <h2>
                    Events <span className="chip">{events?.length ?? 0}</span>
                </h2>
                <p className="muted small">
                    Every event on the contract with the badges actually issued for it, read from the chain rather
                    than from our own records — the chain is what attendees hold.
                </p>
                {!events || events.length === 0 ? (
                    <p className="muted">No events yet.</p>
                ) : (
                    <table className="events">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Event</th>
                                <th>Organizer</th>
                                <th>Created</th>
                            </tr>
                        </thead>
                        <tbody>
                            {events.map((event) => (
                                <tr key={event.id.toString()}>
                                    <td className="mono">{event.id.toString()}</td>
                                    <td>{event.name ?? "—"}</td>
                                    <td className="mono small">{shortAddress(event.organizer)}</td>
                                    <td className="small">
                                        {event.createdAt ? event.createdAt.toLocaleDateString() : "—"}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>
        </>
    );
}
