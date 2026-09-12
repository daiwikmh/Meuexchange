// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ASCBase} from "@gluwa/asc-contracts/contracts/readability/ASCBase.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

/**
 * @title ProvedMetal
 * @notice A Creditcoin-native metal token whose supply is capped by proved vault reserves.
 * @dev The listing primitive: name, symbol and reserve aggregator are constructor arguments, so
 *      any asset with a Proof-of-Reserve feed on an attested chain can be listed without new
 *      code. `provedReserves` only moves when a round from that feed is verified here by the
 *      block-prover precompile, so the issuer cannot mint past a figure they neither control
 *      nor can forge. Denominated in the feed's own unit, so the safety-critical cap needs no
 *      unit arithmetic.
 */
contract ProvedMetal is ERC20, ASCBase {
    bytes32 public constant ANSWER_UPDATED_SIGNATURE = keccak256("AnswerUpdated(int256,uint256,uint256)");
    uint64 public constant MAX_RESERVE_AGE = 26 hours;

    address public immutable OWNER;
    address public immutable RESERVE_FEED;
    uint256 public provedReserves;
    uint64 public reserveRoundId;
    uint64 public reserveUpdatedAt;

    event ReservesProved(uint256 units, uint64 roundId, uint64 updatedAt, bytes32 indexed queryId);
    event MetalIssued(address indexed to, uint256 units, uint256 totalSupply, uint256 provedReserves);

    error NotOwner(address caller);
    error FeedNotSet();
    error NoMatchingLog();
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

    constructor(string memory name_, string memory symbol_, address reserveFeed) ERC20(name_, symbol_) {
        if (reserveFeed == address(0)) revert FeedNotSet();
        OWNER = msg.sender;
        RESERVE_FEED = reserveFeed;
    }

    function headroom() public view returns (uint256) {
        uint256 supply = totalSupply();
        return provedReserves > supply ? provedReserves - supply : 0;
    }

    function issue(address to, uint256 units) external onlyOwner {
        if (provedReserves == 0) revert NoReservesProved();
        if (block.timestamp > reserveUpdatedAt + MAX_RESERVE_AGE) revert StaleReserves(reserveUpdatedAt);

        uint256 available = headroom();
        if (units > available) revert ExceedsProvedReserves(units, available);

        _mint(to, units);

        emit MetalIssued(to, units, totalSupply(), provedReserves);
    }

    function redeem(uint256 units) external {
        _burn(msg.sender, units);
    }

    function _processAndEmitEvent(uint8, bytes32 queryId, bytes memory encodedTransaction) internal override {
        uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
        require(EvmV1Decoder.isValidTransactionType(txType), "Unsupported transaction type");
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        require(receipt.receiptStatus == 1, "Source transaction reverted");

        EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(receipt, ANSWER_UPDATED_SIGNATURE);
        if (logs.length == 0) revert NoMatchingLog();

        EvmV1Decoder.LogEntry memory log = logs[0];
        if (log.address_ != RESERVE_FEED) revert UntrustedEmitter(log.address_);
        if (log.topics.length != 3 || log.data.length != 32) revert MalformedLog();

        int256 answer = int256(uint256(log.topics[1]));
        if (answer <= 0) revert MalformedLog();

        uint64 roundId = uint64(uint256(log.topics[2]));
        if (roundId <= reserveRoundId) revert StaleRound(roundId, reserveRoundId);

        _store(uint256(answer), roundId, uint64(abi.decode(log.data, (uint256))), queryId);
    }

    function _store(uint256 units, uint64 roundId, uint64 updatedAt, bytes32 queryId) internal {
        provedReserves = units;
        reserveRoundId = roundId;
        reserveUpdatedAt = updatedAt;

        emit ReservesProved(units, roundId, updatedAt, queryId);
    }
}
