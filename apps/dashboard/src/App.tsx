import {useAccount, useChainId, useSwitchChain} from "wagmi";
import {CHAIN_IDS, isDeployedOn} from "@stampd/shared";
import {Logo} from "./components/Logo";
import {WalletBar} from "./components/WalletBar";
import {CreateEventForm} from "./components/CreateEventForm";
import {MyEvents} from "./components/MyEvents";
import {ScanAndMint} from "./components/ScanAndMint";

export function App() {
    const {isConnected} = useAccount();
    const chainId = useChainId();
    const {switchChain, isPending} = useSwitchChain();

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
                ) : (
                    <>
                        {/* Badging comes first: creating an event happens once, at a desk, while
                            issuing badges happens repeatedly and on a phone at the door. */}
                        <ScanAndMint />
                        <CreateEventForm />
                        <MyEvents />
                    </>
                )}
            </main>

            <footer className="muted small">
                stampd — attendance badges on Base. Contracts are permissionless; this dashboard is a convenience.
            </footer>
        </div>
    );
}
