// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Stampd1155} from "../src/Stampd1155.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

contract Stampd1155Test is Test {
    Stampd1155 internal stampd;

    uint256 internal signerPk = 0xA11CE;
    address internal signer;
    address internal organizer = makeAddr("organizer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal relayer = makeAddr("relayer");

    uint64 internal constant T0 = 1_800_000_000;
    string internal constant URI = "ipfs://bafyEventOne";

    function setUp() public {
        signer = vm.addr(signerPk);
        stampd = new Stampd1155();
        vm.warp(T0);
    }

    /* ------------------------------------------------------------------ */
    /*                              HELPERS                                */
    /* ------------------------------------------------------------------ */

    function _defaultConfig() internal view returns (Stampd1155.EventConfig memory) {
        return
            Stampd1155.EventConfig({
                signer: signer, startsAt: 0, endsAt: 0, maxSupply: 0, transferable: false, uri: URI
            });
    }

    function _createEvent(Stampd1155.EventConfig memory cfg) internal returns (uint256 id) {
        vm.prank(organizer);
        id = stampd.createEvent(cfg);
    }

    function _createDefaultEvent() internal returns (uint256) {
        return _createEvent(_defaultConfig());
    }

    function _voucher(uint256 eventId, address claimer, uint256 nonce, uint64 expiry)
        internal
        pure
        returns (Stampd1155.ClaimVoucher memory)
    {
        return Stampd1155.ClaimVoucher({eventId: eventId, claimer: claimer, nonce: nonce, expiry: expiry});
    }

    function _sign(uint256 pk, Stampd1155.ClaimVoucher memory v) internal view returns (bytes memory) {
        bytes32 structHash =
            keccak256(abi.encode(stampd.claimVoucherTypehash(), v.eventId, v.claimer, v.nonce, v.expiry));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", stampd.domainSeparator(), structHash));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, vv);
    }

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    /* ------------------------------------------------------------------ */
    /*                          EVENT CREATION                             */
    /* ------------------------------------------------------------------ */

    function test_createEvent_isOneIndexedAndStoresConfig() public {
        uint256 id = _createDefaultEvent();
        assertEq(id, 1, "event ids start at 1");
        assertEq(stampd.eventCount(), 1);

        Stampd1155.EventData memory ev = stampd.getEvent(id);
        assertEq(ev.organizer, organizer);
        assertEq(ev.signer, signer);
        assertEq(ev.minted, 0);
        assertFalse(ev.transferable);
        assertFalse(ev.frozen);
        assertEq(stampd.uri(id), URI);
        assertTrue(stampd.exists(id));
    }

    function test_createEvent_isPermissionless() public {
        Stampd1155.EventConfig memory cfg = _defaultConfig();
        vm.prank(alice);
        uint256 id = stampd.createEvent(cfg);
        assertEq(stampd.getEvent(id).organizer, alice);
    }

    function test_createEvent_revertsOnZeroSigner() public {
        Stampd1155.EventConfig memory cfg = _defaultConfig();
        cfg.signer = address(0);
        vm.expectRevert(Stampd1155.ZeroSigner.selector);
        vm.prank(organizer);
        stampd.createEvent(cfg);
    }

    function test_createEvent_revertsOnInvertedWindow() public {
        Stampd1155.EventConfig memory cfg = _defaultConfig();
        cfg.startsAt = T0 + 100;
        cfg.endsAt = T0 + 50;
        vm.expectRevert(abi.encodeWithSelector(Stampd1155.InvalidWindow.selector, cfg.startsAt, cfg.endsAt));
        vm.prank(organizer);
        stampd.createEvent(cfg);
    }

    function test_unknownEvent_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(Stampd1155.UnknownEvent.selector, uint256(42)));
        stampd.getEvent(42);
    }

    /* ------------------------------------------------------------------ */
    /*                             MINT BATCH                              */
    /* ------------------------------------------------------------------ */

    function test_mintBatch_mintsToAllRecipients() public {
        uint256 id = _createDefaultEvent();
        address[] memory to = new address[](3);
        to[0] = alice;
        to[1] = bob;
        to[2] = carol;

        vm.prank(signer);
        uint256 minted = stampd.mintBatch(id, to);

        assertEq(minted, 3);
        assertEq(stampd.balanceOf(alice, id), 1);
        assertEq(stampd.balanceOf(bob, id), 1);
        assertEq(stampd.balanceOf(carol, id), 1);
        assertEq(stampd.totalMinted(id), 3);
        assertTrue(stampd.claimed(id, alice));
    }

    function test_mintBatch_onlyEventSigner() public {
        uint256 id = _createDefaultEvent();
        vm.expectRevert(abi.encodeWithSelector(Stampd1155.NotEventSigner.selector, id));
        vm.prank(organizer); // even the organizer cannot mint; only the event signer can
        stampd.mintBatch(id, _one(alice));
    }

    function test_mintBatch_revertsOnEmptyBatch() public {
        uint256 id = _createDefaultEvent();
        vm.expectRevert(Stampd1155.EmptyBatch.selector);
        vm.prank(signer);
        stampd.mintBatch(id, new address[](0));
    }

    /// @dev A duplicate must not cost the rest of the batch their badges.
    function test_mintBatch_skipsDuplicatesWithoutRevertingBatch() public {
        uint256 id = _createDefaultEvent();
        address[] memory to = new address[](3);
        to[0] = alice;
        to[1] = alice; // duplicate
        to[2] = bob;

        vm.expectEmit(true, true, false, true);
        emit Stampd1155.ClaimSkipped(id, alice, Stampd1155.SkipReason.AlreadyClaimed);

        vm.prank(signer);
        uint256 minted = stampd.mintBatch(id, to);

        assertEq(minted, 2, "duplicate skipped, others minted");
        assertEq(stampd.balanceOf(alice, id), 1, "no double mint");
        assertEq(stampd.balanceOf(bob, id), 1);
        assertEq(stampd.totalMinted(id), 2);
    }

    function test_mintBatch_skipsZeroAddress() public {
        uint256 id = _createDefaultEvent();
        address[] memory to = new address[](2);
        to[0] = address(0);
        to[1] = alice;

        vm.expectEmit(true, true, false, true);
        emit Stampd1155.ClaimSkipped(id, address(0), Stampd1155.SkipReason.ZeroAddress);

        vm.prank(signer);
        assertEq(stampd.mintBatch(id, to), 1);
    }

    /* ------------------------------------------------------------------ */
    /*                      RECIPIENTS THAT HAVE CODE                      */
    /* ------------------------------------------------------------------ */

    /// @dev The failure this guards against: `_mint` calls `onERC1155Received` on any recipient
    ///      with code and reverts the whole transaction if it is missing. One attendee must never
    ///      cost a room their badges.
    function test_mintBatch_skipsRecipientThatCannotReceive() public {
        uint256 id = _createDefaultEvent();
        address stranger = address(new NotAReceiver());

        address[] memory to = new address[](3);
        to[0] = alice;
        to[1] = stranger;
        to[2] = bob;

        vm.expectEmit(true, true, false, true);
        emit Stampd1155.ClaimSkipped(id, stranger, Stampd1155.SkipReason.NotAReceiver);

        vm.prank(signer);
        uint256 minted = stampd.mintBatch(id, to);

        assertEq(minted, 2, "the batch survived a recipient that cannot receive");
        assertEq(stampd.balanceOf(alice, id), 1);
        assertEq(stampd.balanceOf(bob, id), 1);
        assertEq(stampd.balanceOf(stranger, id), 0);
        assertFalse(stampd.claimed(id, stranger), "a skipped recipient keeps their claim open");
    }

    /// @dev The polite refusal, as opposed to no answer at all.
    function test_mintBatch_skipsRecipientThatDeclines() public {
        uint256 id = _createDefaultEvent();
        address decliner = address(new DeclinesBadges());

        address[] memory to = new address[](2);
        to[0] = decliner;
        to[1] = alice;

        vm.prank(signer);
        assertEq(stampd.mintBatch(id, to), 1);
        assertEq(stampd.balanceOf(alice, id), 1);
    }

    /// @dev The probe is gas-capped, so a recipient cannot burn the batch's gas to grief everyone
    ///      else in it.
    function test_mintBatch_survivesGasBurningRecipient() public {
        uint256 id = _createDefaultEvent();
        address burner = address(new GasBurner());

        address[] memory to = new address[](2);
        to[0] = burner;
        to[1] = alice;

        vm.prank(signer);
        uint256 minted = stampd.mintBatch{gas: 1_000_000}(id, to);

        assertEq(minted, 1, "the burner was skipped and alice still got her badge");
        assertEq(stampd.balanceOf(alice, id), 1);
    }

    /// @dev The check must not over-skip: a contract that genuinely implements the receiver, such
    ///      as a deployed smart wallet, still gets its badge.
    function test_mintBatch_stillMintsToRealReceiver() public {
        uint256 id = _createDefaultEvent();
        address wallet = address(new ReentrantReceiver(stampd)); // implements IERC1155Receiver

        vm.prank(signer);
        assertEq(stampd.mintBatch(id, _one(wallet)), 1);
        assertEq(stampd.balanceOf(wallet, id), 1);
    }

    /// @dev An EOA that has been given code, which is what EIP-7702 delegation looks like to this
    ///      contract. The address is an ordinary wallet to its owner and a contract to `_mint`.
    function test_mintBatch_skipsDelegatedWalletWithoutReceiver() public {
        uint256 id = _createDefaultEvent();
        vm.etch(alice, address(new NotAReceiver()).code);

        address[] memory to = new address[](2);
        to[0] = alice;
        to[1] = bob;

        vm.prank(signer);
        assertEq(stampd.mintBatch(id, to), 1, "bob is unaffected by alice's delegation");
        assertEq(stampd.balanceOf(bob, id), 1);
        assertEq(stampd.balanceOf(alice, id), 0);
    }

    /* ------------------------------------------------------------------ */
    /*                        COLLECTION METADATA                          */
    /* ------------------------------------------------------------------ */

    /// @dev Not required by ERC-1155, but wallets label a collection with these, and without them
    ///      a badge shows as an unidentified token however good its own metadata is.
    function test_collectionMetadata() public view {
        assertEq(stampd.name(), "stampd");
        assertEq(stampd.symbol(), "STAMPD");
        assertEq(stampd.contractURI(), "https://stampd.usersfirst.com/collection.json");
    }

    function test_mintBatch_stopsAtSupplyCap() public {
        Stampd1155.EventConfig memory cfg = _defaultConfig();
        cfg.maxSupply = 2;
        uint256 id = _createEvent(cfg);

        address[] memory to = new address[](4);
        to[0] = alice;
        to[1] = bob;
        to[2] = carol;
        to[3] = relayer;

        vm.expectEmit(true, true, false, true);
        emit Stampd1155.ClaimSkipped(id, carol, Stampd1155.SkipReason.SupplyExhausted);

        vm.prank(signer);
        uint256 minted = stampd.mintBatch(id, to);

        assertEq(minted, 2);
        assertEq(stampd.totalMinted(id), 2);
        assertEq(stampd.balanceOf(carol, id), 0);
        assertEq(stampd.remainingSupply(id), 0);
    }

    function test_mintBatch_revertsBeforeWindowOpens() public {
        Stampd1155.EventConfig memory cfg = _defaultConfig();
        cfg.startsAt = T0 + 1000;
        uint256 id = _createEvent(cfg);

        vm.expectRevert(abi.encodeWithSelector(Stampd1155.ClaimWindowClosed.selector, id));
        vm.prank(signer);
        stampd.mintBatch(id, _one(alice));
    }

    function test_mintBatch_revertsAfterWindowCloses() public {
        Stampd1155.EventConfig memory cfg = _defaultConfig();
        cfg.endsAt = T0 + 1000;
        uint256 id = _createEvent(cfg);

        vm.warp(T0 + 1001);
        vm.expectRevert(abi.encodeWithSelector(Stampd1155.ClaimWindowClosed.selector, id));
        vm.prank(signer);
        stampd.mintBatch(id, _one(alice));
    }

    /* ------------------------------------------------------------------ */
    /*                          VOUCHER CLAIMS                             */
    /* ------------------------------------------------------------------ */

    function test_claim_withValidVoucher() public {
        uint256 id = _createDefaultEvent();
        Stampd1155.ClaimVoucher memory v = _voucher(id, alice, 1, 0);

        vm.prank(alice);
        stampd.claim(v, _sign(signerPk, v));

        assertEq(stampd.balanceOf(alice, id), 1);
        assertEq(stampd.totalMinted(id), 1);
        assertTrue(stampd.nonceUsed(id, 1));
    }

    /// @dev The badge goes to `v.claimer`, so a relayer or bundler can pay gas for the attendee.
    function test_claim_mintsToClaimerNotSubmitter() public {
        uint256 id = _createDefaultEvent();
        Stampd1155.ClaimVoucher memory v = _voucher(id, alice, 1, 0);

        vm.prank(relayer);
        stampd.claim(v, _sign(signerPk, v));

        assertEq(stampd.balanceOf(alice, id), 1);
        assertEq(stampd.balanceOf(relayer, id), 0);
    }

    function test_claim_revertsOnReplayedNonce() public {
        uint256 id = _createDefaultEvent();
        Stampd1155.ClaimVoucher memory v = _voucher(id, alice, 7, 0);
        bytes memory sig = _sign(signerPk, v);

        stampd.claim(v, sig);

        vm.expectRevert(abi.encodeWithSelector(Stampd1155.NonceAlreadyUsed.selector, id, uint256(7)));
        stampd.claim(v, sig);
    }

    /// @dev A fresh nonce must still not let the same address collect a second badge.
    function test_claim_revertsWhenAlreadyBadgedWithFreshNonce() public {
        uint256 id = _createDefaultEvent();
        Stampd1155.ClaimVoucher memory first = _voucher(id, alice, 1, 0);
        stampd.claim(first, _sign(signerPk, first));

        Stampd1155.ClaimVoucher memory second = _voucher(id, alice, 2, 0);
        bytes memory secondSig = _sign(signerPk, second);

        vm.expectRevert(abi.encodeWithSelector(Stampd1155.AlreadyClaimed.selector, id, alice));
        stampd.claim(second, secondSig);
    }

    function test_claim_revertsOnExpiredVoucher() public {
        uint256 id = _createDefaultEvent();
        uint64 expiry = T0 + 60;
        Stampd1155.ClaimVoucher memory v = _voucher(id, alice, 1, expiry);
        bytes memory sig = _sign(signerPk, v);

        vm.warp(expiry + 1);
        vm.expectRevert(abi.encodeWithSelector(Stampd1155.VoucherExpired.selector, expiry));
        stampd.claim(v, sig);
    }

    function test_claim_zeroExpiryNeverExpires() public {
        uint256 id = _createDefaultEvent();
        Stampd1155.ClaimVoucher memory v = _voucher(id, alice, 1, 0);

        vm.warp(T0 + 365 days);
        stampd.claim(v, _sign(signerPk, v));
        assertEq(stampd.balanceOf(alice, id), 1);
    }

    function test_claim_revertsOnWrongSigner() public {
        uint256 id = _createDefaultEvent();
        Stampd1155.ClaimVoucher memory v = _voucher(id, alice, 1, 0);
        bytes memory sig = _sign(0xBAD, v);

        vm.expectRevert(Stampd1155.InvalidSignature.selector);
        stampd.claim(v, sig);
    }

    /// @dev Swapping the claimer after signing must invalidate the signature.
    function test_claim_revertsWhenVoucherTampered() public {
        uint256 id = _createDefaultEvent();
        Stampd1155.ClaimVoucher memory signed = _voucher(id, alice, 1, 0);
        bytes memory sig = _sign(signerPk, signed);

        Stampd1155.ClaimVoucher memory tampered = _voucher(id, bob, 1, 0);
        vm.expectRevert(Stampd1155.InvalidSignature.selector);
        stampd.claim(tampered, sig);
    }

    function test_claim_revertsWhenSupplyExhausted() public {
        Stampd1155.EventConfig memory cfg = _defaultConfig();
        cfg.maxSupply = 1;
        uint256 id = _createEvent(cfg);

        Stampd1155.ClaimVoucher memory first = _voucher(id, alice, 1, 0);
        stampd.claim(first, _sign(signerPk, first));

        Stampd1155.ClaimVoucher memory second = _voucher(id, bob, 2, 0);
        bytes memory secondSig = _sign(signerPk, second);

        vm.expectRevert(abi.encodeWithSelector(Stampd1155.SupplyExhausted.selector, id));
        stampd.claim(second, secondSig);
    }

    function test_claim_revertsOutsideWindow() public {
        Stampd1155.EventConfig memory cfg = _defaultConfig();
        cfg.endsAt = T0 + 100;
        uint256 id = _createEvent(cfg);
        Stampd1155.ClaimVoucher memory v = _voucher(id, alice, 1, 0);
        bytes memory sig = _sign(signerPk, v);

        vm.warp(T0 + 101);
        vm.expectRevert(abi.encodeWithSelector(Stampd1155.ClaimWindowClosed.selector, id));
        stampd.claim(v, sig);
    }

    /// @dev Rotating the signer is the compromise response: old vouchers must die immediately.
    function test_rotateSigner_invalidatesOldVouchersAndAcceptsNew() public {
        uint256 id = _createDefaultEvent();
        Stampd1155.ClaimVoucher memory v = _voucher(id, alice, 1, 0);
        bytes memory oldSig = _sign(signerPk, v);

        uint256 newPk = 0xB0B;
        vm.prank(organizer);
        stampd.rotateSigner(id, vm.addr(newPk));

        vm.expectRevert(Stampd1155.InvalidSignature.selector);
        stampd.claim(v, oldSig);

        stampd.claim(v, _sign(newPk, v));
        assertEq(stampd.balanceOf(alice, id), 1);
    }

    /// @dev The two mint paths share the `claimed` map, so they cannot double-badge one address.
    function test_claimAndMintBatchShareClaimedState() public {
        uint256 id = _createDefaultEvent();
        Stampd1155.ClaimVoucher memory v = _voucher(id, alice, 1, 0);
        stampd.claim(v, _sign(signerPk, v));

        vm.prank(signer);
        uint256 minted = stampd.mintBatch(id, _one(alice));

        assertEq(minted, 0, "voucher claim already badged alice");
        assertEq(stampd.balanceOf(alice, id), 1);
    }

    /* ------------------------------------------------------------------ */
    /*                            SOULBINDING                              */
    /* ------------------------------------------------------------------ */

    function test_transfer_revertsWhenSoulbound() public {
        uint256 id = _createDefaultEvent();
        vm.prank(signer);
        stampd.mintBatch(id, _one(alice));

        vm.expectRevert(abi.encodeWithSelector(Stampd1155.Soulbound.selector, id));
        vm.prank(alice);
        stampd.safeTransferFrom(alice, bob, id, 1, "");
    }

    function test_batchTransfer_revertsWhenSoulbound() public {
        uint256 id = _createDefaultEvent();
        vm.prank(signer);
        stampd.mintBatch(id, _one(alice));

        uint256[] memory ids = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        ids[0] = id;
        amounts[0] = 1;

        vm.expectRevert(abi.encodeWithSelector(Stampd1155.Soulbound.selector, id));
        vm.prank(alice);
        stampd.safeBatchTransferFrom(alice, bob, ids, amounts, "");
    }

    function test_transfer_allowedWhenEventOptsIn() public {
        Stampd1155.EventConfig memory cfg = _defaultConfig();
        cfg.transferable = true;
        uint256 id = _createEvent(cfg);

        vm.prank(signer);
        stampd.mintBatch(id, _one(alice));

        vm.prank(alice);
        stampd.safeTransferFrom(alice, bob, id, 1, "");

        assertEq(stampd.balanceOf(bob, id), 1);
        assertEq(stampd.balanceOf(alice, id), 0);
    }

    function test_burn_allowedWhileSoulbound() public {
        uint256 id = _createDefaultEvent();
        vm.prank(signer);
        stampd.mintBatch(id, _one(alice));

        vm.prank(alice);
        stampd.burn(id);
        assertEq(stampd.balanceOf(alice, id), 0);
    }

    /// @dev Burning must not reopen the claim, or it becomes a farming loop.
    function test_burn_doesNotAllowReclaim() public {
        uint256 id = _createDefaultEvent();
        vm.prank(signer);
        stampd.mintBatch(id, _one(alice));
        vm.prank(alice);
        stampd.burn(id);

        assertTrue(stampd.claimed(id, alice), "claimed survives the burn");

        vm.prank(signer);
        assertEq(stampd.mintBatch(id, _one(alice)), 0);

        Stampd1155.ClaimVoucher memory v = _voucher(id, alice, 1, 0);
        bytes memory sig = _sign(signerPk, v);

        vm.expectRevert(abi.encodeWithSelector(Stampd1155.AlreadyClaimed.selector, id, alice));
        stampd.claim(v, sig);
    }

    /* ------------------------------------------------------------------ */
    /*                        ORGANIZER CONTROLS                           */
    /* ------------------------------------------------------------------ */

    function test_organizerControls_rejectNonOrganizer() public {
        uint256 id = _createDefaultEvent();

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Stampd1155.NotOrganizer.selector, id));
        stampd.rotateSigner(id, alice);

        vm.expectRevert(abi.encodeWithSelector(Stampd1155.NotOrganizer.selector, id));
        stampd.setEventURI(id, "ipfs://evil");

        vm.expectRevert(abi.encodeWithSelector(Stampd1155.NotOrganizer.selector, id));
        stampd.freezeEvent(id);
        vm.stopPrank();
    }

    function test_setEventURI_updatesMetadata() public {
        uint256 id = _createDefaultEvent();
        vm.prank(organizer);
        stampd.setEventURI(id, "ipfs://updated");
        assertEq(stampd.uri(id), "ipfs://updated");
    }

    function test_freezeEvent_locksMetadataAndTransferability() public {
        uint256 id = _createDefaultEvent();
        vm.startPrank(organizer);
        stampd.freezeEvent(id);

        vm.expectRevert(abi.encodeWithSelector(Stampd1155.MetadataFrozen.selector, id));
        stampd.setEventURI(id, "ipfs://after-freeze");

        vm.expectRevert(abi.encodeWithSelector(Stampd1155.MetadataFrozen.selector, id));
        stampd.setTransferable(id, true);

        vm.expectRevert(abi.encodeWithSelector(Stampd1155.MetadataFrozen.selector, id));
        stampd.freezeEvent(id);
        vm.stopPrank();
    }

    function test_setTransferable_allowedBeforeFirstMint() public {
        uint256 id = _createDefaultEvent();

        vm.prank(organizer);
        stampd.setTransferable(id, true);
        assertTrue(stampd.getEvent(id).transferable);

        // Still nobody holding one, so the organizer may still change their mind.
        vm.prank(organizer);
        stampd.setTransferable(id, false);
        assertFalse(stampd.getEvent(id).transferable);
    }

    /// @dev The whole point of the lock: an attendee's terms cannot change after they hold a badge.
    function test_setTransferable_lockedOnceAnyBadgeExists() public {
        Stampd1155.EventConfig memory cfg = _defaultConfig();
        cfg.transferable = true;
        uint256 id = _createEvent(cfg);

        vm.prank(signer);
        stampd.mintBatch(id, _one(alice));

        vm.prank(organizer);
        vm.expectRevert(abi.encodeWithSelector(Stampd1155.TransferabilityLocked.selector, id));
        stampd.setTransferable(id, false);

        // Alice keeps the badge she was promised: still transferable.
        vm.prank(alice);
        stampd.safeTransferFrom(alice, bob, id, 1, "");
        assertEq(stampd.balanceOf(bob, id), 1);
    }

    /// @dev Burning back to zero supply must not reopen the window — `minted` is monotonic, so a
    ///      holder cannot be talked into burning as a way to unlock the flag.
    function test_setTransferable_staysLockedAfterBurn() public {
        uint256 id = _createDefaultEvent();

        vm.prank(signer);
        stampd.mintBatch(id, _one(alice));

        vm.prank(alice);
        stampd.burn(id);
        assertEq(stampd.balanceOf(alice, id), 0);

        vm.prank(organizer);
        vm.expectRevert(abi.encodeWithSelector(Stampd1155.TransferabilityLocked.selector, id));
        stampd.setTransferable(id, true);
    }

    /// @dev Freezing locks metadata but must not stop attendees from being badged.
    function test_freezeEvent_stillAllowsMinting() public {
        uint256 id = _createDefaultEvent();
        vm.prank(organizer);
        stampd.freezeEvent(id);

        vm.prank(signer);
        assertEq(stampd.mintBatch(id, _one(alice)), 1);
    }

    function test_transferOrganizer_movesControl() public {
        uint256 id = _createDefaultEvent();
        vm.prank(organizer);
        stampd.transferOrganizer(id, alice);

        assertEq(stampd.getEvent(id).organizer, alice);

        vm.expectRevert(abi.encodeWithSelector(Stampd1155.NotOrganizer.selector, id));
        vm.prank(organizer);
        stampd.rotateSigner(id, bob);

        vm.prank(alice);
        stampd.rotateSigner(id, bob);
        assertEq(stampd.getEvent(id).signer, bob);
    }

    /* ------------------------------------------------------------------ */
    /*                               VIEWS                                 */
    /* ------------------------------------------------------------------ */

    function test_remainingSupply_isUnboundedWhenUncapped() public {
        uint256 id = _createDefaultEvent();
        assertEq(stampd.remainingSupply(id), type(uint256).max);
    }

    function test_isOpen_reflectsWindowAndSupply() public {
        Stampd1155.EventConfig memory cfg = _defaultConfig();
        cfg.startsAt = T0 + 10;
        cfg.endsAt = T0 + 100;
        cfg.maxSupply = 1;
        uint256 id = _createEvent(cfg);

        assertFalse(stampd.isOpen(id), "before window");

        vm.warp(T0 + 50);
        assertTrue(stampd.isOpen(id), "inside window");

        vm.prank(signer);
        stampd.mintBatch(id, _one(alice));
        assertFalse(stampd.isOpen(id), "supply exhausted");

        vm.warp(T0 + 101);
        assertFalse(stampd.isOpen(id), "after window");
    }

    /* ------------------------------------------------------------------ */
    /*                            REENTRANCY                               */
    /* ------------------------------------------------------------------ */

    /// @dev Regression: a contract recipient reentering `claim` from `onERC1155Received` during a
    ///      batch would read a stale `minted`, and the batch's trailing write would clobber the
    ///      increment — letting the cap be exceeded later. The transient guard must block it.
    function test_reentrantClaimDuringMintBatchIsBlocked() public {
        Stampd1155.EventConfig memory cfg = _defaultConfig();
        cfg.maxSupply = 3;
        uint256 id = _createEvent(cfg);

        ReentrantReceiver attacker = new ReentrantReceiver(stampd);
        Stampd1155.ClaimVoucher memory v = _voucher(id, address(attacker), 99, 0);
        attacker.arm(v, _sign(signerPk, v));

        address[] memory to = new address[](2);
        to[0] = address(attacker);
        to[1] = alice;

        vm.prank(signer);
        vm.expectRevert(); // ReentrancyGuardTransient bubbles up through the receiver hook
        stampd.mintBatch(id, to);

        assertEq(stampd.totalMinted(id), 0, "batch reverted wholesale, no state committed");
    }

    /* ------------------------------------------------------------------ */
    /*                                FUZZ                                 */
    /* ------------------------------------------------------------------ */

    function testFuzz_mintBatchNeverExceedsCap(uint8 recipientCount, uint8 cap) public {
        vm.assume(recipientCount > 0 && cap > 0);

        Stampd1155.EventConfig memory cfg = _defaultConfig();
        cfg.maxSupply = cap;
        uint256 id = _createEvent(cfg);

        address[] memory to = new address[](recipientCount);
        for (uint256 i; i < recipientCount; ++i) {
            to[i] = address(uint160(i + 1000)); // distinct, code-free addresses
        }

        vm.prank(signer);
        uint256 minted = stampd.mintBatch(id, to);

        assertLe(minted, cap, "never mints past the cap");
        assertEq(minted, recipientCount < cap ? recipientCount : cap);
        assertEq(stampd.totalMinted(id), minted);
    }

    function testFuzz_soulboundBlocksEveryTransfer(address from, address to) public {
        vm.assume(from != address(0) && to != address(0) && from != to);
        vm.assume(from.code.length == 0 && to.code.length == 0);

        uint256 id = _createDefaultEvent();
        vm.prank(signer);
        stampd.mintBatch(id, _one(from));

        vm.expectRevert(abi.encodeWithSelector(Stampd1155.Soulbound.selector, id));
        vm.prank(from);
        stampd.safeTransferFrom(from, to, id, 1, "");
    }
}

/// @dev Attempts to reenter `claim` while receiving a badge from `mintBatch`.
contract ReentrantReceiver is IERC1155Receiver {
    Stampd1155 private immutable STAMPD;
    Stampd1155.ClaimVoucher private voucher;
    bytes private signature;
    bool private armed;

    constructor(Stampd1155 stampd_) {
        STAMPD = stampd_;
    }

    function arm(Stampd1155.ClaimVoucher calldata v, bytes calldata sig) external {
        voucher = v;
        signature = sig;
        armed = true;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        if (armed) {
            armed = false;
            STAMPD.claim(voucher, signature);
        }
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}

/// @dev A contract with code that does not implement the receiver at all. Stands in for the real
///      hazard: an EIP-7702 wallet delegated to an implementation without `IERC1155Receiver`.
///      Before the pre-check, one of these in a batch reverted the whole thing.
contract NotAReceiver {
    uint256 public x;
}

/// @dev Answers `supportsInterface` with `false` rather than reverting. The other shape the same
///      problem takes, and the one a naive `try/catch` would still get wrong.
contract DeclinesBadges {
    function supportsInterface(bytes4) external pure returns (bool) {
        return false;
    }
}

/// @dev Consumes every unit of gas it is handed and dies. Without the cap on the probe it would
///      take the whole transaction's gas with it; with the cap it costs the batch 30k and a skip.
contract GasBurner {
    function supportsInterface(bytes4) external view returns (bool) {
        while (gasleft() > 0) {}
        return true;
    }
}
