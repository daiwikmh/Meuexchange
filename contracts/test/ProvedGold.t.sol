// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ProvedGold} from "../sol/ProvedGold.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

/// @dev Reaches the log handler directly; the RLP path needs a real proved transaction.
contract ProvedGoldTestable is ProvedGold {
    function applyReserveLog(EvmV1Decoder.LogEntry memory log) external {
        if (log.address_ != reserveFeed) revert UntrustedEmitter(log.address_);
        if (log.topics.length != 3 || log.data.length != 32) revert MalformedLog();
        int256 answer = int256(uint256(log.topics[1]));
        if (answer <= 0) revert MalformedLog();
        uint64 roundId = uint64(uint256(log.topics[2]));
        if (roundId <= reserveRoundId) revert StaleRound(roundId, reserveRoundId);
        provedReserves = uint256(answer);
        reserveRoundId = roundId;
        reserveUpdatedAt = uint64(abi.decode(log.data, (uint256)));
        emit ReservesProved(provedReserves, roundId, reserveUpdatedAt, bytes32(0));
    }
}

contract ProvedGoldTest is Test {
    ProvedGoldTestable internal gold;

    // Live Chainlink KAU Reserves aggregator on Ethereum mainnet (chain key 3).
    address internal constant KAU_AGGREGATOR = 0x9b3a984d1abbe03845CBa7A895f1ff7f4209d59c;
    // Reserves that feed actually reported: 2,567,133.466 grams of vaulted gold.
    uint256 internal constant RESERVES = 2_567_133_466_000_000_000_000_000;

    address internal holder = makeAddr("holder");
    uint64 internal round = 500;

    function setUp() public {
        vm.warp(1_780_000_000);
        gold = new ProvedGoldTestable();
        gold.registerReserveFeed(KAU_AGGREGATOR);
    }

    function test_token_isGramDenominated() public view {
        assertEq(gold.symbol(), "pGOLD");
        assertEq(gold.decimals(), 18);
    }

    function test_cannotIssueBeforeAnyReserveProof() public {
        vm.expectRevert(ProvedGold.NoReservesProved.selector);
        gold.issue(holder, 1 ether);
    }

    function test_provedReserves_setHeadroom() public {
        _proveReserves(RESERVES);
        assertEq(gold.provedReserves(), RESERVES);
        assertEq(gold.headroom(), RESERVES);
    }

    function test_issueWithinProvedReserves() public {
        _proveReserves(RESERVES);
        gold.issue(holder, 1_000 ether);

        assertEq(gold.balanceOf(holder), 1_000 ether);
        assertEq(gold.headroom(), RESERVES - 1_000 ether);
    }

    function test_cannotIssueBeyondProvedReserves() public {
        _proveReserves(1_000 ether);

        vm.expectRevert(abi.encodeWithSelector(ProvedGold.ExceedsProvedReserves.selector, 1_001 ether, 1_000 ether));
        gold.issue(holder, 1_001 ether);
    }

    function test_headroomShrinksAsSupplyGrows() public {
        _proveReserves(1_000 ether);
        gold.issue(holder, 600 ether);

        vm.expectRevert(abi.encodeWithSelector(ProvedGold.ExceedsProvedReserves.selector, 500 ether, 400 ether));
        gold.issue(holder, 500 ether);
    }

    function test_redeemReturnsHeadroom() public {
        _proveReserves(1_000 ether);
        gold.issue(holder, 600 ether);

        vm.prank(holder);
        gold.redeem(200 ether);

        assertEq(gold.headroom(), 600 ether);
    }

    function test_staleReservesFreezeIssuance() public {
        _proveReserves(RESERVES);
        vm.warp(block.timestamp + 27 hours);

        vm.expectRevert(
            abi.encodeWithSelector(ProvedGold.StaleReserves.selector, uint64(block.timestamp - 27 hours))
        );
        gold.issue(holder, 1 ether);
    }

    function test_rejectsUntrustedFeed() public {
        EvmV1Decoder.LogEntry memory log = _reserveLog(address(0xBAD), RESERVES, 501);

        vm.expectRevert(abi.encodeWithSelector(ProvedGold.UntrustedEmitter.selector, address(0xBAD)));
        gold.applyReserveLog(log);
    }

    function test_rejectsReplayedRound() public {
        _proveReserves(RESERVES);
        EvmV1Decoder.LogEntry memory log = _reserveLog(KAU_AGGREGATOR, 1 ether, 501);

        vm.expectRevert(abi.encodeWithSelector(ProvedGold.StaleRound.selector, uint64(501), uint64(501)));
        gold.applyReserveLog(log);
    }

    function test_onlyOwnerIssues() public {
        _proveReserves(RESERVES);

        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(ProvedGold.NotOwner.selector, holder));
        gold.issue(holder, 1 ether);
    }

    function test_reserveFeedIsSetOnce() public {
        vm.expectRevert(ProvedGold.AlreadySet.selector);
        gold.registerReserveFeed(address(0x1234));
    }

    function test_answerUpdatedSignature_matchesChainlink() public view {
        assertEq(
            gold.ANSWER_UPDATED_SIGNATURE(),
            0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f
        );
    }

    function _proveReserves(uint256 grams) internal {
        round += 1;
        gold.applyReserveLog(_reserveLog(KAU_AGGREGATOR, grams, round));
    }

    function _reserveLog(address emitter, uint256 grams, uint64 roundId)
        internal
        view
        returns (EvmV1Decoder.LogEntry memory log)
    {
        log.address_ = emitter;
        log.topics = new bytes32[](3);
        log.topics[0] = gold.ANSWER_UPDATED_SIGNATURE();
        log.topics[1] = bytes32(grams);
        log.topics[2] = bytes32(uint256(roundId));
        log.data = abi.encode(block.timestamp);
    }
}
