import {useAccount} from "wagmi";
import {WalletBar} from "./components/WalletBar";
import {CreateEventForm} from "./components/CreateEventForm";
import {MyEvents} from "./components/MyEvents";

export function App() {
    const {isConnected} = useAccount();

    return (
        <div className="shell">
            <WalletBar />

            <main>
                {isConnected ? (
                    <>
                        <CreateEventForm />
                        <MyEvents />
                    </>
                ) : (
                    <section className="card empty">
                        <h1>Proof you were there.</h1>
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
