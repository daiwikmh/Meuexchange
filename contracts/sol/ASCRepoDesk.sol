// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ASCBase} from "@gluwa/asc-contracts/contracts/readability/ASCBase.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

/**
 * @title ASCRepoDesk
 * @notice Attestcoin Smart Contract running a gold-backed repo desk on Creditcoin.
 * @dev The desk reads two attested source chains for two different roles:
 *      collateral custody events from the escrow registry, and the Chainlink XAU/USD
 *      aggregator's `AnswerUpdated` events for mark-to-market. Neither reaches this contract
 *      as an operator's assertion: both arrive as inclusion proofs the block-prover
 *      precompile verifies inside the same transaction as the business logic.
 */
contract ASCRepoDesk is ASCBase {
    enum RepoAction {
        CollateralPledged,
        ServicingPayment,
        CollateralReleased,
        PriceUpdate
    }

    enum RepoStatus {
        None,
        Offered,
        CollateralLocked,
        Funded,
        Released,
        Defaulted
    }

    struct Agreement {
        address lender;
        address borrowerPayout;
        address sourceBorrower;
        address collateralToken;
        uint256 collateralAmount;
        uint256 principal;
        uint256 principalUsd;
        uint256 requiredRepayment;
        uint256 repaid;
        uint64 maturity;
        bool marginCalled;
        RepoStatus status;
    }

    /// @notice Risk parameters for one accepted bullion token.
    struct CollateralAsset {
        bool accepted;
        uint8 decimals;
        uint16 advanceRateBps;
        uint16 maintenanceBps;
    }

    struct PricePoint {
        uint256 answer;
        uint64 roundId;
        uint64 updatedAt;
    }

    bytes32 public constant COLLATERAL_PLEDGED_SIGNATURE =
        keccak256("CollateralPledged(bytes32,address,address,uint256,address)");
    bytes32 public constant SERVICING_PAYMENT_SIGNATURE =
        keccak256("ServicingPaymentMade(bytes32,address,uint256)");
    bytes32 public constant COLLATERAL_RELEASED_SIGNATURE =
        keccak256("CollateralReleased(bytes32,address,uint256)");
    bytes32 public constant ANSWER_UPDATED_SIGNATURE = keccak256("AnswerUpdated(int256,uint256,uint256)");

    uint256 public constant PRICE_DECIMALS = 8;
    uint256 public constant BPS = 10_000;
    /// @dev Chainlink's XAU/USD heartbeat is 24h; refuse to lend on anything staler.
    uint64 public constant MAX_PRICE_AGE = 26 hours;

    address public immutable OWNER;
    address public sourceRegistry;
    address public priceAggregator;
    PricePoint public goldPrice;

    mapping(bytes32 => Agreement) public agreements;
    mapping(address => CollateralAsset) public collateralAssets;

    event TermsOffered(bytes32 indexed agreementId, address indexed lender, uint256 principalUsd, uint64 maturity);
    event CollateralProved(
        bytes32 indexed agreementId,
        address indexed sourceBorrower,
        address collateralToken,
        uint256 collateralAmount,
        bytes32 indexed queryId
    );
    event PrincipalDrawn(bytes32 indexed agreementId, address indexed borrowerPayout, uint256 principal, uint256 ltvBps);
    event RepaymentProved(bytes32 indexed agreementId, uint256 amount, uint256 totalRepaid, bytes32 indexed queryId);
    event AgreementReleased(bytes32 indexed agreementId, bytes32 indexed queryId);
    event AgreementDefaulted(bytes32 indexed agreementId, uint256 repaid, uint256 requiredRepayment);
    event GoldPriceProved(uint256 answer, uint64 roundId, uint64 updatedAt, bytes32 indexed queryId);
    event MarginCalled(bytes32 indexed agreementId, uint256 collateralUsd, uint256 principalUsd);
    event MarginCallCleared(bytes32 indexed agreementId, uint256 collateralUsd);
    event SourceRegistryRegistered(address indexed registry);
    event PriceAggregatorRegistered(address indexed aggregator);
    event CollateralAssetRegistered(address indexed token, uint16 advanceRateBps, uint16 maintenanceBps);

    error NotOwner(address caller);
    error NotLender(address caller);
    error AlreadySet();
    error RegistryNotSet();
    error AgreementExists(bytes32 agreementId);
    error UnexpectedStatus(bytes32 agreementId, RepoStatus status);
    error InvalidAction(uint8 action);
    error InvalidTerms();
    error InvalidRiskParameters();
    error PrincipalMismatch(uint256 sent, uint256 expected);
    error NoMatchingLog(bytes32 signature);
    error UntrustedEmitter(address emitter);
    error MalformedLog();
    error BorrowerMismatch(address proved, address expected);
    error NotMature(uint64 maturity);
    error RepaymentSatisfied();
    error RepaymentOutstanding(uint256 repaid, uint256 requiredRepayment);
    error TransferFailed();
    error CollateralNotAccepted(address token);
    error NoPrice();
    error StalePrice(uint64 updatedAt);
    error StaleRound(uint64 provedRound, uint64 storedRound);
    error ExceedsAdvanceRate(uint256 principalUsd, uint256 maxPrincipalUsd);
    error CoverageAdequate(uint256 collateralUsd, uint256 principalUsd);

    modifier onlyOwner() {
        if (msg.sender != OWNER) revert NotOwner(msg.sender);
        _;
    }

    constructor() {
        OWNER = msg.sender;
    }

    /// @notice Bind the escrow registry on the collateral chain whose events this desk trusts.
    function registerSourceRegistry(address registry) external onlyOwner {
        if (registry == address(0)) revert RegistryNotSet();
        if (sourceRegistry != address(0)) revert AlreadySet();
        sourceRegistry = registry;
        emit SourceRegistryRegistered(registry);
    }

    /**
     * @notice Bind the Chainlink aggregator whose `AnswerUpdated` events mark this book to market.
     * @dev Must be the aggregator itself, not the proxy: the proxy does not emit `AnswerUpdated`.
     */
    function registerPriceAggregator(address aggregator) external onlyOwner {
        if (aggregator == address(0)) revert RegistryNotSet();
        if (priceAggregator != address(0)) revert AlreadySet();
        priceAggregator = aggregator;
        emit PriceAggregatorRegistered(aggregator);
    }

    /// @notice Accept a bullion token as collateral under an advance rate and maintenance margin.
    function registerCollateralAsset(
        address token,
        uint8 decimals,
        uint16 advanceRateBps,
        uint16 maintenanceBps
    ) external onlyOwner {
        if (token == address(0) || decimals > 36) revert InvalidRiskParameters();
        if (advanceRateBps == 0 || advanceRateBps > BPS) revert InvalidRiskParameters();
        if (maintenanceBps < advanceRateBps || maintenanceBps > BPS) revert InvalidRiskParameters();

        collateralAssets[token] = CollateralAsset({
            accepted: true,
            decimals: decimals,
            advanceRateBps: advanceRateBps,
            maintenanceBps: maintenanceBps
        });

        emit CollateralAssetRegistered(token, advanceRateBps, maintenanceBps);
    }

    /// @notice Publish repo terms. The borrower pledges against this id on the collateral chain.
    function offerTerms(
        bytes32 agreementId,
        address borrowerPayout,
        address sourceBorrower,
        uint256 principal,
        uint256 principalUsd,
        uint256 requiredRepayment,
        uint64 maturity
    ) external {
        if (agreements[agreementId].status != RepoStatus.None) revert AgreementExists(agreementId);
        if (borrowerPayout == address(0) || sourceBorrower == address(0)) revert InvalidTerms();
        if (principal == 0 || principalUsd == 0 || requiredRepayment == 0) revert InvalidTerms();
        if (maturity <= block.timestamp) revert InvalidTerms();

        Agreement storage agreement = agreements[agreementId];
        agreement.lender = msg.sender;
        agreement.borrowerPayout = borrowerPayout;
        agreement.sourceBorrower = sourceBorrower;
        agreement.principal = principal;
        agreement.principalUsd = principalUsd;
        agreement.requiredRepayment = requiredRepayment;
        agreement.maturity = maturity;
        agreement.status = RepoStatus.Offered;

        emit TermsOffered(agreementId, msg.sender, principalUsd, maturity);
    }

    /**
     * @notice Release principal to the borrower.
     * @dev Three independently proved facts gate this call: the collateral is escrowed, the
     *      bullion is an accepted asset, and a fresh mark-to-market keeps the loan inside the
     *      advance rate. None of them is an operator's word.
     */
    function drawPrincipal(bytes32 agreementId) external payable {
        Agreement storage agreement = agreements[agreementId];
        if (msg.sender != agreement.lender) revert NotLender(msg.sender);
        if (agreement.status != RepoStatus.CollateralLocked) {
            revert UnexpectedStatus(agreementId, agreement.status);
        }
        if (msg.value != agreement.principal) revert PrincipalMismatch(msg.value, agreement.principal);

        uint256 collateralUsd = collateralValueUsd(agreementId);
        CollateralAsset memory asset = collateralAssets[agreement.collateralToken];
        uint256 maxPrincipalUsd = (collateralUsd * asset.advanceRateBps) / BPS;
        if (agreement.principalUsd > maxPrincipalUsd) {
            revert ExceedsAdvanceRate(agreement.principalUsd, maxPrincipalUsd);
        }

        agreement.status = RepoStatus.Funded;

        (bool sent,) = agreement.borrowerPayout.call{value: msg.value}("");
        if (!sent) revert TransferFailed();

        emit PrincipalDrawn(agreementId, agreement.borrowerPayout, msg.value, (agreement.principalUsd * BPS) / collateralUsd);
    }

    /// @notice Mark an agreement defaulted when maturity passes with repayment unproved.
    function markDefaulted(bytes32 agreementId) external {
        Agreement storage agreement = agreements[agreementId];
        if (agreement.status != RepoStatus.Funded) revert UnexpectedStatus(agreementId, agreement.status);
        if (block.timestamp <= agreement.maturity) revert NotMature(agreement.maturity);
        if (agreement.repaid >= agreement.requiredRepayment) revert RepaymentSatisfied();

        agreement.status = RepoStatus.Defaulted;

        emit AgreementDefaulted(agreementId, agreement.repaid, agreement.requiredRepayment);
    }

    /**
     * @notice Flag a funded agreement whose proved bullion value no longer covers the maintenance
     *         margin. Permissionless, and driven purely by the last proved Chainlink round.
     */
    function markUndercollateralised(bytes32 agreementId) external {
        Agreement storage agreement = agreements[agreementId];
        if (agreement.status != RepoStatus.Funded) revert UnexpectedStatus(agreementId, agreement.status);

        uint256 collateralUsd = collateralValueUsd(agreementId);
        CollateralAsset memory asset = collateralAssets[agreement.collateralToken];
        uint256 maintainedUsd = (collateralUsd * asset.maintenanceBps) / BPS;
        if (maintainedUsd >= agreement.principalUsd) revert CoverageAdequate(collateralUsd, agreement.principalUsd);

        agreement.marginCalled = true;

        emit MarginCalled(agreementId, collateralUsd, agreement.principalUsd);
    }

    /// @notice Lift a margin call once a later proved round restores coverage.
    function clearMarginCall(bytes32 agreementId) external {
        Agreement storage agreement = agreements[agreementId];
        if (!agreement.marginCalled) revert CoverageAdequate(0, agreement.principalUsd);

        uint256 collateralUsd = collateralValueUsd(agreementId);
        CollateralAsset memory asset = collateralAssets[agreement.collateralToken];
        if ((collateralUsd * asset.maintenanceBps) / BPS < agreement.principalUsd) {
            revert UnexpectedStatus(agreementId, agreement.status);
        }

        agreement.marginCalled = false;

        emit MarginCallCleared(agreementId, collateralUsd);
    }

    /// @notice USD value of the pledged bullion at the last proved Chainlink round, 8 decimals.
    function collateralValueUsd(bytes32 agreementId) public view returns (uint256) {
        Agreement memory agreement = agreements[agreementId];
        CollateralAsset memory asset = collateralAssets[agreement.collateralToken];
        if (!asset.accepted) revert CollateralNotAccepted(agreement.collateralToken);
        if (goldPrice.answer == 0) revert NoPrice();
        if (block.timestamp > goldPrice.updatedAt + MAX_PRICE_AGE) revert StalePrice(goldPrice.updatedAt);

        return (agreement.collateralAmount * goldPrice.answer) / (10 ** asset.decimals);
    }

    function getAgreement(bytes32 agreementId) external view returns (Agreement memory) {
        return agreements[agreementId];
    }

    function _processAndEmitEvent(uint8 action, bytes32 queryId, bytes memory encodedTransaction) internal override {
        EvmV1Decoder.ReceiptFields memory receipt = _decodeSuccessfulReceipt(encodedTransaction);

        if (action == uint8(RepoAction.CollateralPledged)) {
            _processPledge(queryId, receipt);
        } else if (action == uint8(RepoAction.ServicingPayment)) {
            _processPayment(queryId, receipt);
        } else if (action == uint8(RepoAction.CollateralReleased)) {
            _processRelease(queryId, receipt);
        } else if (action == uint8(RepoAction.PriceUpdate)) {
            _processPriceUpdate(queryId, receipt);
        } else {
            revert InvalidAction(action);
        }
    }

    function _decodeSuccessfulReceipt(bytes memory encodedTransaction)
        internal
        pure
        returns (EvmV1Decoder.ReceiptFields memory)
    {
        uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
        require(EvmV1Decoder.isValidTransactionType(txType), "Unsupported transaction type");

        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        require(receipt.receiptStatus == 1, "Source transaction reverted");

        return receipt;
    }

    function _trustedLog(
        EvmV1Decoder.ReceiptFields memory receipt,
        bytes32 signature,
        address expectedEmitter,
        uint256 topicCount
    ) internal pure returns (EvmV1Decoder.LogEntry memory log) {
        if (expectedEmitter == address(0)) revert RegistryNotSet();

        EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(receipt, signature);
        if (logs.length == 0) revert NoMatchingLog(signature);

        log = logs[0];
        if (log.address_ != expectedEmitter) revert UntrustedEmitter(log.address_);
        if (log.topics.length != topicCount) revert MalformedLog();
    }

    function _processPledge(bytes32 queryId, EvmV1Decoder.ReceiptFields memory receipt) internal {
        EvmV1Decoder.LogEntry memory log = _trustedLog(receipt, COLLATERAL_PLEDGED_SIGNATURE, sourceRegistry, 3);
        if (log.data.length != 96) revert MalformedLog();

        bytes32 agreementId = log.topics[1];
        address borrower = address(uint160(uint256(log.topics[2])));
        (address token, uint256 amount,) = abi.decode(log.data, (address, uint256, address));

        Agreement storage agreement = agreements[agreementId];
        if (agreement.status != RepoStatus.Offered) revert UnexpectedStatus(agreementId, agreement.status);
        if (borrower != agreement.sourceBorrower) revert BorrowerMismatch(borrower, agreement.sourceBorrower);
        if (!collateralAssets[token].accepted) revert CollateralNotAccepted(token);

        agreement.collateralToken = token;
        agreement.collateralAmount = amount;
        agreement.status = RepoStatus.CollateralLocked;

        emit CollateralProved(agreementId, borrower, token, amount, queryId);
    }

    function _processPayment(bytes32 queryId, EvmV1Decoder.ReceiptFields memory receipt) internal {
        EvmV1Decoder.LogEntry memory log = _trustedLog(receipt, SERVICING_PAYMENT_SIGNATURE, sourceRegistry, 3);
        if (log.data.length != 32) revert MalformedLog();

        bytes32 agreementId = log.topics[1];
        uint256 amount = abi.decode(log.data, (uint256));

        Agreement storage agreement = agreements[agreementId];
        if (agreement.status != RepoStatus.Funded) revert UnexpectedStatus(agreementId, agreement.status);

        agreement.repaid += amount;

        emit RepaymentProved(agreementId, amount, agreement.repaid, queryId);
    }

    function _processRelease(bytes32 queryId, EvmV1Decoder.ReceiptFields memory receipt) internal {
        EvmV1Decoder.LogEntry memory log = _trustedLog(receipt, COLLATERAL_RELEASED_SIGNATURE, sourceRegistry, 3);
        if (log.data.length != 32) revert MalformedLog();

        bytes32 agreementId = log.topics[1];
        address borrower = address(uint160(uint256(log.topics[2])));

        Agreement storage agreement = agreements[agreementId];
        if (agreement.status != RepoStatus.Funded) revert UnexpectedStatus(agreementId, agreement.status);
        if (borrower != agreement.sourceBorrower) revert BorrowerMismatch(borrower, agreement.sourceBorrower);
        if (agreement.repaid < agreement.requiredRepayment) {
            revert RepaymentOutstanding(agreement.repaid, agreement.requiredRepayment);
        }

        agreement.status = RepoStatus.Released;

        emit AgreementReleased(agreementId, queryId);
    }

    /**
     * @dev Chainlink indexes `current` and `roundId` and leaves `updatedAt` in data, so the
     *      price arrives as topics[1] and the round as topics[2]. Rounds must move forward:
     *      an older proof is still a valid proof, and replaying one would rewind the book.
     */
    function _processPriceUpdate(bytes32 queryId, EvmV1Decoder.ReceiptFields memory receipt) internal {
        EvmV1Decoder.LogEntry memory log = _trustedLog(receipt, ANSWER_UPDATED_SIGNATURE, priceAggregator, 3);
        if (log.data.length != 32) revert MalformedLog();

        int256 answer = int256(uint256(log.topics[1]));
        if (answer <= 0) revert MalformedLog();

        uint64 roundId = uint64(uint256(log.topics[2]));
        if (roundId <= goldPrice.roundId) revert StaleRound(roundId, goldPrice.roundId);

        uint64 updatedAt = uint64(abi.decode(log.data, (uint256)));

        goldPrice = PricePoint({answer: uint256(answer), roundId: roundId, updatedAt: updatedAt});

        emit GoldPriceProved(uint256(answer), roundId, updatedAt, queryId);
    }
}
