// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ASCBase} from "@gluwa/asc-contracts/contracts/readability/ASCBase.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

/**
 * @title ProvedPriceOracle
 * @notice One ASC that proves Chainlink rounds for any number of registered aggregators.
 * @dev The emitting aggregator identifies the feed, so a single contract serves every listed
 *      asset: registering a new RWA is a transaction, not a deployment. Rounds are verified by
 *      the block-prover precompile before they are stored, so nothing here was reported by an
 *      operator -- each figure was proved against the chain that actually hosts the feed.
 */
contract ProvedPriceOracle is ASCBase {
    struct Round {
        uint256 answer;
        uint64 roundId;
        uint64 updatedAt;
        uint8 decimals;
        bool registered;
    }

    bytes32 public constant ANSWER_UPDATED_SIGNATURE = keccak256("AnswerUpdated(int256,uint256,uint256)");

    address public immutable OWNER;
    mapping(address => Round) private feeds;
    address[] public aggregators;

    event AggregatorRegistered(address indexed aggregator, string description, uint8 decimals);
    event RoundProved(address indexed aggregator, uint256 answer, uint64 roundId, uint64 updatedAt, bytes32 indexed queryId);

    error NotOwner(address caller);
    error AlreadyRegistered(address aggregator);
    error UnknownAggregator(address aggregator);
    error NoMatchingLog();
    error MalformedLog();
    error StaleRound(uint64 provedRound, uint64 storedRound);
    error NoRound(address aggregator);
    error StalePrice(uint64 updatedAt);

    modifier onlyOwner() {
        if (msg.sender != OWNER) revert NotOwner(msg.sender);
        _;
    }

    constructor() {
        OWNER = msg.sender;
    }

    /**
     * @notice List a feed. `aggregator` must be the aggregator itself, not the proxy:
     *         `EACAggregatorProxy` never emits AnswerUpdated.
     */
    function registerAggregator(address aggregator, uint8 decimals, string calldata description) external onlyOwner {
        if (aggregator == address(0)) revert UnknownAggregator(aggregator);
        if (feeds[aggregator].registered) revert AlreadyRegistered(aggregator);

        feeds[aggregator].registered = true;
        feeds[aggregator].decimals = decimals;
        aggregators.push(aggregator);

        emit AggregatorRegistered(aggregator, description, decimals);
    }

    function aggregatorCount() external view returns (uint256) {
        return aggregators.length;
    }

    function round(address aggregator) external view returns (Round memory) {
        return feeds[aggregator];
    }

    /// @notice Latest proved answer, reverting if absent or older than `maxAge`.
    function latestAnswer(address aggregator, uint64 maxAge) external view returns (uint256 answer, uint64 roundId) {
        Round memory feed = feeds[aggregator];
        if (!feed.registered) revert UnknownAggregator(aggregator);
        if (feed.answer == 0) revert NoRound(aggregator);
        if (block.timestamp > feed.updatedAt + maxAge) revert StalePrice(feed.updatedAt);
        return (feed.answer, feed.roundId);
    }

    function _processAndEmitEvent(uint8, bytes32 queryId, bytes memory encodedTransaction) internal override {
        uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
        require(EvmV1Decoder.isValidTransactionType(txType), "Unsupported transaction type");
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        require(receipt.receiptStatus == 1, "Source transaction reverted");

        EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(receipt, ANSWER_UPDATED_SIGNATURE);
        if (logs.length == 0) revert NoMatchingLog();

        EvmV1Decoder.LogEntry memory log = logs[0];
        Round storage feed = feeds[log.address_];
        if (!feed.registered) revert UnknownAggregator(log.address_);
        if (log.topics.length != 3 || log.data.length != 32) revert MalformedLog();

        int256 answer = int256(uint256(log.topics[1]));
        if (answer <= 0) revert MalformedLog();

        uint64 roundId = uint64(uint256(log.topics[2]));
        if (roundId <= feed.roundId) revert StaleRound(roundId, feed.roundId);

        _store(log.address_, uint256(answer), roundId, uint64(abi.decode(log.data, (uint256))), queryId);
    }

    function _store(address aggregator, uint256 answer, uint64 roundId, uint64 updatedAt, bytes32 queryId) internal {
        Round storage feed = feeds[aggregator];
        feed.answer = answer;
        feed.roundId = roundId;
        feed.updatedAt = updatedAt;

        emit RoundProved(aggregator, answer, roundId, updatedAt, queryId);
    }
}
