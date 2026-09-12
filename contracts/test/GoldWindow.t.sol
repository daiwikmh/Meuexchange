// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {GoldWindow} from "../sol/GoldWindow.sol";
import {TestUSD} from "../sol/TestUSD.sol";
import {TestBullion} from "../sol/TestBullion.sol";

contract StubPrice {
    uint256 public answer;
    uint64 public roundId;
    uint64 public updatedAt;

    function set(uint256 a, uint64 r, uint64 u) external {
        (answer, roundId, updatedAt) = (a, r, u);
    }

    function goldPrice() external view returns (uint256, uint64, uint64) {
        return (answer, roundId, updatedAt);
    }
}

contract GoldWindowTest is Test {
    GoldWindow internal window;
    TestBullion internal gold;
    TestUSD internal usd;
    StubPrice internal price;

    // The round actually proved on Creditcoin: $4,349.135/oz at 8 decimals.
    uint256 internal constant SPOT = 4_349_13500000;
    uint16 internal constant SPREAD_BPS = 50; // 0.50%

    address internal trader = makeAddr("trader");

    function setUp() public {
        vm.warp(1_780_000_000);
        gold = new TestBullion();
        usd = new TestUSD();
        price = new StubPrice();
        price.set(SPOT, 10_212, uint64(block.timestamp));

        window = new GoldWindow(address(gold), address(usd), address(price), SPREAD_BPS);

        gold.mint(address(window), 10_000 ether);
        usd.mint(address(window), 2_000_000e6);
        gold.mint(trader, 100 ether);
        usd.mint(trader, 100_000e6);

        vm.startPrank(trader);
        gold.approve(address(window), type(uint256).max);
        usd.approve(address(window), type(uint256).max);
        vm.stopPrank();
    }

    function test_midPrice_convertsTroyOuncesToGrams() public view {
        // $4,349.135 per troy ounce / 31.1034768 g = $139.828… per gram
        uint256 mid = window.midUsdPerGram();
        assertApproxEqAbs(mid, 139_828_000, 1_000);
    }

    function test_quote_appliesSpreadBothWays() public view {
        (uint256 buyUsd, uint256 sellUsd) = window.quote(1 ether);
        uint256 mid = window.midUsdPerGram();

        assertGt(buyUsd, mid, "buyers pay above mid");
        assertLt(sellUsd, mid, "sellers receive below mid");
        assertApproxEqAbs(buyUsd - mid, mid - sellUsd, 2, "spread is symmetric");
    }

    function test_buy_fillsAtProvedRound() public {
        (uint256 buyUsd,) = window.quote(10 ether);
        uint256 before = usd.balanceOf(trader);

        vm.prank(trader);
        window.buy(10 ether);

        assertEq(gold.balanceOf(trader), 110 ether);
        assertEq(before - usd.balanceOf(trader), buyUsd);
    }

    function test_sell_returnsUsdAtProvedRound() public {
        (, uint256 sellUsd) = window.quote(10 ether);
        uint256 before = usd.balanceOf(trader);

        vm.prank(trader);
        window.sell(10 ether);

        assertEq(gold.balanceOf(trader), 90 ether);
        assertEq(usd.balanceOf(trader) - before, sellUsd);
    }

    function test_roundTripCostsExactlyTheSpread() public {
        uint256 before = usd.balanceOf(trader);

        vm.startPrank(trader);
        window.buy(10 ether);
        window.sell(10 ether);
        vm.stopPrank();

        (uint256 buyUsd, uint256 sellUsd) = window.quote(10 ether);
        assertEq(before - usd.balanceOf(trader), buyUsd - sellUsd);
        assertEq(gold.balanceOf(trader), 100 ether, "trader is flat again");
    }

    function test_windowClosesOnStalePrice() public {
        vm.warp(block.timestamp + 27 hours);

        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(GoldWindow.StalePrice.selector, uint64(block.timestamp - 27 hours))
        );
        window.buy(1 ether);
    }

    function test_windowClosesWithNoProvedPrice() public {
        price.set(0, 0, 0);

        vm.prank(trader);
        vm.expectRevert(GoldWindow.NoPrice.selector);
        window.buy(1 ether);
    }

    function test_priceMovesWithTheProvedRound() public {
        uint256 firstQuote = window.midUsdPerGram();
        price.set(2_000e8, 10_213, uint64(block.timestamp));

        assertLt(window.midUsdPerGram(), firstQuote, "a lower proved round lowers the fill price");
    }

    function test_cannotBuyBeyondGoldInventory() public {
        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(GoldWindow.InsufficientGoldInventory.selector, 20_000 ether, 10_000 ether)
        );
        window.buy(20_000 ether);
    }

    function test_rejectsZeroAmount() public {
        vm.prank(trader);
        vm.expectRevert(GoldWindow.ZeroAmount.selector);
        window.buy(0);
    }

    function test_onlyOwnerSetsSpread() public {
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(GoldWindow.NotOwner.selector, trader));
        window.setSpread(100);
    }

    function test_spreadIsCapped() public {
        vm.expectRevert(abi.encodeWithSelector(GoldWindow.InvalidSpread.selector, uint16(1_001)));
        window.setSpread(1_001);
    }
}
