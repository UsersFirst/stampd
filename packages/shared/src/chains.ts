import deployments from "./deployments.json";

export type Address = `0x${string}`;

export const CHAIN_IDS = {
    base: 8453,
    baseSepolia: 84532,
} as const;

export type StampdChainId = (typeof CHAIN_IDS)[keyof typeof CHAIN_IDS];

/// Written by `pnpm sync:deployment` from the Foundry broadcast log. Keyed by chain id.
/// Stampd1155 is deployed through CREATE2, so the address is the same on every chain.
export const STAMPD_DEPLOYMENTS = deployments as Record<string, Address | undefined>;

export function stampdAddress(chainId: number): Address {
    const address = STAMPD_DEPLOYMENTS[String(chainId)];
    if (!address) {
        throw new Error(
            `Stampd1155 is not deployed on chain ${chainId}. ` +
                `Deploy it with contracts/script/Deploy.s.sol, then run \`pnpm sync:deployment\`.`,
        );
    }
    return address;
}

export function isDeployedOn(chainId: number | undefined): boolean {
    return chainId !== undefined && Boolean(STAMPD_DEPLOYMENTS[String(chainId)]);
}

export function isSupportedChain(chainId: number | undefined): chainId is StampdChainId {
    return chainId !== undefined && Object.values(CHAIN_IDS).includes(chainId as StampdChainId);
}
