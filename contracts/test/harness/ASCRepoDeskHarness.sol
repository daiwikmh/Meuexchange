// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ASCRepoDesk} from "../../sol/ASCRepoDesk.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

contract ASCRepoDeskHarness is ASCRepoDesk {
    function exposeProcessPledge(bytes32 queryId, EvmV1Decoder.ReceiptFields memory receipt) external {
        _processPledge(queryId, receipt);
    }

    function exposeProcessPayment(bytes32 queryId, EvmV1Decoder.ReceiptFields memory receipt) external {
        _processPayment(queryId, receipt);
    }

    function exposeProcessRelease(bytes32 queryId, EvmV1Decoder.ReceiptFields memory receipt) external {
        _processRelease(queryId, receipt);
    }

    function exposeProcessPriceUpdate(bytes32 queryId, EvmV1Decoder.ReceiptFields memory receipt) external {
        _processPriceUpdate(queryId, receipt);
    }
}
