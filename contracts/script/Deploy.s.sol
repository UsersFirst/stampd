// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Stampd1155} from "../src/Stampd1155.sol";

/// @notice Deploys Stampd1155 through the deterministic CREATE2 factory, so the contract has the
///         same address on Base Sepolia and Base mainnet. That keeps one address in the docs, the
///         front-end config, and every QR code, regardless of which chain an event lives on.
/// @dev The constructor takes no arguments, so the init code — and therefore the address — is
///      identical across chains for a given salt.
///
///      forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
contract Deploy is Script {
    bytes32 internal constant SALT = keccak256("stampd.v1");

    function run() external returns (Stampd1155 stampd) {
        address predicted = vm.computeCreate2Address(SALT, keccak256(type(Stampd1155).creationCode));

        if (predicted.code.length > 0) {
            console2.log("Already deployed on chain", block.chainid);
            console2.log("  address", predicted);
            return Stampd1155(predicted);
        }

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        stampd = new Stampd1155{salt: SALT}();
        vm.stopBroadcast();

        require(address(stampd) == predicted, "CREATE2 address mismatch");

        console2.log("Stampd1155 deployed");
        console2.log("  chain  ", block.chainid);
        console2.log("  address", address(stampd));
        console2.log("Run `pnpm sync:deployment` to write this into packages/shared.");
    }
}
