# V5 Upgrade Runbook

Deploy the v5 rollup + v5 `RewardDistributor` and the governance payload that swaps the
canonical pointer and drains the v4 `RewardDistributor`. Same steps on every chain — only the
RPC, deployer, and `NETWORK` differ.

## What gets deployed

`script/deploy/DeployRollupForUpgradeV5.s.sol` deploys, in order:

1. A `RewardDistributor` bound to the existing `feeAsset` + `Registry`.
2. A `Rollup` (+ `Verifier`, `Inbox`, `Outbox`, `FeeAssetPortal`, `Slasher`, `RewardBooster`)
   wired immutably to the new distributor.
3. A `V5UpgradePayload` holding the four actions governance executes:
   drain v4 → new distributor (`recover(asset,to,amount)`), `Registry.addRollup(v5)`,
   `Registry.updateRewardDistributor(new)`, `GSE.addRollup(v5)`.

Rollup knobs come from `RollupConfiguration.sol` (env vars; full list in TypeScript
`getDeployRollupForUpgradeEnvVars`). The v5 values are the `mainnet`/`testnet` presets in
`spartan/environments/network-defaults.yml`.

## Deploy

```bash
export PRIVATE_KEY=0x...
export RPC_URL=https://...                 # network RPC
export REGISTRY_ADDRESS=0x...              # the v4 Registry on this chain
export NETWORK=testnet                     # `testnet` (Sepolia) or `mainnet`
export ETHERSCAN_API_KEY=...               # enables --verify (optional)

forge script script/deploy/DeployRollupForUpgradeV5.s.sol \
  --sig 'run()' --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" \
  --broadcast --verify --batch-size 8
```

- **Mainnet:** also `export FOUNDRY_PROFILE=production`.
- Output: one `JSON DEPLOY RESULT: { ... }` line with every address.

## Verify the payload before handing it off

```bash
cast call "$PAYLOAD" "OLD_REWARD_DISTRIBUTOR()(address)" --rpc-url "$RPC_URL"
cast call "$PAYLOAD" "NEW_REWARD_DISTRIBUTOR()(address)" --rpc-url "$RPC_URL"
cast call "$PAYLOAD" "NEW_ROLLUP()(address)"             --rpc-url "$RPC_URL"
```

`OLD_REWARD_DISTRIBUTOR` MUST equal `Registry.getRewardDistributor()` at deploy time. If the
registry pointer moved between deploy and proposal submission, redeploy the payload.

The forge script does **not** execute the payload — submit it to governance via the standard
flow (`GovernanceProposer` signal → `submitRoundWinner` → `Governance.execute`).

## Simulate execution

`test/periphery/V5UpgradePayloadFork.t.sol` forks Sepolia and mainnet and runs all four actions
through governance, asserting: canonical rollup = v5, registry distributor = new, GSE registers
v5, v4 distributor drained to zero, new distributor holds the full pre-drain balance.

```bash
SEPOLIA_RPC_URL=<url> MAINNET_RPC_URL=<url> \
  forge test --match-path 'test/periphery/V5UpgradePayloadFork.t.sol' -vv
```

`test/periphery/V5UpgradePayload.t.sol` runs the same assertions against a stubbed distributor.
