// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ASCBase} from "@gluwa/asc-contracts/contracts/readability/ASCBase.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

/**
 * @title ProvedGold
 * @notice A Creditcoin-native gold token whose supply is capped by proved vault reserves.
 * @dev The cap is not a dashboard figure. `provedReserves` only moves when a Chainlink
 *      Proof-of-Reserve round from Ethereum is verified here by the block-prover precompile, so
 *      the issuer cannot mint past a number they do not control and cannot forge. With no proof
 *      the token cannot be issued at all, and a stale round freezes issuance rather than
 *      trusting an old figure.
 *
 *      Denominated in grams to match the reserve feed exactly: the safety-critical constraint
 *      needs no unit arithmetic. Gram-to-troy-ounce conversion belongs in the pricing path,
 *      where a rounding error costs basis points instead of breaking the supply cap.
 */
contract ProvedGold is ERC20, ASCBase {
    enum GoldAction {
        ReserveUpdate
    }

    bytes32 public constant ANSWER_UPDATED_SIGNATURE = keccak256("AnswerUpdated(int256,uint256,uint256)");
    /// @dev Chainlink PoR feeds publish on a 24h heartbeat; refuse to issue on anything staler.
    uint64 public constant MAX_RESERVE_AGE = 26 hours;

    address public immutable OWNER;
    address public reserveFeed;
    uint256 public provedReserves;
    uint64 public reserveRoundId;
    uint64 public reserveUpdatedAt;

    event ReservesProved(uint256 grams, uint64 roundId, uint64 updatedAt, bytes32 indexed queryId);
    event ReserveFeedRegistered(address indexed aggregator);
    event GoldIssued(address indexed to, uint256 grams, uint256 totalSupply, uint256 provedReserves);

    error NotOwner(address caller);
    error AlreadySet();
    error FeedNotSet();
    error InvalidAction(uint8 action);
    error NoMatchingLog(bytes32 signature);
    error UntrustedEmitter(address emitter);
    error MalformedLog();
    error StaleRound(uint64 provedRound, uint64 storedRound);
    error NoReservesProved();
    error StaleReserves(uint64 updatedAt);
    error ExceedsProvedReserves(uint256 requested, uint256 headroom);

    modifier onlyOwner() {
        if (msg.sender != OWNER) revert NotOwner(msg.sender);
        _;
    }

    constructor() ERC20("MEU Proved Gold", "pGOLD") {
        OWNER = msg.sender;
    }

    /**
     * @notice Bind the Chainlink Proof-of-Reserve aggregator this token is backed against.
     * @dev Must be the aggregator, not the proxy: `EACAggregatorProxy` never emits AnswerUpdated.
     */
    function registerReserveFeed(address aggregator) external onlyOwner {
        if (aggregator == address(0)) revert FeedNotSet();
        if (reserveFeed != address(0)) revert AlreadySet();
        reserveFeed = aggregator;
        emit ReserveFeedRegistered(aggregator);
    }

    /// @notice Grams that may still be issued against the last proved reserve round.
    function headroom() public view returns (uint256) {
        uint256 supply = totalSupply();
        return provedReserves > supply ? provedReserves - supply : 0;
    }

    /// @notice Issue gold. Reverts unless a fresh reserve proof leaves room for it.
    function issue(address to, uint256 grams) external onlyOwner {
        if (provedReserves == 0) revert NoReservesProved();
        if (block.timestamp > reserveUpdatedAt + MAX_RESERVE_AGE) revert StaleReserves(reserveUpdatedAt);

        uint256 available = headroom();
        if (grams > available) revert ExceedsProvedReserves(grams, available);

        _mint(to, grams);

        emit GoldIssued(to, grams, totalSupply(), provedReserves);
    }

    /// @notice Burn issued gold, returning headroom to the issuer.
    function redeem(uint256 grams) external {
        _burn(msg.sender, grams);
    }

    function _processAndEmitEvent(uint8 action, bytes32 queryId, bytes memory encodedTransaction) internal override {
        if (action != uint8(GoldAction.ReserveUpdate)) revert InvalidAction(action);
        if (reserveFeed == address(0)) revert FeedNotSet();

        uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
        require(EvmV1Decoder.isValidTransactionType(txType), "Unsupported transaction type");
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        require(receipt.receiptStatus == 1, "Source transaction reverted");

        EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(receipt, ANSWER_UPDATED_SIGNATURE);
        if (logs.length == 0) revert NoMatchingLog(ANSWER_UPDATED_SIGNATURE);

        EvmV1Decoder.LogEntry memory log = logs[0];
        if (log.address_ != reserveFeed) revert UntrustedEmitter(log.address_);
        if (log.topics.length != 3 || log.data.length != 32) revert MalformedLog();

        int256 answer = int256(uint256(log.topics[1]));
        if (answer <= 0) revert MalformedLog();

        uint64 roundId = uint64(uint256(log.topics[2]));
        if (roundId <= reserveRoundId) revert StaleRound(roundId, reserveRoundId);

        provedReserves = uint256(answer);
        reserveRoundId = roundId;
        reserveUpdatedAt = uint64(abi.decode(log.data, (uint256)));

        emit ReservesProved(provedReserves, roundId, reserveUpdatedAt, queryId);
    }
}
