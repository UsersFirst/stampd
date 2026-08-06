import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {useAccount, useChainId, usePublicClient, useWriteContract, useWaitForTransactionReceipt} from "wagmi";
import {useQueryClient} from "@tanstack/react-query";
import {parseEventLogs} from "viem";
import {stampd1155Abi, type Address} from "@stampd/shared";
import {useSignableEvents} from "../hooks/useEvents";
import {useEventNames} from "../hooks/useEventNames";
import {useQrScanner} from "../hooks/useQrScanner";
import {parseWalletAddress, shortAddress} from "../lib/qr";
import {mergeRecipients} from "../lib/batch";
import {looksLikeEnsName, resolveEnsName} from "../lib/ens";

/// Why an address did not become the pending recipient. Each is a different thing to say out loud
/// to the person standing in front of you, so none of them collapse into "invalid".
type Rejection = "not-an-address" | "already-queued" | "already-badged" | "name-not-found";

const REJECTION_LABEL: Record<Rejection, string> = {
    "not-an-address": "That isn't a wallet address or a name.",
    "already-queued": "Already added to this batch.",
    "already-badged": "Already has this badge.",
    "name-not-found": "That name doesn't resolve to an address.",
};

interface Feedback {
    kind: "ready" | "resolving" | Rejection;
    address?: Address;
    /// The name typed, when the address came from resolving one. Shown alongside so the organizer
    /// can check what they typed actually pointed where they expected.
    name?: string;
}

/// The queue outlives a page reload deliberately. A phone that sleeps mid-event, or a tab the OS
/// discards to reclaim memory, must not cost an organizer a batch they cannot rebuild.
function queueStorageKey(chainId: number, eventId: bigint): string {
    return `stampd.scan-queue.${chainId}.${eventId}`;
}

function loadQueue(chainId: number, eventId: bigint): Address[] {
    try {
        const raw = localStorage.getItem(queueStorageKey(chainId, eventId));
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? (parsed.filter((v) => typeof v === "string") as Address[]) : [];
    } catch {
        return [];
    }
}

export function ScanAndMint() {
    const {address} = useAccount();
    const chainId = useChainId();
    const publicClient = usePublicClient();
    const {writeContractAsync} = useWriteContract();
    const queryClient = useQueryClient();

    const {contractAddress, events} = useSignableEvents(address);
    const eventNames = useEventNames(useMemo(() => events.map((e) => e.id), [events]));

    const [eventId, setEventId] = useState<bigint | null>(null);
    const [entry, setEntry] = useState("");
    /// The one attendee in hand. In the default two-step flow this is the whole batch.
    const [pending, setPending] = useState<Address | null>(null);
    /// Only ever filled by the Advanced "Add" button, so an organizer who never opens Advanced
    /// never has to think about a queue existing.
    const [queue, setQueue] = useState<Address[]>([]);
    const [feedback, setFeedback] = useState<Feedback | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [txHash, setTxHash] = useState<Address | undefined>();
    const [isSubmitting, setIsSubmitting] = useState(false);

    /// Guards against a slow name lookup landing after a later one and overwriting it.
    const resolutionToken = useRef(0);

    const selected = useMemo(() => events.find((e) => e.id === eventId) ?? null, [events, eventId]);

    useEffect(() => {
        if (eventId === null && events.length > 0) setEventId(events[events.length - 1].id);
    }, [events, eventId]);

    useEffect(() => {
        if (eventId !== null) setQueue(loadQueue(chainId, eventId));
    }, [chainId, eventId]);

    useEffect(() => {
        if (eventId === null) return;
        localStorage.setItem(queueStorageKey(chainId, eventId), JSON.stringify(queue));
    }, [queue, chainId, eventId]);

    const recipients = useMemo(() => mergeRecipients(queue, pending), [queue, pending]);

    /// Checks eligibility before the badge is issued rather than after. The contract skips
    /// duplicates via `ClaimSkipped` instead of reverting, so a repeat is harmless on-chain — but
    /// telling the organizer at the door beats telling them in a receipt.
    const consider = useCallback(
        async (candidate: Address, name?: string) => {
            if (queue.some((a) => a.toLowerCase() === candidate.toLowerCase())) {
                setPending(null);
                setFeedback({kind: "already-queued", address: candidate, name});
                return;
            }

            if (publicClient && contractAddress && eventId !== null) {
                try {
                    const alreadyBadged = await publicClient.readContract({
                        abi: stampd1155Abi,
                        address: contractAddress,
                        functionName: "claimed",
                        args: [eventId, candidate],
                    });
                    if (alreadyBadged) {
                        setPending(null);
                        setFeedback({kind: "already-badged", address: candidate, name});
                        return;
                    }
                } catch {
                    // A failed read is not a reason to refuse someone standing in front of you.
                    // The contract is the authority and will skip a duplicate anyway.
                }
            }

            setPending(candidate);
            setFeedback({kind: "ready", address: candidate, name});
        },
        [queue, publicClient, contractAddress, eventId],
    );

    const onScan = useCallback(
        (payload: string) => {
            const parsed = parseWalletAddress(payload);
            if (!parsed) {
                setFeedback({kind: "not-an-address"});
                return;
            }
            // Showing the scanned address in the field is what lets an organizer check it against
            // the attendee's screen before issuing anything.
            setEntry(parsed);
            void consider(parsed);
        },
        [consider],
    );

    const scanner = useQrScanner({onScan});

    const {isLoading: isConfirming, isSuccess, data: receipt} = useWaitForTransactionReceipt({hash: txHash});

    // What the contract actually did, rather than what we asked it to do. A recipient can be
    // skipped between queueing and mining — someone claims elsewhere, or the cap fills.
    const skipped = useMemo(() => {
        if (!receipt) return [];
        return parseEventLogs({abi: stampd1155Abi, eventName: "ClaimSkipped", logs: receipt.logs}).map(
            (log) => log.args.recipient,
        );
    }, [receipt]);

    useEffect(() => {
        if (!isSuccess) return;
        setQueue([]);
        setPending(null);
        setEntry("");
        setFeedback(null);
        // Issued counts and remaining supply are stale everywhere on the page until the cached
        // contract reads are dropped.
        void queryClient.invalidateQueries();
    }, [isSuccess, queryClient]);

    function onEntryChange(value: string) {
        setEntry(value);
        // Every keystroke invalidates any lookup still in flight. Without this, a slow resolution
        // for a half-typed name can land after a later one and overwrite the right answer.
        const token = ++resolutionToken.current;

        const parsed = parseWalletAddress(value);
        if (parsed) {
            setPending(null);
            void consider(parsed);
            return;
        }

        if (looksLikeEnsName(value)) {
            const name = value.trim();
            setPending(null);
            setFeedback({kind: "resolving", name});
            void resolveEnsName(name).then((address) => {
                if (token !== resolutionToken.current) return; // superseded while resolving
                if (!address) {
                    setFeedback({kind: "name-not-found", name});
                    return;
                }
                void consider(address, name);
            });
            return;
        }

        setPending(null);
        // Silent while they are still typing; only a completed, wrong value is worth a message.
        if (value.trim().length >= 42) setFeedback({kind: "not-an-address"});
        else setFeedback(null);
    }

    function onAddToQueue() {
        if (!pending) return;
        setQueue((current) => [...current, pending]);
        setPending(null);
        setEntry("");
        setFeedback(null);
    }

    async function onIssue() {
        setError(null);
        if (!contractAddress || eventId === null || recipients.length === 0) return;

        try {
            setIsSubmitting(true);
            scanner.stop();
            const hash = await writeContractAsync({
                abi: stampd1155Abi,
                address: contractAddress,
                functionName: "mintBatch",
                args: [eventId, recipients],
            });
            setTxHash(hash);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setIsSubmitting(false);
        }
    }

    if (!contractAddress) return null;

    if (events.length === 0) {
        return (
            <section className="card">
                <h2>Badge attendees</h2>
                <p className="muted">
                    No events yet that this wallet can issue badges for. Only the event's <em>signer</em> may mint,
                    which defaults to the wallet that created the event.
                </p>
            </section>
        );
    }

    const remaining =
        selected && selected.maxSupply > 0 ? selected.maxSupply - selected.minted : Number.POSITIVE_INFINITY;
    const overCapacity = recipients.length > remaining;
    const now = Math.floor(Date.now() / 1000);
    const notOpenYet = selected ? selected.startsAt !== 0n && now < Number(selected.startsAt) : false;
    const alreadyClosed = selected ? selected.endsAt !== 0n && now > Number(selected.endsAt) : false;
    const windowClosed = notOpenYet || alreadyClosed;
    const busy = isSubmitting || isConfirming;

    return (
        <section className="card">
            <h2>Badge attendees</h2>

            <label>
                <span>Event</span>
                <select
                    value={eventId === null ? "" : eventId.toString()}
                    onChange={(e) => setEventId(BigInt(e.target.value))}
                >
                    {events.map((e) => (
                        <option key={e.id.toString()} value={e.id.toString()}>
                            {/* Name first: it is what an organizer running two events at once
                                actually distinguishes them by. The id stays because it is what
                                appears on-chain and in an explorer, and falls back to carrying
                                the label alone when the metadata cannot be read. */}
                            {eventNames[e.id.toString()]
                                ? `${eventNames[e.id.toString()]} · #${e.id}`
                                : `Event #${e.id}`}
                            {" — "}
                            {e.minted} issued
                            {e.maxSupply > 0 ? ` of ${e.maxSupply}` : ""}
                        </option>
                    ))}
                </select>
            </label>

            {windowClosed && (
                <p className="error">
                    {notOpenYet
                        ? "This event's claim window hasn't opened yet — issuing would revert."
                        : "This event's claim window has closed — issuing would revert."}
                </p>
            )}

            <h3 className="step">1 · Scan, paste, or type the attendee's wallet</h3>

            <label>
                <span className="sr-only">Attendee wallet address or name</span>
                <input
                    className="mono"
                    placeholder="0x… or alice.eth"
                    value={entry}
                    onChange={(e) => onEntryChange(e.target.value)}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                />
            </label>

            <div className="scanner">
                {/* Kept mounted even when idle so the ref exists before `start` needs it. */}
                <video ref={scanner.videoRef} className={scanner.isScanning ? "scan-video live" : "scan-video"} muted />
                {!scanner.isScanning && <div className="scan-placeholder muted">Camera off</div>}
            </div>

            <div className="wallet-actions">
                {scanner.isScanning ? (
                    <button type="button" className="btn btn-ghost" onClick={scanner.stop}>
                        Stop camera
                    </button>
                ) : (
                    <button type="button" className="btn" onClick={() => void scanner.start()} disabled={windowClosed}>
                        Scan QR code
                    </button>
                )}
            </div>

            {scanner.error && <p className="error">{scanner.error}</p>}

            {feedback && (
                <p className={feedback.kind === "ready" || feedback.kind === "resolving" ? "status" : "error"}>
                    {feedback.kind === "resolving"
                        ? `Looking up ${feedback.name}…`
                        : feedback.kind === "ready"
                          ? // Both the name and what it resolved to. A name alone hides where the
                            // badge is actually going, and an address alone loses what was typed.
                            `Ready to issue to ${feedback.name ? `${feedback.name} — ` : ""}${shortAddress(feedback.address!)}`
                          : `${REJECTION_LABEL[feedback.kind]}${feedback.address ? ` (${shortAddress(feedback.address)})` : ""}`}
                </p>
            )}

            {/* Batching is the exception, not the flow. Someone badging one person at a time never
                has to know a queue exists; someone working a line opens this once and stays in it. */}
            <details className="advanced">
                <summary>Advanced — badge several people in one transaction</summary>

                <p className="muted small">
                    Add each attendee to build a batch, then issue them all in a single transaction. Cheaper per
                    badge than issuing one at a time, and one wallet confirmation instead of several.
                </p>

                <button type="button" className="btn" onClick={onAddToQueue} disabled={!pending}>
                    Add to batch
                </button>

                {queue.length === 0 ? (
                    <p className="muted small">Nobody added yet.</p>
                ) : (
                    <ul className="queue">
                        {queue.map((entryAddress) => (
                            <li key={entryAddress}>
                                <span className="mono">{shortAddress(entryAddress)}</span>
                                <button
                                    type="button"
                                    className="btn btn-ghost small"
                                    onClick={() => setQueue((c) => c.filter((a) => a !== entryAddress))}
                                >
                                    Remove
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </details>

            {overCapacity && (
                <p className="error">
                    Only {remaining} badge{remaining === 1 ? "" : "s"} left for this event. The extra{" "}
                    {recipients.length - remaining} would be skipped.
                </p>
            )}

            <h3 className="step">2 · Issue</h3>

            <button
                className="btn btn-primary"
                type="button"
                onClick={() => void onIssue()}
                disabled={recipients.length === 0 || busy || windowClosed}
            >
                {busy ? "Issuing…" : recipients.length > 1 ? `Issue ${recipients.length} badges` : "Issue badge"}
            </button>

            {isConfirming && <p className="status">Waiting for the transaction to confirm…</p>}
            {isSuccess && (
                <p className="status">
                    Done. {skipped.length > 0 ? `${skipped.length} skipped by the contract.` : "Every badge issued."}
                </p>
            )}
            {skipped.length > 0 && (
                <ul className="queue">
                    {skipped.map((who) => (
                        <li key={who} className="muted">
                            <span className="mono">{shortAddress(who)}</span> skipped — already badged, or the cap
                            filled first.
                        </li>
                    ))}
                </ul>
            )}
            {error && <p className="error">{error}</p>}
            {txHash && (
                <p className="muted mono small">
                    tx {txHash.slice(0, 10)}…{txHash.slice(-8)}
                </p>
            )}
        </section>
    );
}
