// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title TestBullion
 * @notice Testnet stand-in for allocated-gold tokens such as PAXG or XAUT.
 * @dev One whole token represents one fine troy ounce, matching the unit the Chainlink
 *      XAU/USD feed quotes. Freely mintable: this is collateral for a testnet demonstration,
 *      not a claim on any metal.
 */
contract TestBullion is ERC20 {
    constructor() ERC20("MEU Test Bullion", "tXAU") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
