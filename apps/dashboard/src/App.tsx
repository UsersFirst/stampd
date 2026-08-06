import {useState} from "react";
import {useAccount, useChainId, useSwitchChain} from "wagmi";
import {CHAIN_IDS, isDeployedOn} from "@stampd/shared";
import {Logo} from "./components/Logo";
import {WalletBar} from "./components/WalletBar";
import {CreateEventForm} from "./components/CreateEventForm";
import {MyEvents} from "./components/MyEvents";
import {ScanAndMint} from "./components/ScanAndMint";
import {useEvents} from "./hooks/useEvents";

type Tab = "create" | "attendees";

export function App() {
    const {address, isConnected} = useAccount();
    const chainId = useChainId();
    const {switchChain, isPending} = useSwitchChain();
    const {events, isLoading} = useEvents();

    // Organizer *or* signer. Someone who was handed signing duty for another organizer's event
    // has nothing to create but every reason to badge, and hiding the tabs from them would hide
    // the only screen they need.
    const mine = address
        ? events.filter(
              (e) =>
                  e.organizer.toLowerCase() === address.toLowerCase() ||
                  e.signer.toLowerCase() === address.toLowerCase(),
          )
        : [];

    // Defaults to badging. Creating an event happens once, at a desk; badging happens repeatedly
    // and is what someone opening this on a phone at a door came to do.
    const [tab, setTab] = useState<Tab>("attendees");

    const onDeployedChain = isDeployedOn(chainId);

    return (
        <div className="shell">
            <WalletBar />

            <main>
                {!isConnected ? (
                    <section className="card empty">
                        <Logo variant="lockup" width={200} className="hero-logo" />
                        <p className="muted">
                            Connect the wallet you want to organize from. It will own your events and can rotate
                            their signing keys.
                        </p>
                    </section>
                ) : !onDeployedChain ? (
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
                ) : isLoading ? (
                    /* Whether the tabs belong here depends on a contract read. Rendering the
                       untabbed form first and swapping it for tabs a moment later reads as a
                       glitch, so wait rather than guess. */
                    <section className="card empty">
                        <p className="muted">Loading your events…</p>
                    </section>
                ) : mine.length === 0 ? (
                    /* Nothing to put behind an Attendees tab yet, and a tab bar with one usable
                       side is just furniture. The tabs appear with the first event. */
                    <CreateEventForm />
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
                            <button
                                role="tab"
                                type="button"
                                id="tab-attendees"
                                aria-selected={tab === "attendees"}
                                aria-controls="panel-attendees"
                                className={tab === "attendees" ? "tab active" : "tab"}
                                onClick={() => setTab("attendees")}
                            >
                                Attendees
                            </button>
                        </nav>

                        {tab === "create" ? (
                            <div role="tabpanel" id="panel-create" aria-labelledby="tab-create">
                                <CreateEventForm />
                            </div>
                        ) : (
                            <div role="tabpanel" id="panel-attendees" aria-labelledby="tab-attendees">
                                <ScanAndMint />
                                <MyEvents />
                            </div>
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
