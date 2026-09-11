// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ASCRepoDeskHarness} from "./harness/ASCRepoDeskHarness.sol";
import {ASCRepoDesk} from "../sol/ASCRepoDesk.sol";
import {CollateralRegistry} from "../sol/CollateralRegistry.sol";
import {TestERC20} from "./TestERC20.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

contract ASCRepoDeskTest is Test {
    ASCRepoDeskHarness internal desk;

    bytes32 internal constant AGREEMENT_ID = keccak256("MEU-GOLD-001");
    address internal constant SOURCE_REGISTRY = address(0xA11CE);
    address internal constant SOURCE_BORROWER = address(0xB0B);
    address internal constant BULLION = address(0x9010);

    // Live Chainlink XAU/USD aggregator on Ethereum mainnet (chain key 3).
    address internal constant XAU_AGGREGATOR = 0x0e3dd634FFbF7EA89BbDCF09Ccc463302FD5f903;

    address internal lender = makeAddr("lender");
    address internal borrowerPayout = makeAddr("borrowerPayout");

    uint256 internal constant COLLATERAL_AMOUNT = 10 ether; // 10 fine troy ounces, 18 decimals
    uint256 internal constant SPOT = 4_349_13500000; // $4,349.135/oz at 8 decimals
    uint256 internal constant PRINCIPAL = 40 ether; // tCTC actually disbursed
    uint256 internal constant PRINCIPAL_USD = 20_000e8; // credit extended, 8 decimals
    uint256 internal constant REQUIRED_REPAYMENT = 5 ether;
    uint16 internal constant ADVANCE_RATE_BPS = 6_000;
    uint16 internal constant MAINTENANCE_BPS = 7_500;
    uint64 internal maturity;
    uint64 internal round = 10_211;

    function setUp() public {
        vm.warp(1_780_000_000);
        desk = new ASCRepoDeskHarness();
        desk.registerSourceRegistry(SOURCE_REGISTRY);
        desk.registerPriceAggregator(XAU_AGGREGATOR);
        desk.registerCollateralAsset(BULLION, 18, ADVANCE_RATE_BPS, MAINTENANCE_BPS);
        maturity = uint64(block.timestamp + 30 days);
        vm.deal(lender, 100 ether);
        _offerTerms();
        _proveSpot(SPOT);
    }

    function test_provedPrice_marksTheBookToMarket() public view {
        (uint256 answer, uint64 roundId,) = desk.goldPrice();
        assertEq(answer, SPOT);
        assertEq(roundId, 10_212);
    }

    function test_provedPrice_rejectsUntrustedAggregator() public {
        EvmV1Decoder.ReceiptFields memory receipt = _priceReceipt(address(0xBAD), SPOT, 99_999);

        vm.expectRevert(abi.encodeWithSelector(ASCRepoDesk.UntrustedEmitter.selector, address(0xBAD)));
        desk.exposeProcessPriceUpdate(keccak256("bad"), receipt);
    }

    function test_provedPrice_rejectsReplayedRound() public {
        EvmV1Decoder.ReceiptFields memory receipt = _priceReceipt(XAU_AGGREGATOR, 1e8, 10_212);

        vm.expectRevert(abi.encodeWithSelector(ASCRepoDesk.StaleRound.selector, uint64(10_212), uint64(10_212)));
        desk.exposeProcessPriceUpdate(keccak256("replay"), receipt);
    }

    function test_collateralValue_usesProvedSpot() public {
        _lockCollateral();
        // 10 oz × $4,349.135 = $43,491.35
        assertEq(desk.collateralValueUsd(AGREEMENT_ID), 43_491_35000000);
    }

    function test_collateralValue_rejectsStalePrice() public {
        _lockCollateral();
        vm.warp(block.timestamp + 27 hours);

        vm.expectRevert(abi.encodeWithSelector(ASCRepoDesk.StalePrice.selector, uint64(block.timestamp - 27 hours)));
        desk.collateralValueUsd(AGREEMENT_ID);
    }

    function test_provedPledge_rejectsUnacceptedBullion() public {
        address scrap = address(0xDEAD);
        EvmV1Decoder.ReceiptFields memory receipt = _pledgeReceipt(SOURCE_REGISTRY, SOURCE_BORROWER, scrap);

        vm.expectRevert(abi.encodeWithSelector(ASCRepoDesk.CollateralNotAccepted.selector, scrap));
        desk.exposeProcessPledge(keccak256("q1"), receipt);
    }

    function test_provedPledge_rejectsUntrustedEmitter() public {
        address impostor = address(0xBAD);
        EvmV1Decoder.ReceiptFields memory receipt = _pledgeReceipt(impostor, SOURCE_BORROWER, BULLION);

        vm.expectRevert(abi.encodeWithSelector(ASCRepoDesk.UntrustedEmitter.selector, impostor));
        desk.exposeProcessPledge(keccak256("q1"), receipt);
    }

    function test_drawPrincipal_requiresProvedCollateral() public {
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(ASCRepoDesk.UnexpectedStatus.selector, AGREEMENT_ID, ASCRepoDesk.RepoStatus.Offered)
        );
        desk.drawPrincipal{value: PRINCIPAL}(AGREEMENT_ID);
    }

    function test_drawPrincipal_enforcesAdvanceRate() public {
        bytes32 greedyId = keccak256("MEU-GOLD-002");
        vm.prank(lender);
        // $40,000 against $43,491.35 of gold is 92% LTV, over the 60% advance rate.
        desk.offerTerms(greedyId, borrowerPayout, SOURCE_BORROWER, PRINCIPAL, 40_000e8, REQUIRED_REPAYMENT, maturity);
        desk.exposeProcessPledge(keccak256("q2"), _pledgeReceiptFor(greedyId, SOURCE_REGISTRY, SOURCE_BORROWER, BULLION));

        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(ASCRepoDesk.ExceedsAdvanceRate.selector, 40_000e8, uint256(26_094_81000000))
        );
        desk.drawPrincipal{value: PRINCIPAL}(greedyId);
    }

    function test_drawPrincipal_paysBorrowerWithinAdvanceRate() public {
        _lockCollateral();

        vm.prank(lender);
        desk.drawPrincipal{value: PRINCIPAL}(AGREEMENT_ID);

        assertEq(borrowerPayout.balance, PRINCIPAL);
        assertEq(uint8(desk.getAgreement(AGREEMENT_ID).status), uint8(ASCRepoDesk.RepoStatus.Funded));
    }

    function test_marginCall_firesWhenProvedSpotFalls() public {
        _fund();
        // $2,000/oz puts 10 oz at $20,000; the 75% maintenance margin no longer covers $20,000.
        _proveSpot(2_000e8);

        desk.markUndercollateralised(AGREEMENT_ID);

        assertTrue(desk.getAgreement(AGREEMENT_ID).marginCalled);
    }

    function test_marginCall_rejectedWhileCoverageHolds() public {
        _fund();

        vm.expectRevert(
            abi.encodeWithSelector(ASCRepoDesk.CoverageAdequate.selector, uint256(43_491_35000000), PRINCIPAL_USD)
        );
        desk.markUndercollateralised(AGREEMENT_ID);
    }

    function test_marginCall_clearsWhenSpotRecovers() public {
        _fund();
        _proveSpot(2_000e8);
        desk.markUndercollateralised(AGREEMENT_ID);

        _proveSpot(4_000e8);
        desk.clearMarginCall(AGREEMENT_ID);

        assertFalse(desk.getAgreement(AGREEMENT_ID).marginCalled);
    }

    function test_provedPayments_accumulate() public {
        _fund();

        desk.exposeProcessPayment(keccak256("p1"), _paymentReceipt(SOURCE_REGISTRY, 3 ether));
        desk.exposeProcessPayment(keccak256("p2"), _paymentReceipt(SOURCE_REGISTRY, 2 ether));

        assertEq(desk.getAgreement(AGREEMENT_ID).repaid, REQUIRED_REPAYMENT);
    }

    function test_release_requiresFullProvedRepayment() public {
        _fund();
        desk.exposeProcessPayment(keccak256("p1"), _paymentReceipt(SOURCE_REGISTRY, 3 ether));
        EvmV1Decoder.ReceiptFields memory receipt = _releaseReceipt(SOURCE_REGISTRY, SOURCE_BORROWER);

        vm.expectRevert(
            abi.encodeWithSelector(ASCRepoDesk.RepaymentOutstanding.selector, 3 ether, REQUIRED_REPAYMENT)
        );
        desk.exposeProcessRelease(keccak256("r1"), receipt);
    }

    function test_release_closesAgreement() public {
        _fund();
        desk.exposeProcessPayment(keccak256("p1"), _paymentReceipt(SOURCE_REGISTRY, REQUIRED_REPAYMENT));
        desk.exposeProcessRelease(keccak256("r1"), _releaseReceipt(SOURCE_REGISTRY, SOURCE_BORROWER));

        assertEq(uint8(desk.getAgreement(AGREEMENT_ID).status), uint8(ASCRepoDesk.RepoStatus.Released));
    }

    function test_markDefaulted_rejectsBeforeMaturity() public {
        _fund();

        vm.expectRevert(abi.encodeWithSelector(ASCRepoDesk.NotMature.selector, maturity));
        desk.markDefaulted(AGREEMENT_ID);
    }

    function test_markDefaulted_onUnprovedRepaymentAtMaturity() public {
        _fund();
        vm.warp(maturity + 1);

        desk.markDefaulted(AGREEMENT_ID);

        assertEq(uint8(desk.getAgreement(AGREEMENT_ID).status), uint8(ASCRepoDesk.RepoStatus.Defaulted));
    }

    function test_markDefaulted_rejectsWhenRepaymentProved() public {
        _fund();
        desk.exposeProcessPayment(keccak256("p1"), _paymentReceipt(SOURCE_REGISTRY, REQUIRED_REPAYMENT));
        vm.warp(maturity + 1);

        vm.expectRevert(ASCRepoDesk.RepaymentSatisfied.selector);
        desk.markDefaulted(AGREEMENT_ID);
    }

    function test_eventSignatures_matchSourceRegistry() public {
        TestERC20 token = new TestERC20();
        CollateralRegistry registry = new CollateralRegistry();
        token.mint(address(this), COLLATERAL_AMOUNT);
        token.approve(address(registry), COLLATERAL_AMOUNT);

        vm.recordLogs();
        registry.pledge(AGREEMENT_ID, address(token), COLLATERAL_AMOUNT, lender);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        Vm.Log memory pledged = logs[logs.length - 1];
        assertEq(pledged.topics[0], desk.COLLATERAL_PLEDGED_SIGNATURE());
        assertEq(pledged.topics.length, 3);
        assertEq(pledged.data.length, 96);
    }

    /// @dev Pins the constant to the topic0 the live mainnet aggregator actually emits.
    function test_answerUpdatedSignature_matchesChainlink() public view {
        assertEq(
            desk.ANSWER_UPDATED_SIGNATURE(),
            0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f
        );
    }

    function _offerTerms() internal {
        vm.prank(lender);
        desk.offerTerms(
            AGREEMENT_ID, borrowerPayout, SOURCE_BORROWER, PRINCIPAL, PRINCIPAL_USD, REQUIRED_REPAYMENT, maturity
        );
    }

    function _proveSpot(uint256 answer) internal {
        round += 1;
        desk.exposeProcessPriceUpdate(keccak256(abi.encode(round)), _priceReceipt(XAU_AGGREGATOR, answer, round));
    }

    function _lockCollateral() internal {
        desk.exposeProcessPledge(keccak256("q1"), _pledgeReceipt(SOURCE_REGISTRY, SOURCE_BORROWER, BULLION));
    }

    function _fund() internal {
        _lockCollateral();
        vm.prank(lender);
        desk.drawPrincipal{value: PRINCIPAL}(AGREEMENT_ID);
    }

    function _receipt(EvmV1Decoder.LogEntry memory log)
        internal
        pure
        returns (EvmV1Decoder.ReceiptFields memory receipt)
    {
        EvmV1Decoder.LogEntry[] memory logs = new EvmV1Decoder.LogEntry[](1);
        logs[0] = log;
        receipt.receiptStatus = 1;
        receipt.receiptLogs = logs;
    }

    function _priceReceipt(address emitter, uint256 answer, uint64 roundId)
        internal
        view
        returns (EvmV1Decoder.ReceiptFields memory)
    {
        EvmV1Decoder.LogEntry memory log;
        log.address_ = emitter;
        log.topics = new bytes32[](3);
        log.topics[0] = desk.ANSWER_UPDATED_SIGNATURE();
        log.topics[1] = bytes32(answer);
        log.topics[2] = bytes32(uint256(roundId));
        log.data = abi.encode(block.timestamp);
        return _receipt(log);
    }

    function _pledgeReceipt(address emitter, address borrower, address token)
        internal
        view
        returns (EvmV1Decoder.ReceiptFields memory)
    {
        return _pledgeReceiptFor(AGREEMENT_ID, emitter, borrower, token);
    }

    function _pledgeReceiptFor(bytes32 agreementId, address emitter, address borrower, address token)
        internal
        view
        returns (EvmV1Decoder.ReceiptFields memory)
    {
        EvmV1Decoder.LogEntry memory log;
        log.address_ = emitter;
        log.topics = new bytes32[](3);
        log.topics[0] = desk.COLLATERAL_PLEDGED_SIGNATURE();
        log.topics[1] = agreementId;
        log.topics[2] = bytes32(uint256(uint160(borrower)));
        log.data = abi.encode(token, COLLATERAL_AMOUNT, lender);
        return _receipt(log);
    }

    function _paymentReceipt(address emitter, uint256 amount)
        internal
        view
        returns (EvmV1Decoder.ReceiptFields memory)
    {
        EvmV1Decoder.LogEntry memory log;
        log.address_ = emitter;
        log.topics = new bytes32[](3);
        log.topics[0] = desk.SERVICING_PAYMENT_SIGNATURE();
        log.topics[1] = AGREEMENT_ID;
        log.topics[2] = bytes32(uint256(uint160(SOURCE_BORROWER)));
        log.data = abi.encode(amount);
        return _receipt(log);
    }

    function _releaseReceipt(address emitter, address borrower)
        internal
        view
        returns (EvmV1Decoder.ReceiptFields memory)
    {
        EvmV1Decoder.LogEntry memory log;
        log.address_ = emitter;
        log.topics = new bytes32[](3);
        log.topics[0] = desk.COLLATERAL_RELEASED_SIGNATURE();
        log.topics[1] = AGREEMENT_ID;
        log.topics[2] = bytes32(uint256(uint160(borrower)));
        log.data = abi.encode(COLLATERAL_AMOUNT);
        return _receipt(log);
    }
}
