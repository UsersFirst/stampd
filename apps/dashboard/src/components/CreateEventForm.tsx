import {useState, type FormEvent} from "react";
import {useAccount, useChainId, useWriteContract, useWaitForTransactionReceipt} from "wagmi";
import {
    stampd1155Abi,
    stampdAddress,
    buildBadgeMetadata,
    toEventConfig,
    type Address,
    type EventDraft,
} from "@stampd/shared";
import {uploadImage, uploadMetadata} from "../lib/upload";

type Stage = "idle" | "uploading-art" | "uploading-metadata" | "awaiting-signature" | "confirming" | "done";

const STAGE_LABEL: Record<Stage, string> = {
    idle: "",
    "uploading-art": "Uploading badge art…",
    "uploading-metadata": "Publishing metadata…",
    "awaiting-signature": "Confirm in your wallet…",
    confirming: "Waiting for the transaction to confirm…",
    done: "Event created.",
};

function toDateOrNull(value: string): Date | null {
    return value ? new Date(value) : null;
}

export function CreateEventForm() {
    const {address} = useAccount();
    const chainId = useChainId();
    const {writeContractAsync} = useWriteContract();

    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [maxSupply, setMaxSupply] = useState("0");
    const [startsAt, setStartsAt] = useState("");
    const [endsAt, setEndsAt] = useState("");
    const [transferable, setTransferable] = useState(false);
    const [signer, setSigner] = useState("");

    const [stage, setStage] = useState<Stage>("idle");
    const [error, setError] = useState<string | null>(null);
    const [txHash, setTxHash] = useState<Address | undefined>();

    const {isLoading: isConfirming, isSuccess} = useWaitForTransactionReceipt({hash: txHash});

    function onFileChange(selected: File | null) {
        setFile(selected);
        setPreview((old) => {
            if (old) URL.revokeObjectURL(old);
            return selected ? URL.createObjectURL(selected) : null;
        });
    }

    async function onSubmit(submitEvent: FormEvent) {
        submitEvent.preventDefault();
        setError(null);

        if (!address) return setError("Connect a wallet first.");
        if (!file) return setError("Choose an image for the badge.");

        try {
            setStage("uploading-art");
            const imageUrl = await uploadImage(file);

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
            const metadataUri = await uploadMetadata(buildBadgeMetadata(draft));

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
            setError(caught instanceof Error ? caught.message : String(caught));
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
                    <span>Description</span>
                    <textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={3}
                        maxLength={500}
                    />
                </label>

                <label>
                    <span>Badge art</span>
                    <input
                        type="file"
                        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
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
                        <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                        <small className="muted">Blank means immediately.</small>
                    </label>

                    <label>
                        <span>Claim closes</span>
                        <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
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
                        The key allowed to issue badges for this event. Defaults to your wallet; you can rotate it
                        later if it is ever compromised.
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
                            Off by default. Turning this on lets badges be sold, which is how POAP's proof stopped
                            meaning anything.
                        </small>
                    </span>
                </label>

                <button className="btn btn-primary" type="submit" disabled={busy || !address}>
                    {busy ? "Working…" : "Create event"}
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
