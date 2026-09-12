// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ProvedPriceOracle} from "../sol/ProvedPriceOracle.sol";
import {ProvedMetal} from "../sol/ProvedMetal.sol";
import {MetalWindow} from "../sol/MetalWindow.sol";
import {TestUSD} from "../sol/TestUSD.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

/// @dev Exposes the log handler; the RLP path needs a real proved transaction.
contract OracleTestable is ProvedPriceOracle {
    function applyRoundLog(EvmV1Decoder.LogEntry memory log) external {
        Round memory feed = this.round(log.address_);
        if (!feed.registered) revert UnknownAggregator(log.address_);
        uint64 roundId = uint64(uint256(log.topics[2]));
        if (roundId <= feed.roundId) revert StaleRound(roundId, feed.roundId);
        _store(log.address_, uint256(log.topics[1]), roundId, uint64(abi.decode(log.data, (uint256))), bytes32(0));
    }
}

/// @dev Same shape for the metal side: exercise the handler, not the RLP decoder.
contract MetalTestable is ProvedMetal {
    constructor(string memory n, string memory s, address feed) ProvedMetal(n, s, feed) {}

    function applyReserveLog(uint256 units, uint64 roundId) external {
        if (roundId <= reserveRoundId) revert StaleRound(roundId, reserveRoundId);
        _store(units, roundId, uint64(block.timestamp), bytes32(0));
    }
}

contract ListingTest is Test {
    // Live Chainlink aggregators on Ethereum mainnet.
    address internal constant XAU_USD = 0x0e3dd634FFbF7EA89BbDCF09Ccc463302FD5f903;
    address internal constant XAG_USD = 0xB38d1D12Ba17aA62255e588a0bC845c1a589A50d;
    address internal constant KAG_RESERVES = 0x3B4f49f4aa5491B5a60C0724467A67b4910aEAAc;

    uint256 internal constant SILVER_SPOT = 64_48600000;          // $64.486/oz, 8dp
    uint256 internal constant SILVER_RESERVES = 3_688_827_985_000_000_000_000_000; // 3,688,827.985 g

    OracleTestable internal oracle;
    MetalTestable internal silver;
    MetalWindow internal window;
    TestUSD internal usd;

    address internal trader = makeAddr("trader");
    uint64 internal round = 100;

    function setUp() public {
        vm.warp(1_780_000_000);
        oracle = new OracleTestable();
        oracle.registerAggregator(XAG_USD, 8, "XAG / USD");
        usd = new TestUSD();
        silver = new MetalTestable("MEU Proved Silver", "pSILVER", KAG_RESERVES);
        window = new MetalWindow(address(silver), address(usd), address(oracle), XAG_USD, 50);
    }

    function test_listingIsConfiguration_notNewCode() public {
        // A second asset lists against the same oracle with one transaction.
        oracle.registerAggregator(XAU_USD, 8, "XAU / USD");
        assertEq(oracle.aggregatorCount(), 2);
        assertTrue(oracle.round(XAU_USD).registered);
        assertTrue(oracle.round(XAG_USD).registered);
    }

    function test_oracleRejectsUnregisteredAggregator() public {
        EvmV1Decoder.LogEntry memory log = _roundLog(XAU_USD, SILVER_SPOT, 101);

        vm.expectRevert(abi.encodeWithSelector(ProvedPriceOracle.UnknownAggregator.selector, XAU_USD));
        oracle.applyRoundLog(log);
    }

    function test_oracleKeepsFeedsSeparate() public {
        oracle.registerAggregator(XAU_USD, 8, "XAU / USD");
        oracle.applyRoundLog(_roundLog(XAG_USD, SILVER_SPOT, 101));
        oracle.applyRoundLog(_roundLog(XAU_USD, 4_349_13500000, 101));

        assertEq(oracle.round(XAG_USD).answer, SILVER_SPOT);
        assertEq(oracle.round(XAU_USD).answer, 4_349_13500000);
    }

    function test_silverWindowPricesOffItsOwnFeed() public {
        oracle.applyRoundLog(_roundLog(XAG_USD, SILVER_SPOT, 101));
        // $64.486 / 31.1034768 g = $2.0733… per gram
        assertApproxEqAbs(window.midUsdPerUnit(), 2_073_300, 2_000);
    }

    function test_windowClosedUntilItsFeedIsProved() public {
        vm.expectRevert(abi.encodeWithSelector(ProvedPriceOracle.NoRound.selector, XAG_USD));
        window.midUsdPerUnit();
    }

    function test_silverIssuanceCappedByProvedReserves() public {
        _proveSilverReserves(SILVER_RESERVES);
        silver.issue(trader, 1_000 ether);
        assertEq(silver.balanceOf(trader), 1_000 ether);

        vm.expectRevert(
            abi.encodeWithSelector(
                ProvedMetal.ExceedsProvedReserves.selector, SILVER_RESERVES, SILVER_RESERVES - 1_000 ether
            )
        );
        silver.issue(trader, SILVER_RESERVES);
    }

    function test_silverCannotIssueBeforeProof() public {
        vm.expectRevert(ProvedMetal.NoReservesProved.selector);
        silver.issue(trader, 1 ether);
    }

    function test_reserveFeedIsImmutablePerListing() public view {
        assertEq(silver.RESERVE_FEED(), KAG_RESERVES);
        assertEq(silver.symbol(), "pSILVER");
    }

    function test_endToEndSilverTrade() public {
        _proveSilverReserves(SILVER_RESERVES);
        oracle.applyRoundLog(_roundLog(XAG_USD, SILVER_SPOT, 101));

        silver.issue(address(this), 5_000 ether);
        usd.mint(address(this), 100_000e6);
        silver.approve(address(window), 5_000 ether);
        usd.approve(address(window), 100_000e6);
        window.fund(5_000 ether, 100_000e6);

        usd.mint(trader, 10_000e6);
        vm.startPrank(trader);
        usd.approve(address(window), type(uint256).max);
        (uint256 buyUsd,) = window.quote(100 ether);
        window.buy(100 ether);
        vm.stopPrank();

        assertEq(silver.balanceOf(trader), 100 ether);
        assertEq(usd.balanceOf(trader), 10_000e6 - buyUsd);
    }

    function _proveSilverReserves(uint256 units) internal {
        round += 1;
        silver.applyReserveLog(units, round);
    }

    function _roundLog(address aggregator, uint256 answer, uint64 roundId)
        internal
        view
        returns (EvmV1Decoder.LogEntry memory log)
    {
        log.address_ = aggregator;
        log.topics = new bytes32[](3);
        log.topics[0] = oracle.ANSWER_UPDATED_SIGNATURE();
        log.topics[1] = bytes32(answer);
        log.topics[2] = bytes32(uint256(roundId));
        log.data = abi.encode(block.timestamp);
    }
}
