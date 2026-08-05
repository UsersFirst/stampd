import {useCallback, useEffect, useMemo, useState} from "react";
import {useAccount, useChainId, usePublicClient, useWriteContract, useWaitForTransactionReceipt} from "wagmi";
import {parseEventLogs} from "viem";
import {stampd1155Abi, type Address} from "@stampd/shared";
import {useSignableEvents} from "../hooks/useEvents";
import {useQrScanner} from "../hooks/useQrScanner";
import {parseWalletAddress, shortAddress} from "../lib/qr";

/// Why a scan did not join the queue. Each is a different thing for the organizer to say out loud
/// to the person standing in front of them, so none of them collapse into "invalid".
type Rejection = "not-an-address" | "already-queued" | "already-badged";

const REJECTION_LABEL: Record<Rejection, string> = {
    "not-an-address": "That QR isn't a wallet address.",
    "already-queued": "Already scanned — still in this batch.",
    "already-badged": "Already has this badge.",
};

interface Feedback {
    kind: "queued" | Rejection;
    address?: Address;
    at: number;
}

/// The queue outlives a page reload deliberately. A phone that sleeps mid-event, or a tab the OS
/// discards to reclaim memory, must not cost an organizer a room full of scans they cannot redo.
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

    const {contractAddress, events} = useSignableEvents(address);

    const [eventId, setEventId] = useState<bigint | null>(null);
    const [queue, setQueue] = useState<Address[]>([]);
    const [feedback, setFeedback] = useState<Feedback | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [manual, setManual] = useState("");
    const [txHash, setTxHash] = useState<Address | undefined>();
    const [isSubmitting, setIsSubmitting] = useState(false);

    const selected = useMemo(() => events.find((e) => e.id === eventId) ?? null, [events, eventId]);

    // Default to the organizer's most recent signable event rather than making them choose when
    // there is only ever likely to be one in progress.
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

    /// Checks eligibility before queueing rather than after minting. The contract skips duplicates
    /// via `ClaimSkipped` instead of reverting, so a double scan is harmless on-chain — but it
    /// still costs calldata, and telling the organizer at the door beats telling them in a receipt.
    const considerAddress = useCallback(
        async (candidate: Address) => {
            if (queue.some((a) => a.toLowerCase() === candidate.toLowerCase())) {
                setFeedback({kind: "already-queued", address: candidate, at: Date.now()});
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
                        setFeedback({kind: "already-badged", address: candidate, at: Date.now()});
                        return;
                    }
                } catch {
                    // A failed read is not a reason to refuse someone standing in front of you.
                    // Queue them; the contract is the authority and will skip them if they are a
                    // duplicate.
                }
            }

            setQueue((current) => [...current, candidate]);
            setFeedback({kind: "queued", address: candidate, at: Date.now()});
        },
        [queue, publicClient, contractAddress, eventId],
    );

    const onScan = useCallback(
        (payload: string) => {
            const parsed = parseWalletAddress(payload);
            if (!parsed) {
                setFeedback({kind: "not-an-address", at: Date.now()});
                return;
            }
            void considerAddress(parsed);
        },
        [considerAddress],
    );

    const scanner = useQrScanner({onScan});

    const {isLoading: isConfirming, isSuccess, data: receipt} = useWaitForTransactionReceipt({hash: txHash});

    // What the contract actually did, rather than what we asked it to do. A recipient can be
    // skipped between queueing and mining — someone claims elsewhere, or the cap fills — and
    // reporting the request as the outcome would be a lie the organizer acts on.
    const skipped = useMemo(() => {
        if (!receipt) return [];
        return parseEventLogs({abi: stampd1155Abi, eventName: "ClaimSkipped", logs: receipt.logs}).map(
            (log) => log.args.recipient,
        );
    }, [receipt]);

    useEffect(() => {
        if (isSuccess) setQueue([]);
    }, [isSuccess]);

    async function onMint() {
        setError(null);
        if (!contractAddress || eventId === null || queue.length === 0) return;

        try {
            setIsSubmitting(true);
            scanner.stop();
            const hash = await writeContractAsync({
                abi: stampd1155Abi,
                address: contractAddress,
                functionName: "mintBatch",
                args: [eventId, queue],
            });
            setTxHash(hash);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setIsSubmitting(false);
        }
    }

    function onManualAdd() {
        const parsed = parseWalletAddress(manual);
        if (!parsed) {
            setFeedback({kind: "not-an-address", at: Date.now()});
            return;
        }
        setManual("");
        void considerAddress(parsed);
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
    const overCapacity = queue.length > remaining;
    const now = Math.floor(Date.now() / 1000);
    const notOpenYet = selected ? selected.startsAt !== 0n && now < Number(selected.startsAt) : false;
    const alreadyClosed = selected ? selected.endsAt !== 0n && now > Number(selected.endsAt) : false;
    const windowClosed = notOpenYet || alreadyClosed;

    return (
        <section className="card">
            <h2>Badge attendees</h2>
            <p className="muted">
                Scan each attendee's wallet QR, then issue every badge in one transaction. They pay nothing and
                need no gas.
            </p>

            <label>
                <span>Event</span>
                <select
                    value={eventId === null ? "" : eventId.toString()}
                    onChange={(e) => setEventId(BigInt(e.target.value))}
                >
                    {events.map((e) => (
                        <option key={e.id.toString()} value={e.id.toString()}>
                            #{e.id.toString()} — {e.minted} issued
                            {e.maxSupply > 0 ? ` of ${e.maxSupply}` : ""}
                        </option>
                    ))}
                </select>
            </label>

            {windowClosed && (
                <p className="error">
                    {notOpenYet
                        ? "This event's claim window hasn't opened yet — minting would revert."
                        : "This event's claim window has closed — minting would revert."}
                </p>
            )}

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
                        Start camera
                    </button>
                )}
            </div>

            {scanner.error && <p className="error">{scanner.error}</p>}

            {feedback && (
                <p className={feedback.kind === "queued" ? "status" : "error"}>
                    {feedback.kind === "queued"
                        ? `Queued ${shortAddress(feedback.address!)}`
                        : `${REJECTION_LABEL[feedback.kind]}${feedback.address ? ` (${shortAddress(feedback.address)})` : ""}`}
                </p>
            )}

            <label>
                <span>Or paste an address</span>
                <div className="row">
                    <input
                        className="mono"
                        placeholder="0x…"
                        value={manual}
                        onChange={(e) => setManual(e.target.value)}
                    />
                    <button type="button" className="btn btn-ghost" onClick={onManualAdd} disabled={!manual}>
                        Add
                    </button>
                </div>
                <small className="muted">For attendees whose wallet won't show a QR.</small>
            </label>

            <h3>
                Queue <span className="chip">{queue.length}</span>
            </h3>

            {queue.length === 0 ? (
                <p className="muted">Nobody scanned yet.</p>
            ) : (
                <ul className="queue">
                    {queue.map((entry) => (
                        <li key={entry}>
                            <span className="mono">{shortAddress(entry)}</span>
                            <button
                                type="button"
                                className="btn btn-ghost small"
                                onClick={() => setQueue((c) => c.filter((a) => a !== entry))}
                            >
                                Remove
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {overCapacity && (
                <p className="error">
                    Only {remaining} badge{remaining === 1 ? "" : "s"} left for this event. The extra{" "}
                    {queue.length - remaining} would be skipped.
                </p>
            )}

            <button
                className="btn btn-primary"
                type="button"
                onClick={() => void onMint()}
                disabled={queue.length === 0 || isSubmitting || isConfirming || windowClosed}
            >
                {isSubmitting || isConfirming
                    ? "Issuing…"
                    : `Issue ${queue.length} badge${queue.length === 1 ? "" : "s"}`}
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
