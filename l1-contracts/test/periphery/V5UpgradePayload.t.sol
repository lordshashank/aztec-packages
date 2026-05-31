// SPDX-License-Identifier: UNLICENSED
// solhint-disable comprehensive-interface
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {Ownable} from "@oz/access/Ownable.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";

import {IInstance} from "@aztec/core/interfaces/IInstance.sol";
import {GSE, IGSECore} from "@aztec/governance/GSE.sol";
import {IRegistry, IHaveVersion} from "@aztec/governance/interfaces/IRegistry.sol";
import {IPayload} from "@aztec/governance/interfaces/IPayload.sol";
import {IRewardDistributor} from "@aztec/governance/interfaces/IRewardDistributor.sol";
import {Registry} from "@aztec/governance/Registry.sol";
import {RewardDistributor} from "@aztec/governance/RewardDistributor.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";

import {V5UpgradePayload} from "@aztec/periphery/V5UpgradePayload.sol";

/// @notice Stand-in for the v4 RewardDistributor deployed on the live networks.
/// @dev Mirrors the exact surface the deployed v4 distributor exposes: an owner-gated 3-arg
///      `recover(asset, to, amount)` that transfers `amount` unconditionally (no drain ceiling),
///      plus `canonicalRollup`. The deployed distributor predates AZIP-2, so it has no
///      `aggregateDebt`/`availableTo` — and the payload must not depend on them.
contract LegacyRewardDistributorMock {
  using SafeERC20 for IERC20;

  IERC20 public immutable ASSET;
  IRegistry public immutable REGISTRY;

  constructor(IERC20 _asset, IRegistry _registry) {
    ASSET = _asset;
    REGISTRY = _registry;
  }

  /// @notice The deployed v4 3-arg `recover(asset, to, amount)`: owner-gated on the registry
  ///         owner, transfers `amount` with no ceiling.
  function recover(address _asset, address _to, uint256 _amount) external {
    address owner = Ownable(address(REGISTRY)).owner();
    require(msg.sender == owner, "not gov");
    IERC20(_asset).safeTransfer(_to, _amount);
  }

  function canonicalRollup() external view returns (address) {
    return address(REGISTRY.getCanonicalRollup());
  }
}

/// @notice Minimal `IInstance` substitute. The payload only consults `getGSE()` and the version,
///         which the GSE's bookkeeping reads via the `getVersion()` selector.
contract InstanceStub {
  GSE internal immutable _gse;
  bytes32 internal immutable _versionSalt;

  constructor(GSE __gse, bytes32 __versionSalt) {
    _gse = __gse;
    _versionSalt = __versionSalt;
  }

  function getGSE() external view returns (GSE) {
    return _gse;
  }

  function getVersion() external view returns (uint256) {
    return uint256(keccak256(abi.encodePacked(bytes("aztec_rollup"), block.chainid, _versionSalt, address(this))));
  }
}

/// @notice Stand-in for the v4 instance. Same surface, just kept under a separate type so the test
///         narrative reads cleanly.
contract V4InstanceStub is InstanceStub {
  constructor(GSE __gse) InstanceStub(__gse, bytes32("v4")) {}
}

contract V5InstanceStub is InstanceStub {
  constructor(GSE __gse) InstanceStub(__gse, bytes32("v5")) {}
}

contract V5UpgradePayloadTest is Test {
  TestERC20 internal asset;
  Registry internal registry;
  GSE internal gse;
  LegacyRewardDistributorMock internal oldRd;
  RewardDistributor internal newRd;
  V4InstanceStub internal v4Rollup;
  V5InstanceStub internal v5Rollup;
  V5UpgradePayload internal payload;

  address internal constant GOVERNANCE = address(uint160(uint256(keccak256("V5UpgradePayloadTest.GOVERNANCE"))));
  uint256 internal constant LEGACY_BALANCE = 1000 ether;

  function setUp() external {
    asset = new TestERC20("Asset", "AST", address(this));

    // Stand up a registry whose initial RD will be discarded in favor of a legacy-shaped one.
    registry = new Registry(address(this), asset);

    // Stand-alone GSE so the InstanceStubs have something to advertise via getGSE().
    gse = new GSE(address(this), asset, 100e18, 50e18);

    v4Rollup = new V4InstanceStub(gse);
    v5Rollup = new V5InstanceStub(gse);

    // Make v4 canonical via the Registry's deployer-owned phase.
    registry.addRollup(IHaveVersion(address(v4Rollup)));
    gse.addRollup(address(v4Rollup));

    // Swap the registry's distributor pointer to the legacy mock and fund it.
    oldRd = new LegacyRewardDistributorMock(asset, registry);
    registry.updateRewardDistributor(address(oldRd));
    asset.mint(address(oldRd), LEGACY_BALANCE);

    // Deploy the v5 reward distributor.
    newRd = new RewardDistributor(asset, registry);

    // Hand the registry over to "governance" so subsequent admin calls require its authority.
    registry.transferOwnership(GOVERNANCE);
    gse.transferOwnership(GOVERNANCE);

    // Build the payload. Its constructor reads the registry to capture OLD_REWARD_DISTRIBUTOR.
    payload = new V5UpgradePayload(registry, IInstance(address(v5Rollup)), IRewardDistributor(address(newRd)), asset);
  }

  function test_constructor_capturesOldDistributor() external view {
    assertEq(payload.OLD_REWARD_DISTRIBUTOR(), address(oldRd));
    assertEq(address(payload.NEW_REWARD_DISTRIBUTOR()), address(newRd));
    assertEq(address(payload.NEW_ROLLUP()), address(v5Rollup));
    assertEq(address(payload.ASSET()), address(asset));
    assertEq(address(payload.REGISTRY()), address(registry));
  }

  function test_getActions_dataAndTargets() external view {
    IPayload.Action[] memory actions = payload.getActions();
    assertEq(actions.length, 4);

    assertEq(actions[0].target, address(oldRd));
    bytes memory expectedDrain =
      abi.encodeWithSelector(payload.LEGACY_RECOVER_SELECTOR(), address(asset), address(newRd), LEGACY_BALANCE);
    assertEq(actions[0].data, expectedDrain);

    assertEq(actions[1].target, address(registry));
    assertEq(actions[1].data, abi.encodeWithSelector(IRegistry.addRollup.selector, address(v5Rollup)));

    assertEq(actions[2].target, address(registry));
    assertEq(actions[2].data, abi.encodeWithSelector(IRegistry.updateRewardDistributor.selector, address(newRd)));

    assertEq(actions[3].target, address(gse));
    assertEq(actions[3].data, abi.encodeWithSelector(IGSECore.addRollup.selector, address(v5Rollup)));
  }

  function test_execute_drainsOldRdAndPromotesV5() external {
    _executeAsGovernance();

    assertEq(asset.balanceOf(address(oldRd)), 0, "old RD should be fully drained");
    assertEq(asset.balanceOf(address(newRd)), LEGACY_BALANCE, "new RD should hold the full legacy balance");
    assertEq(address(registry.getCanonicalRollup()), address(v5Rollup), "v5 should be canonical");
    assertEq(address(registry.getRewardDistributor()), address(newRd), "registry should point to new RD");
  }

  function test_execute_revertsIfNotGovernance() external {
    // Caller is this test contract, not governance, so the owner-gated legacy drain must fail.
    IPayload.Action[] memory actions = payload.getActions();
    (bool success,) = actions[0].target.call(actions[0].data);
    assertFalse(success, "drain should fail when caller is not governance");
  }

  function _executeAsGovernance() internal {
    IPayload.Action[] memory actions = payload.getActions();
    vm.startPrank(GOVERNANCE);
    for (uint256 i = 0; i < actions.length; i++) {
      (bool success, bytes memory ret) = actions[i].target.call(actions[i].data);
      require(success, _decodeError(i, ret));
    }
    vm.stopPrank();
  }

  function _decodeError(uint256 _index, bytes memory _ret) internal pure returns (string memory) {
    return string(abi.encodePacked("action ", vm.toString(_index), " failed: ", _ret));
  }
}
