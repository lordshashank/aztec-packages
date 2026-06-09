import { NUM_CHECKPOINT_END_MARKER_FIELDS, NUM_FIRST_BLOCK_END_BLOB_FIELDS } from '@aztec/blob-lib/encoding';
import {
  BLOBS_PER_CHECKPOINT,
  DA_GAS_PER_FIELD,
  FIELDS_PER_BLOB,
  MAX_PROCESSABLE_L2_GAS,
  MAX_TX_DA_GAS,
} from '@aztec/constants';

import {
  type ProposerTimetableConfig,
  buildProposerTimetable,
  getDefaultMaxBlocksPerCheckpoint,
} from '../timetable/build_proposer_timetable.js';
import type { SlotTimingConstants } from '../timetable/consensus_timetable.js';
import { Gas } from './gas.js';

/**
 * Network-minimum per-block budget multiplier for L2 gas and tx-count allocation. A block packer must
 * grant at least this share of the even per-block split to a single tx; operators may configure a higher
 * multiplier (more generous), but not a lower one — enforced at sequencer startup. Doubles as the default
 * for `SequencerConfig.perBlockAllocationMultiplier`.
 */
export const DEFAULT_PER_BLOCK_ALLOCATION_MULTIPLIER = 1.2;

/**
 * Network-minimum per-block budget multiplier for DA gas, applied in place of the general
 * {@link DEFAULT_PER_BLOCK_ALLOCATION_MULTIPLIER}. Higher than the general multiplier so the largest tx we
 * want to support — a maximal contract class registration (~97k DA gas) — fits a single block under v5
 * mainnet geometry (72s slots, 6s blocks → 10 blocks per checkpoint). Doubles as the default for
 * `SequencerConfig.perBlockDAAllocationMultiplier`.
 */
export const DEFAULT_PER_BLOCK_DA_ALLOCATION_MULTIPLIER = 1.5;

/**
 * The DA gas budget actually available to tx data within a checkpoint. This is the raw blob capacity
 * (`BLOBS_PER_CHECKPOINT * FIELDS_PER_BLOB * DA_GAS_PER_FIELD`) minus the fields the blob encoding
 * reserves for overhead that no tx pays DA gas for: one checkpoint-end marker field and the first-block
 * block-end fields (7 fields; subsequent blocks add 6 each).
 *
 * This must use the same basis as `CheckpointBuilder.capLimitsByCheckpointBudgets`'s blob-field cap so
 * that a tx admitted under the network DA limit always fits the first block's blob-field cap. It is
 * slightly optimistic for later blocks (each adds 6 more block-end fields), but the per-block fair-share
 * division accounts for that.
 */
export const DA_CHECKPOINT_BUDGET_FOR_TXS =
  (BLOBS_PER_CHECKPOINT * FIELDS_PER_BLOB - NUM_CHECKPOINT_END_MARKER_FIELDS - NUM_FIRST_BLOCK_END_BLOB_FIELDS) *
  DA_GAS_PER_FIELD;

/**
 * Computes the maximum gas a single tx may declare on a network: the smaller of the per-tx protocol
 * maximum and the per-block allocation a proposer grants to the first block of a checkpoint. The per-block
 * allocation mirrors `CheckpointBuilder.capLimitsByCheckpointBudgets`
 * (`ceil(checkpointBudget / maxBlocksPerCheckpoint * multiplier)`), so a tx declaring this much is
 * admissible into a block under that geometry.
 *
 * This is a *network* limit: a function of network-wide constants only (timetable-derived
 * blocks-per-checkpoint, checkpoint budgets, the network-minimum multipliers). It must NOT depend on a
 * node's local restrictiveness — its multipliers configured above the network minimum, or its
 * `maxDABlockGas` / `validateMaxDABlockGas` caps — because those make a node stricter at block-building
 * time but cannot define what the network considers a valid tx for relay. The same value is advertised by
 * `getNodeInfo` and enforced by the RPC/gossip/pool gas validators.
 *
 * The DA budget defaults to {@link DA_CHECKPOINT_BUDGET_FOR_TXS} — the raw blob capacity net of encoding
 * overhead — rather than the raw `MAX_PROCESSABLE_DA_GAS_PER_CHECKPOINT`, so the admission limit is
 * consistent with the builder's blob-field cap.
 *
 * @param manaCheckpointBudget - L2 (mana) budget per checkpoint (`rollupManaLimit`). When omitted (e.g. a
 * client that does not know the chain's mana limit), the L2 limit falls back to the per-tx maximum.
 */
export function computeNetworkTxGasLimits(opts: {
  maxBlocksPerCheckpoint: number;
  manaCheckpointBudget?: number;
  daCheckpointBudget?: number;
  daMultiplier?: number;
  l2Multiplier?: number;
}): Gas {
  const blocks = Math.max(1, opts.maxBlocksPerCheckpoint);
  const daBudget = opts.daCheckpointBudget ?? DA_CHECKPOINT_BUDGET_FOR_TXS;
  const daMultiplier = opts.daMultiplier ?? DEFAULT_PER_BLOCK_DA_ALLOCATION_MULTIPLIER;
  const l2Multiplier = opts.l2Multiplier ?? DEFAULT_PER_BLOCK_ALLOCATION_MULTIPLIER;

  const daGas = Math.min(MAX_TX_DA_GAS, Math.ceil((daBudget / blocks) * daMultiplier));
  const l2Gas =
    opts.manaCheckpointBudget !== undefined
      ? Math.min(MAX_PROCESSABLE_L2_GAS, Math.ceil((opts.manaCheckpointBudget / blocks) * l2Multiplier))
      : MAX_PROCESSABLE_L2_GAS;

  return new Gas(daGas, l2Gas);
}

/**
 * Network tx gas limits derived from a sequencer/p2p config and the L1 slot-timing + mana constants. The
 * single source of truth shared by `getNodeInfo` (advertising) and the RPC/gossip/pool gas validators
 * (enforcing), so a node never rejects a tx it advertised as admissible. Always uses the network-minimum
 * multipliers, never the node's (possibly higher) configured multipliers.
 */
export function getNetworkTxGasLimits(
  config: ProposerTimetableConfig,
  l1Constants: SlotTimingConstants & { rollupManaLimit: number },
): Gas {
  const maxBlocksPerCheckpoint = buildProposerTimetable(config, l1Constants).getMaxBlocksPerCheckpoint();
  return computeNetworkTxGasLimits({ maxBlocksPerCheckpoint, manaCheckpointBudget: l1Constants.rollupManaLimit });
}

/**
 * Whether a block builder configured with the given per-block multipliers and absolute per-block gas caps
 * grants a single tx at least the network admission limit (which uses the network-minimum multipliers).
 * Returns `meets: false` when the builder would reject txs the network admits over RPC/gossip — the
 * sequencer fails startup in that case. Returns both limits so callers can report the shortfall.
 *
 * @param daBlockGasCap - Absolute per-block DA gas cap the builder enforces (`maxDABlockGas`). The builder
 * mins the multiplier allocation with this (see `CheckpointBuilder.capLimitsByCheckpointBudgets`), so a cap
 * below the network limit shrinks what a single tx can be built with, even at a generous multiplier.
 * @param l2BlockGasCap - Absolute per-block L2 gas cap the builder enforces (`maxL2BlockGas`).
 */
export function builderMeetsNetworkTxGasLimits(opts: {
  maxBlocksPerCheckpoint: number;
  manaCheckpointBudget?: number;
  daMultiplier: number;
  l2Multiplier: number;
  daBlockGasCap?: number;
  l2BlockGasCap?: number;
}): { meets: boolean; networkLimit: Gas; builderLimit: Gas } {
  const { maxBlocksPerCheckpoint, manaCheckpointBudget } = opts;
  const networkLimit = computeNetworkTxGasLimits({ maxBlocksPerCheckpoint, manaCheckpointBudget });
  const allocation = computeNetworkTxGasLimits({
    maxBlocksPerCheckpoint,
    manaCheckpointBudget,
    daMultiplier: opts.daMultiplier,
    l2Multiplier: opts.l2Multiplier,
  });
  // The builder caps each block by the node's absolute per-block gas limits in addition to the multiplier
  // allocation, so a tx is only buildable if it fits under both.
  const builderLimit = new Gas(
    Math.min(allocation.daGas, opts.daBlockGasCap ?? Infinity),
    Math.min(allocation.l2Gas, opts.l2BlockGasCap ?? Infinity),
  );
  const meets = builderLimit.daGas >= networkLimit.daGas && builderLimit.l2Gas >= networkLimit.l2Gas;
  return { meets, networkLimit, builderLimit };
}

/**
 * Network tx gas limits assuming the mainnet defaults (72s slots, 6s blocks → 10 blocks per checkpoint).
 * Used by clients talking to a node that predates the `txsLimits` RPC field, and as the default for
 * {@link GasSettings.fallback}. The mana budget is unknown client-side, so L2 falls back to the per-tx max.
 */
export function getDefaultNetworkTxGasLimits(): Gas {
  return computeNetworkTxGasLimits({ maxBlocksPerCheckpoint: getDefaultMaxBlocksPerCheckpoint() });
}
