import deployments from "./deployments.json";

export type Address = `0x${string}`;

export const CHAIN_IDS = {
    base: 8453,
    baseSepolia: 84532,
} as const;

export type StampdChainId = (typeof CHAIN_IDS)[keyof typeof CHAIN_IDS];

export interface StampdDeployment {
    address: Address;
    /// Block the contract was deployed in, so log queries have a floor. Public RPCs refuse a
    /// scan from genesis, and guessing a range either misses events or times out.
    deployedAtBlock: number | null;
}

/// Written by `pnpm sync:deployment` from the Foundry broadcast log. Keyed by chain id.
/// Stampd1155 is deployed through CREATE2, so the address is the same on every chain — but the
/// block it landed in is not, which is why this is a record rather than a bare address.
export const STAMPD_DEPLOYMENTS = deployments as Record<string, StampdDeployment | undefined>;

export function stampdDeployment(chainId: number): StampdDeployment | undefined {
    return STAMPD_DEPLOYMENTS[String(chainId)];
}

export function stampdAddress(chainId: number): Address {
    const address = STAMPD_DEPLOYMENTS[String(chainId)]?.address;
    if (!address) {
        throw new Error(
            `Stampd1155 is not deployed on chain ${chainId}. ` +
                `Deploy it with contracts/script/Deploy.s.sol, then run \`pnpm sync:deployment\`.`,
        );
    }
    return address;
}

export function isDeployedOn(chainId: number | undefined): boolean {
    return chainId !== undefined && Boolean(STAMPD_DEPLOYMENTS[String(chainId)]?.address);
}

/// Explorer base URL for a chain, so a transaction hash can be made clickable.
export function explorerBaseUrl(chainId: number): string {
    return chainId === CHAIN_IDS.base ? "https://basescan.org" : "https://sepolia.basescan.org";
}

export function isSupportedChain(chainId: number | undefined): chainId is StampdChainId {
    return chainId !== undefined && Object.values(CHAIN_IDS).includes(chainId as StampdChainId);
}
