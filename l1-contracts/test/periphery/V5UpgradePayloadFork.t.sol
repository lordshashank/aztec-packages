// SPDX-License-Identifier: UNLICENSED
// solhint-disable comprehensive-interface
// solhint-disable no-console
pragma solidity >=0.8.27;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {IERC20} from "@oz/token/ERC20/IERC20.sol";

import {IInstance} from "@aztec/core/interfaces/IInstance.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {IStaking} from "@aztec/core/interfaces/IStaking.sol";
import {GSE} from "@aztec/governance/GSE.sol";
import {IPayload} from "@aztec/governance/interfaces/IPayload.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IRewardDistributor} from "@aztec/governance/interfaces/IRewardDistributor.sol";
import {RewardDistributor} from "@aztec/governance/RewardDistributor.sol";

import {V5UpgradePayload} from "@aztec/periphery/V5UpgradePayload.sol";

/// @notice Minimal stand-in for the v5 rollup. The live Registry reads only `getVersion()` from a
///         rollup it adds, the live GSE reads nothing from it, and the payload reads only
///         `getGSE()` — so a stub is behaviourally equivalent to a production rollup for the four
///         governance actions, without dragging in the full rollup deployment + its env config.
contract RollupStub {
  GSE internal immutable GSE_;

  constructor(GSE _gse) {
    GSE_ = _gse;
  }

  function getGSE() external view returns (GSE) {
    return GSE_;
  }

  /// @dev Unique per deployment so `Registry.addRollup` never collides with a registered version.
  function getVersion() external view returns (uint256) {
    return uint256(keccak256(abi.encodePacked("V5UpgradePayloadFork", address(this))));
  }
}

/// @notice Forks a live network and runs the full V5 upgrade proposal against its real registry,
///         GSE, governance, and v4 RewardDistributor — exactly the four actions
///         `Governance.execute()` would run — then asserts the resulting on-chain state.
///
/// Every address other than the registry is discovered from the registry on-chain, so a subclass
/// only supplies its network's registry and RPC env var. Tests self-skip when the RPC env var is
/// unset, keeping the suite green offline.
///
/// Set `PAYLOAD=0x...` to simulate an already-deployed payload (from DeployRollupForUpgradeV5)
/// instead of an ephemeral one; the assertions are identical.
abstract contract V5UpgradePayloadForkBase is Test {
  IRegistry internal registry;
  address internal oldRd;
  address internal governance;
  GSE internal gse;
  IERC20 internal feeAsset;

  bool internal forked;

  /// @return The env var holding this network's archive RPC URL.
  function _rpcEnvVar() internal pure virtual returns (string memory);

  /// @return This network's live v4 Registry.
  function _registry() internal pure virtual returns (address);

  /// @return The fork block, or 0 to fork at the chain head.
  function _forkBlock() internal pure virtual returns (uint256);

  function setUp() external {
    string memory rpc = vm.envOr(_rpcEnvVar(), string(""));
    if (bytes(rpc).length == 0) {
      return;
    }
    uint256 forkBlock = _forkBlock();
    if (forkBlock == 0) {
      vm.createSelectFork(rpc);
    } else {
      vm.createSelectFork(rpc, forkBlock);
    }
    forked = true;

    registry = IRegistry(_registry());
    oldRd = address(registry.getRewardDistributor());
    governance = registry.getGovernance();
    IStaking v4 = IStaking(address(registry.getCanonicalRollup()));
    gse = v4.getGSE();
    feeAsset = IRollup(address(v4)).getFeeAsset();
  }

  /// @notice Documents the interface mismatch that makes the deployed v4 distributor the binding
  ///         constraint: it predates AZIP-2, exposing the unconstrained 3-arg `recover` but
  ///         neither `aggregateDebt()` nor `availableTo()`.
  function test_liveV4Distributor_isPreAZIP2() external {
    if (!forked) {
      vm.skip(true);
      return;
    }

    (bool okAsset, bytes memory assetRet) = oldRd.staticcall(abi.encodeWithSignature("ASSET()"));
    assertTrue(okAsset, "v4 distributor exposes ASSET()");
    assertEq(abi.decode(assetRet, (address)), address(feeAsset), "v4 distributor asset is the fee asset");

    (bool okCanon,) = oldRd.staticcall(abi.encodeWithSignature("canonicalRollup()"));
    assertTrue(okCanon, "v4 distributor exposes canonicalRollup()");

    (bool okDebt,) = oldRd.staticcall(abi.encodeWithSignature("aggregateDebt()"));
    assertFalse(okDebt, "v4 distributor must NOT expose aggregateDebt() -- the payload cannot rely on it");

    (bool okAvail,) = oldRd.staticcall(abi.encodeWithSignature("availableTo(address)", oldRd));
    assertFalse(okAvail, "v4 distributor must NOT expose availableTo() -- no drain ceiling exists");
  }

  /// @notice Builds the proposal and executes all four actions as governance against live state,
  ///         then asserts the canonical rollup, reward distributor, GSE registration, and the
  ///         drained balances.
  function test_fullyExecutePayload() external {
    if (!forked) {
      vm.skip(true);
      return;
    }

    (V5UpgradePayload payload, address newRollup, address newRd) = _resolvePayload();
    assertEq(payload.OLD_REWARD_DISTRIBUTOR(), oldRd, "payload captured the live v4 distributor");

    // Pre-state.
    uint256 oldBalancePre = feeAsset.balanceOf(oldRd);
    uint256 newBalancePre = feeAsset.balanceOf(newRd);
    assertFalse(gse.isRollupRegistered(newRollup), "new rollup not yet in GSE");
    assertTrue(address(registry.getCanonicalRollup()) != newRollup, "new rollup not yet canonical");

    console.log("network registry: ", address(registry));
    console.log("v4 distributor:   ", oldRd);
    console.log("drain amount:     ", oldBalancePre);

    // Execute every action exactly as Governance.execute() would.
    IPayload.Action[] memory actions = payload.getActions();
    assertEq(actions.length, 4, "four actions");
    for (uint256 i = 0; i < actions.length; i++) {
      vm.startStateDiffRecording();
      vm.prank(governance);
      (bool ok, bytes memory ret) = actions[i].target.call(actions[i].data);
      if (!ok) {
        console.log("action reverted:", i, actions[i].target);
        console.logBytes(ret);
        revert("action call failed");
      }
      _logWrites(i, vm.stopAndReturnStateDiff());
    }

    // Post-conditions.
    assertEq(address(registry.getCanonicalRollup()), newRollup, "v5 rollup is canonical");
    assertEq(address(registry.getRewardDistributor()), newRd, "registry points at the v5 distributor");
    assertTrue(gse.isRollupRegistered(newRollup), "v5 rollup registered with GSE");
    assertEq(feeAsset.balanceOf(oldRd), 0, "v4 distributor fully drained");
    assertEq(feeAsset.balanceOf(newRd) - newBalancePre, oldBalancePre, "v5 distributor received the full drain");

    console.log("v5 distributor balance after drain:", feeAsset.balanceOf(newRd));
  }

  /// @dev Uses a `PAYLOAD` env override when present, else deploys an ephemeral payload wired to a
  ///      fresh v5 distributor and a rollup stub.
  function _resolvePayload() internal returns (V5UpgradePayload payload, address newRollup, address newRd) {
    address provided = vm.envOr("PAYLOAD", address(0));
    if (provided != address(0)) {
      payload = V5UpgradePayload(provided);
      newRollup = address(payload.NEW_ROLLUP());
      newRd = address(payload.NEW_REWARD_DISTRIBUTOR());
      console.log("using deployed payload:", provided);
      return (payload, newRollup, newRd);
    }

    newRd = address(new RewardDistributor(feeAsset, registry));
    newRollup = address(new RollupStub(gse));
    payload = new V5UpgradePayload(registry, IInstance(newRollup), IRewardDistributor(newRd), feeAsset);
    console.log("deployed ephemeral payload:", address(payload));
  }

  function _logWrites(uint256 _action, Vm.AccountAccess[] memory _accesses) internal pure {
    for (uint256 i = 0; i < _accesses.length; i++) {
      uint256 writes = 0;
      for (uint256 j = 0; j < _accesses[i].storageAccesses.length; j++) {
        if (_accesses[i].storageAccesses[j].isWrite && !_accesses[i].storageAccesses[j].reverted) {
          writes++;
        }
      }
      if (writes > 0) {
        console.log("  action", _action, "wrote to", _accesses[i].account);
      }
    }
  }
}

/// @notice Sepolia testnet (registry 0xa0bf...c6ba). Run with:
///   SEPOLIA_RPC_URL=<url> forge test --match-contract V5UpgradePayloadSepoliaForkTest -vv
contract V5UpgradePayloadSepoliaForkTest is V5UpgradePayloadForkBase {
  function _rpcEnvVar() internal pure override returns (string memory) {
    return "SEPOLIA_RPC_URL";
  }

  function _registry() internal pure override returns (address) {
    return 0xA0BFb1B494FB49041e5c6e8c2C1BE09cD171c6Ba;
  }

  function _forkBlock() internal pure override returns (uint256) {
    return 10_989_654;
  }
}

/// @notice Ethereum mainnet (registry 0x35b2...e298). Run with:
///   MAINNET_RPC_URL=<url> forge test --match-contract V5UpgradePayloadMainnetForkTest -vv
contract V5UpgradePayloadMainnetForkTest is V5UpgradePayloadForkBase {
  function _rpcEnvVar() internal pure override returns (string memory) {
    return "MAINNET_RPC_URL";
  }

  function _registry() internal pure override returns (address) {
    return 0x35b22e09Ee0390539439E24f06Da43D83f90e298;
  }

  function _forkBlock() internal pure override returns (uint256) {
    return 25_245_893;
  }
}
