// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IProvedGoldPrice {
    function goldPrice() external view returns (uint256 answer, uint64 roundId, uint64 updatedAt);
}

/**
 * @title GoldWindow
 * @notice A two-way dealing window for proved gold, executing at the proved Chainlink round.
 * @dev The price a trade fills at is not quoted by this contract or by an operator: it is the
 *      last XAU/USD round the desk verified through the block-prover precompile. Anyone can
 *      check the fill against that round on-chain. A stale round closes the window rather than
 *      dealing on a price nobody has re-proved.
 *
 *      Inventory-backed on both sides, so the window never mints: it can only sell gold that
 *      has already been issued inside proved reserves.
 */
contract GoldWindow {
    using SafeERC20 for IERC20;

    /// @dev Troy ounce in grams, scaled by 1e7 to stay in integer arithmetic.
    uint256 public constant GRAMS_PER_TROY_OUNCE_E7 = 311_034_768;
    uint256 public constant BPS = 10_000;
    uint64 public constant MAX_PRICE_AGE = 26 hours;

    IERC20 public immutable GOLD;
    IERC20 public immutable USD;
    IProvedGoldPrice public immutable PRICE_SOURCE;
    address public immutable OWNER;
    uint16 public spreadBps;

    event Bought(address indexed buyer, uint256 grams, uint256 usdPaid, uint256 roundId);
    event Sold(address indexed seller, uint256 grams, uint256 usdReceived, uint256 roundId);
    event SpreadUpdated(uint16 spreadBps);

    error NotOwner(address caller);
    error InvalidSpread(uint16 spreadBps);
    error ZeroAmount();
    error NoPrice();
    error StalePrice(uint64 updatedAt);
    error InsufficientGoldInventory(uint256 requested, uint256 available);
    error InsufficientUsdInventory(uint256 requested, uint256 available);

    modifier onlyOwner() {
        if (msg.sender != OWNER) revert NotOwner(msg.sender);
        _;
    }

    constructor(address gold, address usd, address priceSource, uint16 initialSpreadBps) {
        if (initialSpreadBps > 1_000) revert InvalidSpread(initialSpreadBps);
        GOLD = IERC20(gold);
        USD = IERC20(usd);
        PRICE_SOURCE = IProvedGoldPrice(priceSource);
        spreadBps = initialSpreadBps;
        OWNER = msg.sender;
    }

    function setSpread(uint16 newSpreadBps) external onlyOwner {
        if (newSpreadBps > 1_000) revert InvalidSpread(newSpreadBps);
        spreadBps = newSpreadBps;
        emit SpreadUpdated(newSpreadBps);
    }

    /// @notice The proved round this window is currently dealing on.
    function provedRound() public view returns (uint256 answer, uint64 roundId, uint64 updatedAt) {
        (answer, roundId, updatedAt) = PRICE_SOURCE.goldPrice();
        if (answer == 0) revert NoPrice();
        if (block.timestamp > updatedAt + MAX_PRICE_AGE) revert StalePrice(updatedAt);
    }

    /// @notice Mid price of one gram in USD (6 decimals) at the proved round.
    function midUsdPerGram() public view returns (uint256) {
        (uint256 answer,,) = provedRound();
        return (1e18 * answer * 1e7) / (GRAMS_PER_TROY_OUNCE_E7 * 1e20);
    }

    /// @notice USD a buyer pays and a seller receives for `grams`, both 6 decimals.
    function quote(uint256 grams) public view returns (uint256 buyUsd, uint256 sellUsd) {
        (uint256 answer,,) = provedRound();
        uint256 mid = (grams * answer * 1e7) / (GRAMS_PER_TROY_OUNCE_E7 * 1e20);
        buyUsd = (mid * (BPS + spreadBps)) / BPS;
        sellUsd = (mid * (BPS - spreadBps)) / BPS;
    }

    /// @notice Buy gold at the proved round plus the spread.
    function buy(uint256 grams) external {
        if (grams == 0) revert ZeroAmount();
        (, uint64 roundId,) = provedRound();

        uint256 available = GOLD.balanceOf(address(this));
        if (grams > available) revert InsufficientGoldInventory(grams, available);

        (uint256 buyUsd,) = quote(grams);

        USD.safeTransferFrom(msg.sender, address(this), buyUsd);
        GOLD.safeTransfer(msg.sender, grams);

        emit Bought(msg.sender, grams, buyUsd, roundId);
    }

    /// @notice Sell gold back at the proved round minus the spread.
    function sell(uint256 grams) external {
        if (grams == 0) revert ZeroAmount();
        (, uint64 roundId,) = provedRound();

        (, uint256 sellUsd) = quote(grams);
        uint256 available = USD.balanceOf(address(this));
        if (sellUsd > available) revert InsufficientUsdInventory(sellUsd, available);

        GOLD.safeTransferFrom(msg.sender, address(this), grams);
        USD.safeTransfer(msg.sender, sellUsd);

        emit Sold(msg.sender, grams, sellUsd, roundId);
    }

    function fund(uint256 grams, uint256 usd) external onlyOwner {
        if (grams > 0) GOLD.safeTransferFrom(msg.sender, address(this), grams);
        if (usd > 0) USD.safeTransferFrom(msg.sender, address(this), usd);
    }

    function withdraw(uint256 grams, uint256 usd) external onlyOwner {
        if (grams > 0) GOLD.safeTransfer(msg.sender, grams);
        if (usd > 0) USD.safeTransfer(msg.sender, usd);
    }
}
