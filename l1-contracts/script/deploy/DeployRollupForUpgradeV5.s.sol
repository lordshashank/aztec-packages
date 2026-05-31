// SPDX-License-Identifier: Apache-2.0
// Copyright 2024 Aztec Labs.
// solhint-disable comprehensive-interface
pragma solidity >=0.8.27;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {IERC20} from "@oz/token/ERC20/IERC20.sol";

import {IInstance} from "@aztec/core/interfaces/IInstance.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {IStaking} from "@aztec/core/interfaces/IStaking.sol";

import {Governance} from "@aztec/governance/Governance.sol";
import {GSE} from "@aztec/governance/GSE.sol";
import {Registry} from "@aztec/governance/Registry.sol";
import {IRewardDistributor} from "@aztec/governance/interfaces/IRewardDistributor.sol";
import {RewardDistributor} from "@aztec/governance/RewardDistributor.sol";

import {V5UpgradePayload} from "@aztec/periphery/V5UpgradePayload.sol";

import {DeployRollupLib, RollupAddressInput, RollupAddressOutput} from "./DeployRollupLib.sol";
import {IRollupConfiguration, RollupConfiguration} from "./RollupConfiguration.sol";

/// @title DeployRollupForUpgradeV5
/// @author Aztec Labs
/// @notice Deploys the v5 rollup, v5 reward distributor, and the V5UpgradePayload that
///         governance must execute to make the deployment canonical.
///
/// Reads existing L1 infrastructure (registry, GSE, governance, assets) off the supplied
/// `REGISTRY_ADDRESS` env var. The v5 reward distributor is deployed first so it can be
/// wired into the v5 rollup constructor; both the v4 (current) distributor's address and the
/// new one are captured by the payload at its construction.
///
/// See RollupConfiguration.sol for rollup-config env vars.
/// See V5UpgradePayload.sol for the actions executed when governance accepts the payload.
///
/// For initial L1 deployments use DeployAztecL1Contracts.s.sol. For non-v5 upgrades (i.e.
/// upgrades that keep the existing reward distributor) use DeployRollupForUpgrade.s.sol.
contract DeployRollupForUpgradeV5 is Script {
  RollupAddressOutput internal _rollupOutput;
  RewardDistributor internal _newRewardDistributor;
  V5UpgradePayload internal _payload;

  function rollupOutput() external view returns (RollupAddressOutput memory) {
    return _rollupOutput;
  }

  function newRewardDistributor() external view returns (RewardDistributor) {
    return _newRewardDistributor;
  }

  function payload() external view returns (V5UpgradePayload) {
    return _payload;
  }

  function run() public {
    Registry registry = Registry(vm.envAddress("REGISTRY_ADDRESS"));
    address deployer = vm.envOr("DEPLOYER_ADDRESS", msg.sender);

    IRollupConfiguration rollupConfig = new RollupConfiguration();
    rollupConfig.loadConfig();

    // Pull existing infra from the canonical v4 rollup. Asset addresses, GSE, and governance
    // do not change in the v5 upgrade.
    IStaking v4Rollup = IStaking(address(registry.getCanonicalRollup()));
    GSE gse = v4Rollup.getGSE();
    IERC20 feeAsset = IRollup(address(v4Rollup)).getFeeAsset();
    IERC20 stakingAsset = v4Rollup.getStakingAsset();
    Governance governance = Governance(registry.getGovernance());

    vm.startBroadcast(deployer);

    // 1. Deploy the v5 reward distributor. It reads canonical from the same registry, so once
    //    the V5UpgradePayload makes v5 the canonical rollup, this distributor's implicit pool
    //    becomes claimable by v5.
    _newRewardDistributor = new RewardDistributor(feeAsset, registry);

    // 2. Deploy the v5 rollup, binding it to the new distributor at construction.
    RollupAddressInput memory input = RollupAddressInput({
      deployer: deployer,
      registry: registry,
      gse: gse,
      governance: governance,
      feeAsset: feeAsset,
      stakingAsset: stakingAsset,
      rewardDistributor: IRewardDistributor(address(_newRewardDistributor))
    });
    _rollupOutput = DeployRollupLib.deployRollup(input, rollupConfig);

    // 3. Deploy the upgrade payload. Captures the current registry distributor as OLD.
    _payload = new V5UpgradePayload(
      registry, IInstance(address(_rollupOutput.rollup)), IRewardDistributor(address(_newRewardDistributor)), feeAsset
    );

    vm.stopBroadcast();

    _writeDeploymentOutput();
  }

  function _writeDeploymentOutput() internal {
    DeployRollupLib.writeRollupAddressesToJson(vm, "v5", _rollupOutput);
    vm.serializeAddress("v5", "newRewardDistributorAddress", address(_newRewardDistributor));
    vm.serializeAddress("v5", "oldRewardDistributorAddress", _payload.OLD_REWARD_DISTRIBUTOR());
    string memory finalJson = vm.serializeAddress("v5", "payloadAddress", address(_payload));
    console.log("JSON DEPLOY RESULT:", finalJson);
  }
}
