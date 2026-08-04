import {http, createConfig} from "wagmi";
import {base, baseSepolia} from "wagmi/chains";
import {coinbaseWallet, injected} from "wagmi/connectors";

// Base Sepolia leads the list so an unconfigured wallet lands on testnet, not mainnet.
export const config = createConfig({
    chains: [baseSepolia, base],
    connectors: [
        coinbaseWallet({appName: "stampd", preference: "all"}),
        injected({shimDisconnect: true}),
    ],
    transports: {
        [baseSepolia.id]: http(),
        [base.id]: http(),
    },
});

declare module "wagmi" {
    interface Register {
        config: typeof config;
    }
}
