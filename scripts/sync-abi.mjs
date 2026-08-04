#!/usr/bin/env node
// Regenerates packages/shared/src/abi.ts from the Foundry build artifact.
// Run after any change to contracts/src/Stampd1155.sol:  pnpm sync:abi

import {readFileSync, writeFileSync, mkdirSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = join(root, "contracts/out/Stampd1155.sol/Stampd1155.json");
const target = join(root, "packages/shared/src/abi.ts");

let parsed;
try {
    parsed = JSON.parse(readFileSync(artifact, "utf8"));
} catch {
    console.error(`Could not read ${artifact}\nRun \`forge build\` in contracts/ first.`);
    process.exit(1);
}

const banner = [
    "// Generated from contracts/out/Stampd1155.sol/Stampd1155.json by scripts/sync-abi.mjs",
    "// Do not edit by hand; run `pnpm sync:abi` after changing the contract.",
].join("\n");

mkdirSync(dirname(target), {recursive: true});
writeFileSync(target, `${banner}\nexport const stampd1155Abi = ${JSON.stringify(parsed.abi, null, 2)} as const;\n`);

console.log(`Wrote ${parsed.abi.length} ABI entries to packages/shared/src/abi.ts`);
