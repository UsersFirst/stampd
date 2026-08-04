export type Address = `0x${string}`;

export const CHAIN_IDS = {
    base: 8453,
    baseSepolia: 84532,
} as const;

export type StampdChainId = (typeof CHAIN_IDS)[keyof typeof CHAIN_IDS];

/// Populated by contracts/script/Deploy.s.sol after each deployment.
export const STAMPD_DEPLOYMENTS: Partial<Record<number, Address>> = {
    // [CHAIN_IDS.baseSepolia]: "0x...",
    // [CHAIN_IDS.base]: "0x...",
};

export function stampdAddress(chainId: number): Address {
    const address = STAMPD_DEPLOYMENTS[chainId];
    if (!address) {
        throw new Error(
            `Stampd1155 is not deployed on chain ${chainId}. ` +
                `Deploy it and add the address to packages/shared/src/chains.ts.`,
        );
    }
    return address;
}

export function isSupportedChain(chainId: number | undefined): chainId is StampdChainId {
    return chainId !== undefined && Object.values(CHAIN_IDS).includes(chainId as StampdChainId);
}
