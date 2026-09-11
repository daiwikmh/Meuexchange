// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title CollateralRegistry
 * @notice Source-chain escrow for MEU repo collateral. Deployed on Ethereum Sepolia.
 * @dev Scope is deliberately minimal: hold collateral and emit unambiguous events that the
 *      Attestcoin Protocol attests and the ASCRepoDesk on Creditcoin proves. No cross-chain
 *      logic lives here — Creditcoin reads this contract, this contract never reads Creditcoin.
 */
contract CollateralRegistry {
    using SafeERC20 for IERC20;

    struct Pledge {
        address borrower;
        address beneficiary;
        address token;
        uint256 amount;
        uint256 paid;
        bool released;
    }

    mapping(bytes32 => Pledge) public pledges;

    event CollateralPledged(
        bytes32 indexed agreementId,
        address indexed borrower,
        address token,
        uint256 amount,
        address beneficiary
    );
    event ServicingPaymentMade(bytes32 indexed agreementId, address indexed payer, uint256 amount);
    event CollateralReleased(bytes32 indexed agreementId, address indexed borrower, uint256 amount);

    error AgreementExists(bytes32 agreementId);
    error UnknownAgreement(bytes32 agreementId);
    error AlreadyReleased(bytes32 agreementId);
    error NotBeneficiary(address caller);
    error ZeroAmount();

    /// @notice Escrow collateral against an agreement id issued by the ASCRepoDesk on Creditcoin.
    function pledge(bytes32 agreementId, address token, uint256 amount, address beneficiary) external {
        if (amount == 0) revert ZeroAmount();
        if (pledges[agreementId].borrower != address(0)) revert AgreementExists(agreementId);

        pledges[agreementId] = Pledge({
            borrower: msg.sender,
            beneficiary: beneficiary,
            token: token,
            amount: amount,
            paid: 0,
            released: false
        });

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit CollateralPledged(agreementId, msg.sender, token, amount, beneficiary);
    }

    /// @notice Pay servicing against an agreement. Funds move straight to the beneficiary.
    function recordPayment(bytes32 agreementId, uint256 amount) external {
        Pledge storage entry = pledges[agreementId];
        if (entry.borrower == address(0)) revert UnknownAgreement(agreementId);
        if (entry.released) revert AlreadyReleased(agreementId);
        if (amount == 0) revert ZeroAmount();

        entry.paid += amount;

        IERC20(entry.token).safeTransferFrom(msg.sender, entry.beneficiary, amount);

        emit ServicingPaymentMade(agreementId, msg.sender, amount);
    }

    /// @notice Return escrowed collateral to the borrower. Only the beneficiary may release.
    function release(bytes32 agreementId) external {
        Pledge storage entry = pledges[agreementId];
        if (entry.borrower == address(0)) revert UnknownAgreement(agreementId);
        if (entry.released) revert AlreadyReleased(agreementId);
        if (msg.sender != entry.beneficiary) revert NotBeneficiary(msg.sender);

        entry.released = true;
        uint256 amount = entry.amount;

        IERC20(entry.token).safeTransfer(entry.borrower, amount);

        emit CollateralReleased(agreementId, entry.borrower, amount);
    }
}
