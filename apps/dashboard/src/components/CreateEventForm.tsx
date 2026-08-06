import {useEffect, useState, type FormEvent} from "react";
import {useQueryClient} from "@tanstack/react-query";
import {useAccount, useChainId, useSignMessage, useWriteContract, useWaitForTransactionReceipt} from "wagmi";
import {isAddress} from "viem";
import {
    stampd1155Abi,
    stampdAddress,
    buildBadgeMetadata,
    toEventConfig,
    type Address,
    type EventDraft,
} from "@stampd/shared";
import {prepareImage, uploadPreparedImage, uploadMetadata, type PreparedUpload} from "../lib/upload";

type Stage = "idle" | "uploading-art" | "uploading-metadata" | "awaiting-signature" | "confirming" | "done";

const STAGE_LABEL: Record<Stage, string> = {
    idle: "",
    "uploading-art": "Sign to upload the badge art…",
    "uploading-metadata": "Sign to publish the metadata…",
    "awaiting-signature": "Confirm in your wallet…",
    confirming: "Waiting for the transaction to confirm…",
    done: "Event created.",
};

function toDateOrNull(value: string): Date | null {
    return value ? new Date(value) : null;
}

/// A wallet that signs in a popup reports a blocked popup as an unreachable `window.opener`,
/// which reads as a fault in the app rather than something the browser did and the organizer can
/// undo. Name the actual remedy — the raw text sends people to look in the wrong place.
function describeFailure(caught: unknown): string {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (/opener|popup|pop-up/i.test(message)) {
        return (
            "Your browser blocked the wallet window. Allow pop-ups for this site and try again — " +
            "on iOS, tap the address bar and choose to allow."
        );
    }
    return message;
}

export function CreateEventForm() {
    const {address} = useAccount();
    const chainId = useChainId();
    const {writeContractAsync} = useWriteContract();
    const {signMessageAsync} = useSignMessage();
    const queryClient = useQueryClient();

    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    /// Read and hashed as soon as the file is chosen, so submitting can reach the wallet without
    /// awaiting anything — see `prepareImage`.
    const [prepared, setPrepared] = useState<PreparedUpload | null>(null);
    const [maxSupply, setMaxSupply] = useState("0");
    const [startsAt, setStartsAt] = useState("");
    const [endsAt, setEndsAt] = useState("");
    const [transferable, setTransferable] = useState(false);
    const [signer, setSigner] = useState("");

    const [stage, setStage] = useState<Stage>("idle");
    const [error, setError] = useState<string | null>(null);
    const [txHash, setTxHash] = useState<Address | undefined>();

    const {isLoading: isConfirming, isSuccess} = useWaitForTransactionReceipt({hash: txHash});

    // `stage` is what gates the submit button, and the receipt arrives outside the submit handler,
    // so without this the form sits on "Working…" forever after the event has already been
    // created. The status text alone said "Event created." while the button stayed disabled.
    useEffect(() => {
        if (!isSuccess) return;
        setStage("done");
        // The event exists now but every list below is showing a cached read from before it did.
        void queryClient.invalidateQueries();
    }, [isSuccess, queryClient]);

    // Revoking in the cleanup covers unmount as well as replacement — navigating away mid-edit
    // was leaking the object URL for whatever art was selected. Closes item 8 of #1.
    useEffect(() => {
        if (!preview) return;
        return () => URL.revokeObjectURL(preview);
    }, [preview]);

    function onFileChange(selected: File | null) {
        setFile(selected);
        setPreview(selected ? URL.createObjectURL(selected) : null);
        setPrepared(null);
        if (!selected) return;
        // Errors are surfaced on submit rather than here; a file too large should not clear
        // itself out from under someone mid-form.
        void prepareImage(selected)
            .then(setPrepared)
            .catch(() => setPrepared(null));
    }

    async function onSubmit(submitEvent: FormEvent) {
        submitEvent.preventDefault();
        setError(null);

        if (!address) return setError("Connect a wallet first.");
        if (!file) return setError("Choose an image for the badge.");

        // A mistyped-but-valid address would create an event nobody can issue badges for,
        // recoverable only by rotating the signer afterwards. Catch it here instead.
        if (signer && !isAddress(signer)) {
            return setError("Event signer is not a valid address.");
        }

        const uploadCtx = {
            address,
            chainId,
            signMessage: (message: string) => signMessageAsync({message}),
        };

        if (!prepared) return setError("Still reading the image — try again in a moment.");

        try {
            setStage("uploading-art");
            // First await in the handler, so the wallet popup opens while the tap is still
            // active. Anything awaited before this costs the browser's transient activation and
            // Safari blocks the popup.
            const imageUrl = await uploadPreparedImage(prepared, uploadCtx);

            const draft: EventDraft = {
                name,
                description,
                imageUrl,
                // Defaults to the organizer's own wallet. Phase 3 replaces this with a dedicated
                // per-event key held by the Worker, which signs vouchers and submits batches.
                signer: (signer || address) as Address,
                startsAt: toDateOrNull(startsAt),
                endsAt: toDateOrNull(endsAt),
                maxSupply: Number(maxSupply) || 0,
                transferable,
            };

            setStage("uploading-metadata");
            const metadataUri = await uploadMetadata(buildBadgeMetadata(draft), uploadCtx);

            setStage("awaiting-signature");
            const config = toEventConfig(draft, metadataUri);
            const hash = await writeContractAsync({
                abi: stampd1155Abi,
                address: stampdAddress(chainId),
                functionName: "createEvent",
                args: [config],
            });

            setTxHash(hash);
            setStage("confirming");
        } catch (caught) {
            setStage("idle");
            setError(describeFailure(caught));
        }
    }

    const busy = stage !== "idle" && stage !== "done";
    const status = isSuccess ? STAGE_LABEL.done : isConfirming ? STAGE_LABEL.confirming : STAGE_LABEL[stage];

    return (
        <section className="card">
            <h2>Create an event</h2>
            <p className="muted">
                Badges are non-transferable by default, so holding one means the attendee was actually there.
            </p>

            <form onSubmit={onSubmit} className="form">
                <label>
                    <span>Event name</span>
                    <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
                </label>

                <label>
                    <span>Badge art</span>
                    <input
                        type="file"
                        accept="image/png,image/jpeg,image/gif,image/webp"
                        onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
                        required
                    />
                </label>

                {preview && (
                    <div className="preview">
                        <img src={preview} alt="Badge preview" />
                        <span className="muted">This is what attendees will hold.</span>
                    </div>
                )}

                {/* A native <details> rather than state: it is keyboard accessible and
                    findable by in-page search for free, and every field inside has a working
                    default, so an organizer who never opens it still gets a valid event. */}
                <details className="advanced">
                    <summary>Advanced</summary>

                    <label>
                        <span>Description</span>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={3}
                            maxLength={500}
                        />
                    </label>

                    <div className="row">
                        <label>
                            <span>Max badges</span>
                            <input
                                type="number"
                                min={0}
                                value={maxSupply}
                                onChange={(e) => setMaxSupply(e.target.value)}
                            />
                            <small className="muted">0 means unlimited.</small>
                        </label>

                        <label>
                            <span>Claim opens</span>
                            <input
                                type="datetime-local"
                                value={startsAt}
                                onChange={(e) => setStartsAt(e.target.value)}
                            />
                            <small className="muted">Blank means immediately.</small>
                        </label>

                        <label>
                            <span>Claim closes</span>
                            <input
                                type="datetime-local"
                                value={endsAt}
                                onChange={(e) => setEndsAt(e.target.value)}
                            />
                            <small className="muted">Blank means never.</small>
                        </label>
                    </div>

                    <label>
                        <span>Event signer</span>
                        <input
                            className="mono"
                            placeholder={address ?? "0x…"}
                            value={signer}
                            onChange={(e) => setSigner(e.target.value)}
                        />
                        <small className="muted">
                            The key allowed to issue badges for this event. Defaults to your wallet; you can rotate
                            it later if it is ever compromised.
                        </small>
                    </label>

                    <label className="checkbox">
                        <input
                            type="checkbox"
                            checked={transferable}
                            onChange={(e) => setTransferable(e.target.checked)}
                        />
                        <span>
                            Allow attendees to transfer badges
                            <small className="muted">
                                Off by default. Turning this on lets badges be sold, which is how POAP's proof
                                stopped meaning anything.
                            </small>
                        </span>
                    </label>
                </details>

                <button className="btn btn-primary" type="submit" disabled={busy || !address}>
                    {busy ? "Working…" : stage === "done" ? "Create another event" : "Create event"}
                </button>

                {status && <p className="status">{status}</p>}
                {error && <p className="error">{error}</p>}
                {txHash && (
                    <p className="muted mono small">
                        tx {txHash.slice(0, 10)}…{txHash.slice(-8)}
                    </p>
                )}
            </form>
        </section>
    );
}
