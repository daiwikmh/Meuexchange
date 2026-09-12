// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ProvedGold} from "../../sol/ProvedGold.sol";

contract ProvedGoldHarness is ProvedGold {
    function exposeProcess(uint8 action, bytes32 queryId, bytes memory encodedTransaction) external {
        _processAndEmitEvent(action, queryId, encodedTransaction);
    }
}
