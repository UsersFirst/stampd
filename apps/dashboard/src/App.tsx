import {useState} from "react";
import {useAccount, useChainId, useSwitchChain} from "wagmi";
import {CHAIN_IDS, isDeployedOn} from "@stampd/shared";
import {Logo} from "./components/Logo";
import {WalletBar} from "./components/WalletBar";
import {CreateEventForm} from "./components/CreateEventForm";
import {MyEvents} from "./components/MyEvents";
import {ScanAndMint} from "./components/ScanAndMint";
import {AllEvents} from "./components/AllEvents";
import {Operator} from "./components/Operator";
import {useEvents} from "./hooks/useEvents";
import {resolveTab, type Tab} from "./lib/tabs";

export function App() {
    const {address, isConnected} = useAccount();
    const chainId = useChainId();
    const {switchChain, isPending} = useSwitchChain();
    const {events, isLoading} = useEvents();

    // Keyed on *signer*, matching what `mintBatch` enforces — being an event's organizer does not
    // let you issue its badges if someone else holds the signing key.
    const canScan = address ? events.some((e) => e.signer.toLowerCase() === address.toLowerCase()) : false;

    const [chosenTab, setChosenTab] = useState<Tab | null>(null);

    // Create event and All events are always available. All events lists the whole contract, so it
    // is useful to someone who has never made one — arguably most useful to them. Only Scan
    // attendee depends on having something to scan against.
    //
    // Derived rather than corrected in an effect, so switching to a wallet with no events cannot
    // leave a tab selected that has nothing behind it.
    const tab = resolveTab(chosenTab, canScan);
    const setTab = setChosenTab;

    const onDeployedChain = isDeployedOn(chainId);

    return (
        <div className="shell">
            <WalletBar />

            <main>
                {isConnected && !onDeployedChain ? (
                    /* Blocking rather than warning. Every action below begins with a wallet
                       signature, and a smart wallet signs a chain-bound signature — so on the
                       wrong network the first upload fails verification no matter what, after the
                       organizer has already approved it. Better to never ask. */
                    <section className="card empty">
                        <Logo variant="lockup" width={200} className="hero-logo" />
                        <h2>Wrong network</h2>
                        <p className="muted">
                            stampd is not deployed on the network your wallet is currently using, so events created
                            here would have nowhere to live.
                        </p>
                        <button
                            className="btn btn-primary"
                            disabled={isPending}
                            onClick={() => switchChain({chainId: CHAIN_IDS.baseSepolia})}
                        >
                            {isPending ? "Switching…" : "Switch to Base Sepolia"}
                        </button>
                    </section>
                ) : (
                    <>
                        {/* Only while disconnected. Everything below is readable without a wallet —
                            All events reads the chain, not the wallet — but nothing can be
                            *created* without one, so say so once and then get out of the way.
                            Rendered above the loading gate because it depends on nothing: a
                            visitor should not stare at a bare "Loading…" with no idea where they
                            have landed. */}
                        {!isConnected && (
                            <section className="card empty">
                                <Logo variant="lockup" width={200} className="hero-logo" />
                                <p className="muted">
                                    Connect the wallet you want to organize from. It will own your events and can
                                    rotate their signing keys.
                                </p>
                            </section>
                        )}

                        {isLoading ? (
                            /* Which tabs exist depends on a contract read. Rendering the bar and
                               then adding a tab to it a moment later reads as a glitch. */
                            <section className="card empty">
                                <p className="muted">Loading events…</p>
                            </section>
                        ) : (
                            <>
                                <nav className="tabs" role="tablist" aria-label="Organizer views">
                                    <button
                                        role="tab"
                                        type="button"
                                        id="tab-create"
                                        aria-selected={tab === "create"}
                                        aria-controls="panel-create"
                                        className={tab === "create" ? "tab active" : "tab"}
                                        onClick={() => setTab("create")}
                                    >
                                        Create event
                                    </button>
                                    {/* Only shown when this wallet signs for something. A Scan tab
                                        that can only say "you have no events" is furniture. */}
                                    {canScan && (
                                        <button
                                            role="tab"
                                            type="button"
                                            id="tab-scan"
                                            aria-selected={tab === "scan"}
                                            aria-controls="panel-scan"
                                            className={tab === "scan" ? "tab active" : "tab"}
                                            onClick={() => setTab("scan")}
                                        >
                                            Scan attendee
                                        </button>
                                    )}
                                    <button
                                        role="tab"
                                        type="button"
                                        id="tab-all"
                                        aria-selected={tab === "all"}
                                        aria-controls="panel-all"
                                        className={tab === "all" ? "tab active" : "tab"}
                                        onClick={() => setTab("all")}
                                    >
                                        All events
                                    </button>
                                    {/* Always present rather than hidden behind a secret URL.
                                        What it protects is enforced by the Worker against a
                                        verified Google identity, so a visible tab leaks nothing
                                        — and an operator should not have to remember a path. */}
                                    <button
                                        role="tab"
                                        type="button"
                                        id="tab-operator"
                                        aria-selected={tab === "operator"}
                                        aria-controls="panel-operator"
                                        className={tab === "operator" ? "tab active" : "tab"}
                                        onClick={() => setTab("operator")}
                                    >
                                        Operator
                                    </button>
                                </nav>

                                {tab === "create" ? (
                                    <div role="tabpanel" id="panel-create" aria-labelledby="tab-create">
                                        <CreateEventForm />
                                    </div>
                                ) : tab === "scan" ? (
                                    <div role="tabpanel" id="panel-scan" aria-labelledby="tab-scan">
                                        <ScanAndMint />
                                        <MyEvents />
                                    </div>
                                ) : tab === "all" ? (
                                    <div role="tabpanel" id="panel-all" aria-labelledby="tab-all">
                                        <AllEvents />
                                    </div>
                                ) : (
                                    <div role="tabpanel" id="panel-operator" aria-labelledby="tab-operator">
                                        <Operator />
                                    </div>
                                )}
                            </>
                        )}
                    </>
                )}
            </main>

            <footer className="muted small">
                stampd — attendance badges on Base. Contracts are permissionless; this dashboard is a convenience.
            </footer>
        </div>
    );
}
