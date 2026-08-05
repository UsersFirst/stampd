// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title Stampd1155
/// @notice Soulbound attendance badges on Base. One ERC-1155 collection for every event,
///         where `tokenId == eventId`, so creating an event costs one call rather than a deploy.
/// @dev Two mint paths share a single per-event signer address:
///
///      1. `mintBatch` — the host-funded path. The event signer submits the transaction and pays
///         gas, so plain access control is sufficient and no signature ends up on-chain. This is
///         the default: it amortises gas across recipients and lets attendees receive badges at
///         counterfactual smart-wallet addresses they have never deployed.
///
///      2. `claim` — the self-serve path. An attendee (or a bundler acting for one) submits an
///         EIP-712 voucher signed off-chain by the event signer. Costs more per badge, but gives
///         instant on-chain finality for events willing to fund a paymaster.
///
///      Event creation is permissionless. Anyone may create an event and becomes its organizer;
///      curation is a concern of the indexer and front-end, not of this contract.
///      Both mint paths are guarded against reentrancy: `_mint` invokes `onERC1155Received` on
///      deployed-contract recipients, and without a guard a recipient could reenter `claim`
///      mid-batch, read a stale `minted` counter, and have its increment clobbered by the
///      batch's trailing write — quietly raising the effective supply cap.
contract Stampd1155 is ERC1155, EIP712, ReentrancyGuardTransient {
    /* ---------------------------------------------------------------------- */
    /*                                  TYPES                                  */
    /* ---------------------------------------------------------------------- */

    /// @dev Packs into three storage slots: (organizer, startsAt, maxSupply),
    ///      (signer, endsAt, minted), (transferable, frozen).
    struct EventData {
        address organizer;
        uint64 startsAt;
        uint32 maxSupply;
        address signer;
        uint64 endsAt;
        uint32 minted;
        bool transferable;
        bool frozen;
    }

    struct EventConfig {
        address signer;
        uint64 startsAt;
        uint64 endsAt;
        uint32 maxSupply;
        bool transferable;
        string uri;
    }

    struct ClaimVoucher {
        uint256 eventId;
        address claimer;
        uint256 nonce;
        uint64 expiry;
    }

    /// @notice Why a recipient in a `mintBatch` call did not receive a badge.
    enum SkipReason {
        ZeroAddress,
        AlreadyClaimed,
        SupplyExhausted
    }

    /* ---------------------------------------------------------------------- */
    /*                                 STORAGE                                 */
    /* ---------------------------------------------------------------------- */

    bytes32 private constant CLAIM_VOUCHER_TYPEHASH =
        keccak256("ClaimVoucher(uint256 eventId,address claimer,uint256 nonce,uint64 expiry)");

    /// @notice Number of events created. Event ids are 1-indexed, so 0 is never a valid event.
    uint256 public eventCount;

    mapping(uint256 eventId => EventData) private _events;
    mapping(uint256 eventId => string) private _eventURI;

    /// @notice Whether an address has ever been badged for an event. Stays true after a burn,
    ///         so burning cannot be used to re-open a claim.
    mapping(uint256 eventId => mapping(address holder => bool)) public claimed;

    /// @notice Spent voucher nonces, scoped per event.
    mapping(uint256 eventId => mapping(uint256 nonce => bool)) public nonceUsed;

    /* ---------------------------------------------------------------------- */
    /*                                  EVENTS                                 */
    /* ---------------------------------------------------------------------- */

    event EventCreated(
        uint256 indexed eventId,
        address indexed organizer,
        address indexed signer,
        uint32 maxSupply,
        uint64 startsAt,
        uint64 endsAt,
        bool transferable,
        string uri
    );
    event SignerRotated(uint256 indexed eventId, address indexed previousSigner, address indexed newSigner);
    event OrganizerTransferred(
        uint256 indexed eventId, address indexed previousOrganizer, address indexed newOrganizer
    );
    event EventURIUpdated(uint256 indexed eventId, string uri);
    event TransferabilitySet(uint256 indexed eventId, bool transferable);
    event EventFrozen(uint256 indexed eventId);
    event ClaimSkipped(uint256 indexed eventId, address indexed recipient, SkipReason reason);

    /* ---------------------------------------------------------------------- */
    /*                                  ERRORS                                 */
    /* ---------------------------------------------------------------------- */

    error UnknownEvent(uint256 eventId);
    error NotOrganizer(uint256 eventId);
    error NotEventSigner(uint256 eventId);
    error MetadataFrozen(uint256 eventId);
    error TransferabilityLocked(uint256 eventId);
    error ClaimWindowClosed(uint256 eventId);
    error SupplyExhausted(uint256 eventId);
    error AlreadyClaimed(uint256 eventId, address holder);
    error NonceAlreadyUsed(uint256 eventId, uint256 nonce);
    error VoucherExpired(uint64 expiry);
    error InvalidSignature();
    error Soulbound(uint256 eventId);
    error ZeroSigner();
    error ZeroAddressRecipient();
    error EmptyBatch();
    error InvalidWindow(uint64 startsAt, uint64 endsAt);

    /* ---------------------------------------------------------------------- */
    /*                               CONSTRUCTION                              */
    /* ---------------------------------------------------------------------- */

    constructor() ERC1155("") EIP712("Stampd", "1") {}

    /* ---------------------------------------------------------------------- */
    /*                                MODIFIERS                                */
    /* ---------------------------------------------------------------------- */

    modifier onlyOrganizer(uint256 eventId) {
        if (_events[eventId].organizer != msg.sender) {
            if (!_exists(eventId)) revert UnknownEvent(eventId);
            revert NotOrganizer(eventId);
        }
        _;
    }

    /* ---------------------------------------------------------------------- */
    /*                             EVENT LIFECYCLE                             */
    /* ---------------------------------------------------------------------- */

    /// @notice Create an event. The caller becomes its organizer.
    /// @dev `startsAt == 0` means open immediately; `endsAt == 0` means no end;
    ///      `maxSupply == 0` means unlimited.
    function createEvent(EventConfig calldata cfg) external returns (uint256 eventId) {
        if (cfg.signer == address(0)) revert ZeroSigner();
        if (cfg.endsAt != 0 && cfg.endsAt <= cfg.startsAt) revert InvalidWindow(cfg.startsAt, cfg.endsAt);

        unchecked {
            eventId = ++eventCount;
        }

        _events[eventId] = EventData({
            organizer: msg.sender,
            startsAt: cfg.startsAt,
            maxSupply: cfg.maxSupply,
            signer: cfg.signer,
            endsAt: cfg.endsAt,
            minted: 0,
            transferable: cfg.transferable,
            frozen: false
        });
        _eventURI[eventId] = cfg.uri;

        emit EventCreated(
            eventId, msg.sender, cfg.signer, cfg.maxSupply, cfg.startsAt, cfg.endsAt, cfg.transferable, cfg.uri
        );
    }

    /// @notice Replace the event signer. Use this if the per-event key is lost or compromised;
    ///         vouchers signed by the old key stop verifying immediately.
    function rotateSigner(uint256 eventId, address newSigner) external onlyOrganizer(eventId) {
        if (newSigner == address(0)) revert ZeroSigner();
        address previous = _events[eventId].signer;
        _events[eventId].signer = newSigner;
        emit SignerRotated(eventId, previous, newSigner);
    }

    function transferOrganizer(uint256 eventId, address newOrganizer) external onlyOrganizer(eventId) {
        if (newOrganizer == address(0)) revert ZeroAddressRecipient();
        _events[eventId].organizer = newOrganizer;
        emit OrganizerTransferred(eventId, msg.sender, newOrganizer);
    }

    function setEventURI(uint256 eventId, string calldata newURI) external onlyOrganizer(eventId) {
        if (_events[eventId].frozen) revert MetadataFrozen(eventId);
        _eventURI[eventId] = newURI;
        emit EventURIUpdated(eventId, newURI);
    }

    /// @notice Set whether an event's badges may be transferred. Only while no badge exists.
    /// @dev Locked at first mint. Flipping a live event back to soulbound would freeze an asset
    ///      someone already holds, and flipping it the other way would put badges people earned
    ///      as keepsakes onto a market they never opted into. Either way the holder's terms would
    ///      change after the fact, so the window closes as soon as there is a holder: whatever an
    ///      attendee is shown at claim time is what they keep.
    function setTransferable(uint256 eventId, bool transferable) external onlyOrganizer(eventId) {
        if (_events[eventId].frozen) revert MetadataFrozen(eventId);
        if (_events[eventId].minted != 0) revert TransferabilityLocked(eventId);
        _events[eventId].transferable = transferable;
        emit TransferabilitySet(eventId, transferable);
    }

    /// @notice Permanently lock an event's metadata and transferability. Irreversible.
    function freezeEvent(uint256 eventId) external onlyOrganizer(eventId) {
        if (_events[eventId].frozen) revert MetadataFrozen(eventId);
        _events[eventId].frozen = true;
        emit EventFrozen(eventId);
    }

    /* ---------------------------------------------------------------------- */
    /*                                MINT PATHS                               */
    /* ---------------------------------------------------------------------- */

    /// @notice Host-funded path: the event signer mints badges to many recipients in one call.
    /// @dev Ineligible recipients are skipped and reported via `ClaimSkipped` rather than
    ///      reverting the batch. A single duplicate or a race with the off-chain queue must not
    ///      cost every other attendee in the batch their badge.
    /// @dev A recipient that is a *deployed* contract must implement `IERC1155Receiver`, or the
    ///      whole batch reverts on the acceptance check. Counterfactual (undeployed) smart-wallet
    ///      addresses have no code and are unaffected, which is the common case here.
    /// @return mintedCount Number of badges actually minted.
    function mintBatch(uint256 eventId, address[] calldata recipients)
        external
        nonReentrant
        returns (uint256 mintedCount)
    {
        EventData storage ev = _requireEvent(eventId);
        if (msg.sender != ev.signer) revert NotEventSigner(eventId);
        if (recipients.length == 0) revert EmptyBatch();
        _requireOpen(eventId, ev);

        uint32 minted = ev.minted;
        uint32 cap = ev.maxSupply;

        for (uint256 i; i < recipients.length; ++i) {
            address to = recipients[i];

            if (to == address(0)) {
                emit ClaimSkipped(eventId, to, SkipReason.ZeroAddress);
                continue;
            }
            if (claimed[eventId][to]) {
                emit ClaimSkipped(eventId, to, SkipReason.AlreadyClaimed);
                continue;
            }
            if (cap != 0 && minted >= cap) {
                emit ClaimSkipped(eventId, to, SkipReason.SupplyExhausted);
                continue;
            }

            claimed[eventId][to] = true;
            unchecked {
                ++minted;
                ++mintedCount;
            }
            _mint(to, eventId, 1, "");
        }

        ev.minted = minted;
    }

    /// @notice Self-serve path: redeem a voucher signed off-chain by the event signer.
    /// @dev Mints to `v.claimer`, not to `msg.sender`, so a bundler or relayer can submit on the
    ///      attendee's behalf. The signature is checked with ERC-1271 support, so an event signer
    ///      may itself be a smart contract wallet.
    function claim(ClaimVoucher calldata v, bytes calldata signature) external nonReentrant {
        EventData storage ev = _requireEvent(v.eventId);
        if (v.claimer == address(0)) revert ZeroAddressRecipient();
        if (v.expiry != 0 && block.timestamp > v.expiry) revert VoucherExpired(v.expiry);
        if (nonceUsed[v.eventId][v.nonce]) revert NonceAlreadyUsed(v.eventId, v.nonce);
        if (claimed[v.eventId][v.claimer]) revert AlreadyClaimed(v.eventId, v.claimer);
        _requireOpen(v.eventId, ev);
        if (ev.maxSupply != 0 && ev.minted >= ev.maxSupply) revert SupplyExhausted(v.eventId);

        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(CLAIM_VOUCHER_TYPEHASH, v.eventId, v.claimer, v.nonce, v.expiry)));
        if (!SignatureChecker.isValidSignatureNow(ev.signer, digest, signature)) revert InvalidSignature();

        nonceUsed[v.eventId][v.nonce] = true;
        claimed[v.eventId][v.claimer] = true;
        unchecked {
            ++ev.minted;
        }

        _mint(v.claimer, v.eventId, 1, "");
    }

    /// @notice Burn your own badge. `claimed` remains set, so the badge cannot be re-claimed.
    function burn(uint256 eventId) external {
        _burn(msg.sender, eventId, 1);
    }

    /* ---------------------------------------------------------------------- */
    /*                                  VIEWS                                  */
    /* ---------------------------------------------------------------------- */

    function getEvent(uint256 eventId) external view returns (EventData memory) {
        return _requireEventView(eventId);
    }

    /// @notice Badges ever issued for an event. Monotonic: burning does not decrement it.
    /// @dev Deliberately *not* named `totalSupply`. Every ERC-1155 convention, OpenZeppelin's
    ///      `ERC1155Supply` included, reads `totalSupply` as current circulating supply, and an
    ///      indexer or marketplace assuming that would misreport any collection with burns.
    ///      The monotonic count is the one this contract needs — it is what `claimed` is checked
    ///      against, and what stops burn-and-reclaim farming — so the counter is right and the
    ///      conventional name is wrong. If circulating supply is ever wanted, add a second
    ///      counter rather than repurposing this one.
    function totalMinted(uint256 eventId) external view returns (uint256) {
        return _requireEventView(eventId).minted;
    }

    /// @return Remaining badges, or `type(uint256).max` when the event has no supply cap.
    function remainingSupply(uint256 eventId) external view returns (uint256) {
        EventData memory ev = _requireEventView(eventId);
        if (ev.maxSupply == 0) return type(uint256).max;
        return ev.maxSupply - ev.minted;
    }

    function isOpen(uint256 eventId) external view returns (bool) {
        EventData memory ev = _requireEventView(eventId);
        if (ev.startsAt != 0 && block.timestamp < ev.startsAt) return false;
        if (ev.endsAt != 0 && block.timestamp > ev.endsAt) return false;
        return ev.maxSupply == 0 || ev.minted < ev.maxSupply;
    }

    function exists(uint256 eventId) external view returns (bool) {
        return _exists(eventId);
    }

    function uri(uint256 eventId) public view override returns (string memory) {
        _requireEventView(eventId);
        return _eventURI[eventId];
    }

    /// @notice The EIP-712 domain separator, exposed so off-chain signers can be verified in tests.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function claimVoucherTypehash() external pure returns (bytes32) {
        return CLAIM_VOUCHER_TYPEHASH;
    }

    /* ---------------------------------------------------------------------- */
    /*                                INTERNALS                                */
    /* ---------------------------------------------------------------------- */

    /// @dev Badges are non-transferable unless their event opts in. Mints (`from == 0`) and
    ///      burns (`to == 0`) are always permitted.
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        if (from != address(0) && to != address(0)) {
            for (uint256 i; i < ids.length; ++i) {
                if (!_events[ids[i]].transferable) revert Soulbound(ids[i]);
            }
        }
        super._update(from, to, ids, values);
    }

    function _exists(uint256 eventId) private view returns (bool) {
        return _events[eventId].organizer != address(0);
    }

    function _requireEvent(uint256 eventId) private view returns (EventData storage ev) {
        ev = _events[eventId];
        if (ev.organizer == address(0)) revert UnknownEvent(eventId);
    }

    function _requireEventView(uint256 eventId) private view returns (EventData memory ev) {
        ev = _events[eventId];
        if (ev.organizer == address(0)) revert UnknownEvent(eventId);
    }

    function _requireOpen(uint256 eventId, EventData storage ev) private view {
        if (ev.startsAt != 0 && block.timestamp < ev.startsAt) revert ClaimWindowClosed(eventId);
        if (ev.endsAt != 0 && block.timestamp > ev.endsAt) revert ClaimWindowClosed(eventId);
    }
}
