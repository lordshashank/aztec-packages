import {
  CONTRACT_CLASS_LOG_SIZE_IN_FIELDS,
  DA_GAS_PER_FIELD,
  MAX_PROCESSABLE_DA_GAS_PER_CHECKPOINT,
  MAX_PROCESSABLE_L2_GAS,
  MAX_TX_DA_GAS,
  TX_DA_GAS_OVERHEAD,
} from '@aztec/constants';

import { getDefaultMaxBlocksPerCheckpoint } from '../timetable/build_proposer_timetable.js';
import {
  DEFAULT_PER_BLOCK_ALLOCATION_MULTIPLIER,
  DEFAULT_PER_BLOCK_DA_ALLOCATION_MULTIPLIER,
  builderMeetsNetworkTxGasLimits,
  computeNetworkTxGasLimits,
  getDefaultNetworkTxGasLimits,
  getNetworkTxGasLimits,
} from './tx_gas_limits.js';

describe('computeNetworkTxGasLimits', () => {
  it('caps DA gas at the per-block allocation when it is below the per-tx blob ceiling', () => {
    const gas = computeNetworkTxGasLimits({ maxBlocksPerCheckpoint: 10 });
    expect(gas.daGas).toBe(
      Math.ceil((MAX_PROCESSABLE_DA_GAS_PER_CHECKPOINT / 10) * DEFAULT_PER_BLOCK_DA_ALLOCATION_MULTIPLIER),
    );
    expect(gas.daGas).toBeLessThan(MAX_TX_DA_GAS);
  });

  it('caps DA gas at the per-tx blob ceiling in single-block mode', () => {
    // With a single block the even share is the full checkpoint budget, which exceeds what one tx can post.
    const gas = computeNetworkTxGasLimits({ maxBlocksPerCheckpoint: 1 });
    expect(gas.daGas).toBe(MAX_TX_DA_GAS);
  });

  it('falls back to the per-tx L2 max when the mana budget is unknown', () => {
    const gas = computeNetworkTxGasLimits({ maxBlocksPerCheckpoint: 10 });
    expect(gas.l2Gas).toBe(MAX_PROCESSABLE_L2_GAS);
  });

  it('caps L2 gas at the per-block mana allocation when a budget is given', () => {
    const manaCheckpointBudget = 10_000_000;
    const gas = computeNetworkTxGasLimits({ maxBlocksPerCheckpoint: 10, manaCheckpointBudget });
    expect(gas.l2Gas).toBe(
      Math.min(
        MAX_PROCESSABLE_L2_GAS,
        Math.ceil((manaCheckpointBudget / 10) * DEFAULT_PER_BLOCK_ALLOCATION_MULTIPLIER),
      ),
    );
  });
});

describe('getNetworkTxGasLimits', () => {
  const l1Constants = {
    l1GenesisTime: 0n,
    slotDuration: 72,
    ethereumSlotDuration: 12,
    rollupManaLimit: 10_000_000,
  };

  it('derives the limit from config + L1 constants using the network-minimum multipliers', () => {
    const gas = getNetworkTxGasLimits({ blockDurationMs: 6000 }, l1Constants);
    const expected = computeNetworkTxGasLimits({
      maxBlocksPerCheckpoint: getDefaultMaxBlocksPerCheckpoint(),
      manaCheckpointBudget: l1Constants.rollupManaLimit,
    });
    expect(gas.daGas).toBe(expected.daGas);
    expect(gas.l2Gas).toBe(expected.l2Gas);
  });
});

describe('builderMeetsNetworkTxGasLimits', () => {
  // 10 blocks keeps the DA share below MAX_TX_DA_GAS so the multiplier difference actually binds.
  const maxBlocksPerCheckpoint = 10;
  const manaCheckpointBudget = 10_000_000;

  it('meets the floor when configured at the network-minimum multipliers', () => {
    const { meets } = builderMeetsNetworkTxGasLimits({
      maxBlocksPerCheckpoint,
      manaCheckpointBudget,
      daMultiplier: DEFAULT_PER_BLOCK_DA_ALLOCATION_MULTIPLIER,
      l2Multiplier: DEFAULT_PER_BLOCK_ALLOCATION_MULTIPLIER,
    });
    expect(meets).toBe(true);
  });

  it('meets the floor when configured more generously', () => {
    const { meets } = builderMeetsNetworkTxGasLimits({
      maxBlocksPerCheckpoint,
      manaCheckpointBudget,
      daMultiplier: 8,
      l2Multiplier: 8,
    });
    expect(meets).toBe(true);
  });

  it('falls below the floor when the DA multiplier is under the network minimum', () => {
    const { meets, networkLimit, builderLimit } = builderMeetsNetworkTxGasLimits({
      maxBlocksPerCheckpoint,
      manaCheckpointBudget,
      daMultiplier: DEFAULT_PER_BLOCK_DA_ALLOCATION_MULTIPLIER - 0.5,
      l2Multiplier: DEFAULT_PER_BLOCK_ALLOCATION_MULTIPLIER,
    });
    expect(meets).toBe(false);
    expect(builderLimit.daGas).toBeLessThan(networkLimit.daGas);
  });

  it('falls below the floor when the L2 multiplier is under the network minimum', () => {
    const { meets, networkLimit, builderLimit } = builderMeetsNetworkTxGasLimits({
      maxBlocksPerCheckpoint,
      manaCheckpointBudget,
      daMultiplier: DEFAULT_PER_BLOCK_DA_ALLOCATION_MULTIPLIER,
      l2Multiplier: DEFAULT_PER_BLOCK_ALLOCATION_MULTIPLIER - 0.5,
    });
    expect(meets).toBe(false);
    expect(builderLimit.l2Gas).toBeLessThan(networkLimit.l2Gas);
  });

  it('falls below the floor when an absolute per-block cap is under the network limit', () => {
    // Multipliers are at/above the minimum, but a low maxDABlockGas still shrinks the builder's grant.
    const { networkLimit } = builderMeetsNetworkTxGasLimits({
      maxBlocksPerCheckpoint,
      manaCheckpointBudget,
      daMultiplier: DEFAULT_PER_BLOCK_DA_ALLOCATION_MULTIPLIER,
      l2Multiplier: DEFAULT_PER_BLOCK_ALLOCATION_MULTIPLIER,
    });
    const result = builderMeetsNetworkTxGasLimits({
      maxBlocksPerCheckpoint,
      manaCheckpointBudget,
      daMultiplier: DEFAULT_PER_BLOCK_DA_ALLOCATION_MULTIPLIER,
      l2Multiplier: DEFAULT_PER_BLOCK_ALLOCATION_MULTIPLIER,
      daBlockGasCap: networkLimit.daGas - 1,
    });
    expect(result.meets).toBe(false);
    expect(result.builderLimit.daGas).toBe(networkLimit.daGas - 1);
  });
});

describe('mainnet defaults', () => {
  // Largest tx we want to support: a maximal contract class registration, dominated by its contract class
  // log (content + contract-address field) plus the fixed tx overhead. Deploy-side nullifiers add a handful
  // more fields, so this is a lower bound on the true largest deploy.
  const largestDeployDaGas = (CONTRACT_CLASS_LOG_SIZE_IN_FIELDS + 1) * DA_GAS_PER_FIELD + TX_DA_GAS_OVERHEAD;

  it('derives 10 blocks per checkpoint for 72s slots / 6s blocks', () => {
    expect(getDefaultMaxBlocksPerCheckpoint()).toBe(10);
  });

  it('fits the largest contract class deploy with the DA multiplier, but not with the general multiplier', () => {
    // Green: the 1.5 DA multiplier leaves room for the largest deploy.
    expect(getDefaultNetworkTxGasLimits().daGas).toBeGreaterThanOrEqual(largestDeployDaGas);

    // Red: the general 1.2 multiplier does not.
    const generalMultiplierDaGas = computeNetworkTxGasLimits({
      maxBlocksPerCheckpoint: getDefaultMaxBlocksPerCheckpoint(),
      daMultiplier: DEFAULT_PER_BLOCK_ALLOCATION_MULTIPLIER,
    }).daGas;
    expect(generalMultiplierDaGas).toBeLessThan(largestDeployDaGas);
  });
});
