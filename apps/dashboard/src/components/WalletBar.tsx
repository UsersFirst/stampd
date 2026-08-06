import {useAccount, useConnect, useDisconnect, useChainId, useSwitchChain} from "wagmi";
import {CHAIN_IDS, isDeployedOn} from "@stampd/shared";
import {Logo} from "./Logo";

function truncate(address: string): string {
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletBar() {
    const {address, isConnected} = useAccount();
    const {connect, connectors, isPending} = useConnect();
    const {disconnect} = useDisconnect();
    const chainId = useChainId();
    const {switchChain} = useSwitchChain();

    return (
        <header className="wallet-bar">
            <div className="brand">
                <Logo variant="mark" width={30} className="brand-logo" />
                <span className="brand-mark">stampd</span>
                <span className="brand-sub">organizer</span>
            </div>

            <div className="wallet-actions">
                {/* Keyed on "is the contract deployed here", not "is this chain known". Base
                    mainnet is a chain we support in principle and have deployed nothing to, and
                    treating it as fine is what let an organizer sign an upload there. */}
                {isConnected && !isDeployedOn(chainId) && (
                    <button className="btn btn-warn" onClick={() => switchChain({chainId: CHAIN_IDS.baseSepolia})}>
                        Switch to Base Sepolia
                    </button>
                )}

                {isConnected ? (
                    <>
                        <span className="chip">{chainId === CHAIN_IDS.base ? "Base" : "Base Sepolia"}</span>
                        <span className="chip mono">{address ? truncate(address) : ""}</span>
                        <button className="btn btn-ghost" onClick={() => disconnect()}>
                            Disconnect
                        </button>
                    </>
                ) : (
                    connectors.map((connector) => (
                        <button
                            key={connector.uid}
                            className="btn"
                            disabled={isPending}
                            onClick={() => connect({connector})}
                        >
                            {connector.name}
                        </button>
                    ))
                )}
            </div>
        </header>
    );
}
