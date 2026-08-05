import {useAccount} from "wagmi";
import {Logo} from "./components/Logo";
import {WalletBar} from "./components/WalletBar";
import {CreateEventForm} from "./components/CreateEventForm";
import {MyEvents} from "./components/MyEvents";
import {ScanAndMint} from "./components/ScanAndMint";

export function App() {
    const {isConnected} = useAccount();

    return (
        <div className="shell">
            <WalletBar />

            <main>
                {isConnected ? (
                    <>
                        {/* Badging comes first: creating an event happens once, at a desk, while
                            issuing badges happens repeatedly and on a phone at the door. */}
                        <ScanAndMint />
                        <CreateEventForm />
                        <MyEvents />
                    </>
                ) : (
                    <section className="card empty">
                        <Logo variant="lockup" width={200} className="hero-logo" />
                        <p className="muted">
                            Connect the wallet you want to organize from. It will own your events and can rotate
                            their signing keys.
                        </p>
                    </section>
                )}
            </main>

            <footer className="muted small">
                stampd — attendance badges on Base. Contracts are permissionless; this dashboard is a convenience.
            </footer>
        </div>
    );
}
