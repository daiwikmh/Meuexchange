// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IProvedPriceOracle {
    function latestAnswer(address aggregator, uint64 maxAge) external view returns (uint256 answer, uint64 roundId);
}

/**
 * @title MetalWindow
 * @notice Two-way dealing window for a listed metal, filling at that metal's proved round.
 * @dev Generalises the gold window: the price aggregator is a constructor argument, so listing
 *      a tradeable asset means deploying this against its own feed rather than writing code.
 *      Fills are priced by the last round the oracle verified through the block-prover
 *      precompile; a stale round closes the window rather than dealing on a price nobody has
 *      re-proved. Inventory-backed, so the window can never mint.
 */
contract MetalWindow {
    using SafeERC20 for IERC20;

    /// @dev Troy ounce in grams, scaled by 1e7 to stay in integer arithmetic.
    uint256 public constant GRAMS_PER_TROY_OUNCE_E7 = 311_034_768;
    uint256 public constant BPS = 10_000;
    uint64 public constant MAX_PRICE_AGE = 26 hours;

    IERC20 public immutable METAL;
    IERC20 public immutable USD;
    IProvedPriceOracle public immutable ORACLE;
    address public immutable AGGREGATOR;
    address public immutable OWNER;
    uint8 private immutable METAL_DECIMALS;
    uint8 private immutable USD_DECIMALS;
    uint16 public spreadBps;

    event Bought(address indexed buyer, uint256 units, uint256 usdPaid, uint256 roundId);
    event Sold(address indexed seller, uint256 units, uint256 usdReceived, uint256 roundId);
    event SpreadUpdated(uint16 spreadBps);

    error NotOwner(address caller);
    error InvalidSpread(uint16 spreadBps);
    error ZeroAmount();
    error InsufficientMetalInventory(uint256 requested, uint256 available);
    error InsufficientUsdInventory(uint256 requested, uint256 available);

    modifier onlyOwner() {
        if (msg.sender != OWNER) revert NotOwner(msg.sender);
        _;
    }

    constructor(address metal, address usd, address oracle, address aggregator, uint16 initialSpreadBps) {
        if (initialSpreadBps > 1_000) revert InvalidSpread(initialSpreadBps);
        METAL = IERC20(metal);
        USD = IERC20(usd);
        ORACLE = IProvedPriceOracle(oracle);
        AGGREGATOR = aggregator;
        METAL_DECIMALS = IERC20Metadata(metal).decimals();
        USD_DECIMALS = IERC20Metadata(usd).decimals();
        spreadBps = initialSpreadBps;
        OWNER = msg.sender;
    }

    function setSpread(uint16 newSpreadBps) external onlyOwner {
        if (newSpreadBps > 1_000) revert InvalidSpread(newSpreadBps);
        spreadBps = newSpreadBps;
        emit SpreadUpdated(newSpreadBps);
    }

    function provedRound() public view returns (uint256 answer, uint64 roundId) {
        return ORACLE.latestAnswer(AGGREGATOR, MAX_PRICE_AGE);
    }

    /// @dev Price feeds quote per troy ounce; the token is denominated in grams.
    function _mid(uint256 units, uint256 answer) internal view returns (uint256) {
        return (units * answer * 1e7) / (GRAMS_PER_TROY_OUNCE_E7 * 10 ** (METAL_DECIMALS + 8 - USD_DECIMALS));
    }

    function midUsdPerUnit() external view returns (uint256) {
        (uint256 answer,) = provedRound();
        return _mid(10 ** METAL_DECIMALS, answer);
    }

    function quote(uint256 units) public view returns (uint256 buyUsd, uint256 sellUsd) {
        (uint256 answer,) = provedRound();
        uint256 mid = _mid(units, answer);
        buyUsd = (mid * (BPS + spreadBps)) / BPS;
        sellUsd = (mid * (BPS - spreadBps)) / BPS;
    }

    function buy(uint256 units) external {
        if (units == 0) revert ZeroAmount();
        (, uint64 roundId) = provedRound();

        uint256 available = METAL.balanceOf(address(this));
        if (units > available) revert InsufficientMetalInventory(units, available);

        (uint256 buyUsd,) = quote(units);
        USD.safeTransferFrom(msg.sender, address(this), buyUsd);
        METAL.safeTransfer(msg.sender, units);

        emit Bought(msg.sender, units, buyUsd, roundId);
    }

    function sell(uint256 units) external {
        if (units == 0) revert ZeroAmount();
        (, uint64 roundId) = provedRound();

        (, uint256 sellUsd) = quote(units);
        uint256 available = USD.balanceOf(address(this));
        if (sellUsd > available) revert InsufficientUsdInventory(sellUsd, available);

        METAL.safeTransferFrom(msg.sender, address(this), units);
        USD.safeTransfer(msg.sender, sellUsd);

        emit Sold(msg.sender, units, sellUsd, roundId);
    }

    function fund(uint256 units, uint256 usd) external onlyOwner {
        if (units > 0) METAL.safeTransferFrom(msg.sender, address(this), units);
        if (usd > 0) USD.safeTransferFrom(msg.sender, address(this), usd);
    }

    function withdraw(uint256 units, uint256 usd) external onlyOwner {
        if (units > 0) METAL.safeTransfer(msg.sender, units);
        if (usd > 0) USD.safeTransfer(msg.sender, usd);
    }
}
