#!/usr/bin/env node
// Reads Foundry's broadcast logs and records every Stampd1155 deployment address in
// packages/shared/src/deployments.json, keyed by chain id.
//
//   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
//   pnpm sync:deployment

import {readFileSync, writeFileSync, readdirSync, existsSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const broadcastDir = join(root, "contracts/broadcast/Deploy.s.sol");
const target = join(root, "packages/shared/src/deployments.json");

if (!existsSync(broadcastDir)) {
    console.error(`No broadcast logs at ${broadcastDir}\nDeploy first, with --broadcast.`);
    process.exit(1);
}

const deployments = JSON.parse(readFileSync(target, "utf8"));
let updated = 0;

for (const chainId of readdirSync(broadcastDir)) {
    const runPath = join(broadcastDir, chainId, "run-latest.json");
    if (!existsSync(runPath)) continue;

    const run = JSON.parse(readFileSync(runPath, "utf8"));
    const creation = run.transactions?.find(
        (tx) => tx.contractName === "Stampd1155" && tx.transactionType?.startsWith("CREATE"),
    );
    if (!creation?.contractAddress) continue;

    const address = creation.contractAddress;

    // The deployment block, so log queries have a floor to start from. Without it every
    // `getLogs` would either scan from genesis — which public RPCs refuse — or guess.
    const receipt = run.receipts?.find((r) => r.contractAddress?.toLowerCase() === address.toLowerCase());
    const deployedAtBlock = receipt?.blockNumber ? Number(BigInt(receipt.blockNumber)) : null;

    const existing = deployments[chainId];
    if (existing?.address === address && existing?.deployedAtBlock === deployedAtBlock) {
        console.log(`chain ${chainId}: unchanged (${address})`);
        continue;
    }

    deployments[chainId] = {address, deployedAtBlock};
    updated += 1;
    console.log(`chain ${chainId}: ${address} @ block ${deployedAtBlock ?? "unknown"}`);
}

if (updated > 0) {
    writeFileSync(target, `${JSON.stringify(deployments, null, 2)}\n`);
    console.log(`\nWrote ${updated} deployment(s) to packages/shared/src/deployments.json`);
} else {
    console.log("\nNothing to update.");
}
