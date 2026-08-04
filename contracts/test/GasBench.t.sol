// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Stampd1155} from "../src/Stampd1155.sol";

/// @notice Measures the amortised cost per badge of the host-funded `mintBatch` path against the
///         self-serve `claim` path, so host gas floats can be sized from data.
/// @dev These are **L2 execution gas** numbers only. On Base the L1 data-availability component is
///      a large share of the real bill and scales with calldata size (32 bytes per recipient), so
///      the final per-badge cost must be confirmed with a real Base Sepolia transaction before any
///      figure is quoted to an organizer.
contract GasBenchTest is Test {
    Stampd1155 internal stampd;
    uint256 internal signerPk = 0xA11CE;
    address internal signer;
    address internal organizer = makeAddr("organizer");

    function setUp() public {
        signer = vm.addr(signerPk);
        stampd = new Stampd1155();
        vm.warp(1_800_000_000);
    }

    function _newEvent() internal returns (uint256 id) {
        vm.prank(organizer);
        id = stampd.createEvent(
            Stampd1155.EventConfig({
                signer: signer, startsAt: 0, endsAt: 0, maxSupply: 0, transferable: false, uri: "ipfs://bench"
            })
        );
    }

    function _recipients(uint256 n, uint256 salt) internal pure returns (address[] memory to) {
        to = new address[](n);
        for (uint256 i; i < n; ++i) {
            to[i] = address(uint160(uint256(keccak256(abi.encode(salt, i)))));
        }
    }

    function test_gas_mintBatchAmortisation() public {
        uint256[6] memory sizes = [uint256(1), 10, 25, 50, 100, 200];

        console2.log("--- mintBatch: L2 execution gas ---");
        for (uint256 s; s < sizes.length; ++s) {
            uint256 n = sizes[s];
            uint256 id = _newEvent();
            address[] memory to = _recipients(n, s);

            vm.prank(signer);
            uint256 before = gasleft();
            uint256 minted = stampd.mintBatch(id, to);
            uint256 used = before - gasleft();

            assertEq(minted, n);
            console2.log("batch size", n);
            console2.log("  total gas    ", used);
            console2.log("  gas per badge", used / n);
        }
    }

    function test_gas_singleClaimVoucher() public {
        uint256 id = _newEvent();
        address claimer = makeAddr("claimer");
        Stampd1155.ClaimVoucher memory v = Stampd1155.ClaimVoucher({eventId: id, claimer: claimer, nonce: 1, expiry: 0});

        bytes32 structHash =
            keccak256(abi.encode(stampd.claimVoucherTypehash(), v.eventId, v.claimer, v.nonce, v.expiry));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", stampd.domainSeparator(), structHash));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        bytes memory sig = abi.encodePacked(r, s, vv);

        uint256 before = gasleft();
        stampd.claim(v, sig);
        uint256 used = before - gasleft();

        console2.log("--- claim: L2 execution gas (excludes 4337 bundler/EntryPoint overhead) ---");
        console2.log("  gas per badge", used);
    }

    function test_gas_eventCreation() public {
        uint256 before = gasleft();
        _newEvent();
        uint256 used = before - gasleft();
        console2.log("--- createEvent: L2 execution gas ---");
        console2.log("  gas", used);
    }
}
