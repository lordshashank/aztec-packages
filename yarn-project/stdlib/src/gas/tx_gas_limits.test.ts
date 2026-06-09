import { NUM_CHECKPOINT_END_MARKER_FIELDS, getNumBlockEndBlobFields } from '@aztec/blob-lib/encoding';
import {
  BLOBS_PER_CHECKPOINT,
  CONTRACT_CLASS_LOG_SIZE_IN_FIELDS,
  DA_GAS_PER_FIELD,
  FIELDS_PER_BLOB,
  MAX_PROCESSABLE_L2_GAS,
  MAX_TX_DA_GAS,
  TX_DA_GAS_OVERHEAD,
} from '@aztec/constants';

import { buildProposerTimetable } from '../timetable/build_proposer_timetable.js';
import {
  MIN_PER_BLOCK_ALLOCATION_MULTIPLIER,
  MIN_PER_BLOCK_DA_ALLOCATION_MULTIPLIER,
  builderMeetsNetworkTxGasLimits,
  computeNetworkTxGasLimits,
  getDaCheckpointBudgetForTxs,
  getNetworkTxGasLimits,
} from './tx_gas_limits.js';

describe('computeNetworkTxGasLimits', () => {
  it('caps DA gas at the per-block allocation when it is below the per-tx blob ceiling', () => {
    const gas = computeNetworkTxGasLimits({ maxBlocksPerCheckpoint: 10 });
    expect(gas.daGas).toBe(Math.ceil((getDaCheckpointBudgetForTxs(10) / 10) * MIN_PER_BLOCK_DA_ALLOCATION_MULTIPLIER));
    expect(gas.daGas).toBeLessThan(MAX_TX_DA_GAS);
  });

  it('admitted tx always fits the first-block blob-field cap across all valid geometries', () => {
    // Guards against the mismatch where the admission DA limit uses the raw checkpoint capacity but the
    // builder's blob-field cap uses the overhead-adjusted capacity, causing txs to be admitted but never
    // buildable at certain blocks-per-checkpoint geometries.
    for (let b = 1; b <= 24; b++) {
      const admittedBlobFields = Math.floor(
        computeNetworkTxGasLimits({ maxBlocksPerCheckpoint: b }).daGas / DA_GAS_PER_FIELD,
      );
      const firstBlockBlobFieldCap = Math.ceil(
        ((BLOBS_PER_CHECKPOINT * FIELDS_PER_BLOB - NUM_CHECKPOINT_END_MARKER_FIELDS - getNumBlockEndBlobFields(true)) /
          b) *
          MIN_PER_BLOCK_DA_ALLOCATION_MULTIPLIER,
      );
      expect(admittedBlobFields).toBeLessThanOrEqual(firstBlockBlobFieldCap);
    }
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
      Math.min(MAX_PROCESSABLE_L2_GAS, Math.ceil((manaCheckpointBudget / 10) * MIN_PER_BLOCK_ALLOCATION_MULTIPLIER)),
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
    const maxBlocksPerCheckpoint = buildProposerTimetable(
      { blockDurationMs: 6000 },
      l1Constants,
    ).getMaxBlocksPerCheckpoint();
    const expected = computeNetworkTxGasLimits({
      maxBlocksPerCheckpoint,
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
    const { meetsMultipliers, meetsWithCaps } = builderMeetsNetworkTxGasLimits({
      maxBlocksPerCheckpoint,
      manaCheckpointBudget,
      daMultiplier: MIN_PER_BLOCK_DA_ALLOCATION_MULTIPLIER,
      l2Multiplier: MIN_PER_BLOCK_ALLOCATION_MULTIPLIER,
    });
    expect(meetsMultipliers).toBe(true);
    expect(meetsWithCaps).toBe(true);
  });

  it('meets the floor when configured more generously', () => {
    const { meetsMultipliers, meetsWithCaps } = builderMeetsNetworkTxGasLimits({
      maxBlocksPerCheckpoint,
      manaCheckpointBudget,
      daMultiplier: 8,
      l2Multiplier: 8,
    });
    expect(meetsMultipliers).toBe(true);
    expect(meetsWithCaps).toBe(true);
  });

  it('fails the multiplier check when the DA multiplier is under the network minimum', () => {
    const { meetsMultipliers, networkLimit, allocationLimit } = builderMeetsNetworkTxGasLimits({
      maxBlocksPerCheckpoint,
      manaCheckpointBudget,
      daMultiplier: MIN_PER_BLOCK_DA_ALLOCATION_MULTIPLIER - 0.5,
      l2Multiplier: MIN_PER_BLOCK_ALLOCATION_MULTIPLIER,
    });
    expect(meetsMultipliers).toBe(false);
    expect(allocationLimit.daGas).toBeLessThan(networkLimit.daGas);
  });

  it('fails the multiplier check when the L2 multiplier is under the network minimum', () => {
    const { meetsMultipliers, networkLimit, allocationLimit } = builderMeetsNetworkTxGasLimits({
      maxBlocksPerCheckpoint,
      manaCheckpointBudget,
      daMultiplier: MIN_PER_BLOCK_DA_ALLOCATION_MULTIPLIER,
      l2Multiplier: MIN_PER_BLOCK_ALLOCATION_MULTIPLIER - 0.5,
    });
    expect(meetsMultipliers).toBe(false);
    expect(allocationLimit.l2Gas).toBeLessThan(networkLimit.l2Gas);
  });

  it('passes the multiplier check but fails the cap check when an absolute per-block cap is under the network limit', () => {
    // Multipliers are at/above the minimum (so this is legitimate operator restrictiveness, not a config
    // error), but a low maxDABlockGas still shrinks the builder's grant below the network admission limit.
    const { networkLimit } = builderMeetsNetworkTxGasLimits({
      maxBlocksPerCheckpoint,
      manaCheckpointBudget,
      daMultiplier: MIN_PER_BLOCK_DA_ALLOCATION_MULTIPLIER,
      l2Multiplier: MIN_PER_BLOCK_ALLOCATION_MULTIPLIER,
    });
    const result = builderMeetsNetworkTxGasLimits({
      maxBlocksPerCheckpoint,
      manaCheckpointBudget,
      daMultiplier: MIN_PER_BLOCK_DA_ALLOCATION_MULTIPLIER,
      l2Multiplier: MIN_PER_BLOCK_ALLOCATION_MULTIPLIER,
      daBlockGasCap: networkLimit.daGas - 1,
    });
    expect(result.meetsMultipliers).toBe(true);
    expect(result.meetsWithCaps).toBe(false);
    expect(result.allocationLimit.daGas).toBeGreaterThanOrEqual(networkLimit.daGas);
    expect(result.builderLimit.daGas).toBe(networkLimit.daGas - 1);
  });

  it('passes the multiplier check but fails the cap check for the e2e scenario (tiny l2BlockGasCap)', () => {
    // Mirrors e2e_sequencer_config "respects maxL2BlockGas": network-minimum multipliers with a single-tx
    // l2BlockGasCap. The cap is a supported operator knob, so the multiplier check must pass while the cap
    // check fails — the sequencer warns instead of throwing.
    const { networkLimit } = builderMeetsNetworkTxGasLimits({
      maxBlocksPerCheckpoint,
      manaCheckpointBudget,
      daMultiplier: MIN_PER_BLOCK_DA_ALLOCATION_MULTIPLIER,
      l2Multiplier: MIN_PER_BLOCK_ALLOCATION_MULTIPLIER,
    });
    const result = builderMeetsNetworkTxGasLimits({
      maxBlocksPerCheckpoint,
      manaCheckpointBudget,
      daMultiplier: MIN_PER_BLOCK_DA_ALLOCATION_MULTIPLIER,
      l2Multiplier: MIN_PER_BLOCK_ALLOCATION_MULTIPLIER,
      l2BlockGasCap: 777_750,
    });
    expect(result.meetsMultipliers).toBe(true);
    expect(result.meetsWithCaps).toBe(false);
    expect(result.builderLimit.l2Gas).toBeLessThan(networkLimit.l2Gas);
    expect(result.builderLimit.l2Gas).toBe(777_750);
  });
});

describe('v5 mainnet geometry (72s slots / 6s blocks → 10 blocks per checkpoint)', () => {
  // Largest tx we want to support: a maximal contract class registration, dominated by its contract class
  // log (content + contract-address field) plus the fixed tx overhead. Deploy-side nullifiers add a handful
  // more fields, so this is a lower bound on the true largest deploy.
  const largestDeployDaGas = (CONTRACT_CLASS_LOG_SIZE_IN_FIELDS + 1) * DA_GAS_PER_FIELD + TX_DA_GAS_OVERHEAD;
  const maxBlocksPerCheckpoint = 10;

  it('the timetable derives 10 blocks per checkpoint', () => {
    const blocks = buildProposerTimetable(
      { blockDurationMs: 6000 },
      { l1GenesisTime: 0n, slotDuration: 72, ethereumSlotDuration: 12 },
    ).getMaxBlocksPerCheckpoint();
    expect(blocks).toBe(maxBlocksPerCheckpoint);
  });

  it('fits the largest contract class deploy with the DA multiplier, but not with the general multiplier', () => {
    // Green: the 1.5 DA multiplier leaves room for the largest deploy.
    expect(computeNetworkTxGasLimits({ maxBlocksPerCheckpoint }).daGas).toBeGreaterThanOrEqual(largestDeployDaGas);

    // Red: the general 1.2 multiplier does not.
    const generalMultiplierDaGas = computeNetworkTxGasLimits({
      maxBlocksPerCheckpoint,
      daMultiplier: MIN_PER_BLOCK_ALLOCATION_MULTIPLIER,
    }).daGas;
    expect(generalMultiplierDaGas).toBeLessThan(largestDeployDaGas);
  });
});
