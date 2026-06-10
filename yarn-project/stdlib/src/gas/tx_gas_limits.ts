import {
  NUM_BLOCK_END_BLOB_FIELDS,
  NUM_CHECKPOINT_END_MARKER_FIELDS,
  NUM_FIRST_BLOCK_END_BLOB_FIELDS,
} from '@aztec/blob-lib/encoding';
import {
  BLOBS_PER_CHECKPOINT,
  DA_GAS_PER_FIELD,
  FIELDS_PER_BLOB,
  MAX_PROCESSABLE_DA_GAS_PER_CHECKPOINT,
  MAX_PROCESSABLE_L2_GAS,
  MAX_TX_DA_GAS,
} from '@aztec/constants';

import { type ProposerTimetableConfig, buildProposerTimetable } from '../timetable/build_proposer_timetable.js';
import type { SlotTimingConstants } from '../timetable/consensus_timetable.js';
import { Gas } from './gas.js';

/**
 * Network-minimum per-block budget multiplier for L2 gas and tx-count allocation. A block packer must
 * grant at least this share of the even per-block split to a single tx; operators may configure a higher
 * multiplier (more generous), but not a lower one — enforced at sequencer startup. Also used as the default
 * for `SequencerConfig.perBlockAllocationMultiplier`.
 */
export const MIN_PER_BLOCK_ALLOCATION_MULTIPLIER = 1.2;

/**
 * Network-minimum per-block budget multiplier for DA gas, applied in place of the general
 * {@link MIN_PER_BLOCK_ALLOCATION_MULTIPLIER}. Higher than the general multiplier so the largest tx we
 * want to support — a maximal contract class registration (~97k DA gas) — fits a single block under v5
 * mainnet geometry (72s slots, 6s blocks → 10 blocks per checkpoint). A builder may configure a higher
 * multiplier but never a lower one. Also used as the default for
 * `SequencerConfig.perBlockDAAllocationMultiplier`.
 */
export const MIN_PER_BLOCK_DA_ALLOCATION_MULTIPLIER = 1.5;

/**
 * The DA gas budget available to tx data within a checkpoint of `maxBlocksPerCheckpoint` blocks. This is the
 * raw blob capacity (`BLOBS_PER_CHECKPOINT * FIELDS_PER_BLOB * DA_GAS_PER_FIELD`) minus the fields the blob
 * encoding reserves for overhead that no tx pays DA gas for:
 *
 * - one checkpoint-end marker field (`NUM_CHECKPOINT_END_MARKER_FIELDS`),
 * - the first block's block-end fields (`NUM_FIRST_BLOCK_END_BLOB_FIELDS`, 7), and
 * - `NUM_BLOCK_END_BLOB_FIELDS` (6) for each of the `blocks - 1` subsequent blocks.
 *
 * Subtracting the overhead for every block (not just the first) keeps the network DA admission limit at or
 * below the builder's first-block blob-field cap at every geometry. The builder is the MOST generous for the
 * first block — it only reserves that block's own block-end overhead — so being conservative here (assuming
 * the checkpoint is full of blocks, each spending its share) is what guarantees admitted ⇒ buildable: a tx
 * admitted under this budget always fits the first block's blob-field cap, regardless of how many blocks the
 * builder ends up packing.
 *
 * @param maxBlocksPerCheckpoint - Number of blocks the checkpoint may contain; clamped to at least 1.
 */
export function getDaCheckpointBudgetForTxs(maxBlocksPerCheckpoint: number): number {
  const blocks = Math.max(1, maxBlocksPerCheckpoint);
  // Clamp at zero: for absurd geometries (blocks greater than ~4094) the per-block overhead alone exceeds the
  // raw blob capacity, which would otherwise yield a negative advertised DA budget.
  const fields = Math.max(
    0,
    BLOBS_PER_CHECKPOINT * FIELDS_PER_BLOB -
      NUM_CHECKPOINT_END_MARKER_FIELDS -
      NUM_FIRST_BLOCK_END_BLOB_FIELDS -
      (blocks - 1) * NUM_BLOCK_END_BLOB_FIELDS,
  );
  return fields * DA_GAS_PER_FIELD;
}

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
 * The DA budget is {@link getDaCheckpointBudgetForTxs} evaluated at the clamped blocks-per-checkpoint — the
 * raw blob capacity net of encoding overhead for every block — rather than the raw
 * `MAX_PROCESSABLE_DA_GAS_PER_CHECKPOINT`, so the admission limit is consistent with the builder's blob-field
 * cap.
 *
 * @param manaCheckpointBudget - L2 (mana) budget per checkpoint (`rollupManaLimit`). When omitted (e.g. a
 * client that does not know the chain's mana limit), the L2 limit falls back to the per-tx maximum.
 * @param daCheckpointBudget - Overrides the DA checkpoint budget used to derive the per-block DA allocation.
 * Defaults to the overhead-netted {@link getDaCheckpointBudgetForTxs}, which the network admission limit uses.
 * Callers modeling the real builder grant pass the raw `MAX_PROCESSABLE_DA_GAS_PER_CHECKPOINT` instead, since
 * the builder budgets DA from the raw checkpoint capacity.
 */
export function computeNetworkTxGasLimits(opts: {
  maxBlocksPerCheckpoint: number;
  manaCheckpointBudget?: number;
  daMultiplier?: number;
  l2Multiplier?: number;
  daCheckpointBudget?: number;
}): Gas {
  const blocks = Math.max(1, opts.maxBlocksPerCheckpoint);
  const daBudget = opts.daCheckpointBudget ?? getDaCheckpointBudgetForTxs(blocks);
  const daMultiplier = opts.daMultiplier ?? MIN_PER_BLOCK_DA_ALLOCATION_MULTIPLIER;
  const l2Multiplier = opts.l2Multiplier ?? MIN_PER_BLOCK_ALLOCATION_MULTIPLIER;

  // Clamp by the whole-checkpoint budget too: at small block counts the per-block share scaled by the
  // multiplier can exceed the checkpoint budget itself (e.g. at blocks=1 a >1 multiplier overshoots), which
  // would admit a tx no builder can ever pack — the builder caps each block by the remaining budget. Clamping
  // by the budget makes "admitted ⇒ buildable" unconditional. (For DA the per-tx maximum always binds first,
  // so the budget clamp is currently moot, but it keeps the invariant explicit.)
  const daGas = Math.min(MAX_TX_DA_GAS, daBudget, Math.ceil((daBudget / blocks) * daMultiplier));
  const l2Gas =
    opts.manaCheckpointBudget !== undefined
      ? Math.min(
          MAX_PROCESSABLE_L2_GAS,
          opts.manaCheckpointBudget,
          Math.ceil((opts.manaCheckpointBudget / blocks) * l2Multiplier),
        )
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
 * Compares a block builder's effective per-tx grant against the network admission limit (which uses the
 * network-minimum multipliers), distinguishing two independent causes of a shortfall:
 *
 * - `meetsMultipliers`: whether the multiplier-derived allocation (no absolute caps) reaches the network
 *   limit. A `false` here is a *configuration error* — the node's `perBlockAllocationMultiplier` /
 *   `perBlockDAAllocationMultiplier` are below the network minimums, so it would admit txs over RPC/gossip
 *   that its builder can never pack regardless of block size. The sequencer fails startup in this case.
 * - `meetsWithCaps`: whether the grant still reaches the network limit after mining in the absolute
 *   per-block gas caps (`maxDABlockGas` / `maxL2BlockGas`). A `false` here when `meetsMultipliers` is true
 *   is *legitimate operator restrictiveness*: the node simply builds smaller blocks, leaving such txs in the
 *   pool for other proposers. It is worth a warning — txs declaring more than the builder grant will be
 *   skipped by this proposer's own blocks — but not a startup failure.
 *
 * Returns the network limit, the multiplier-only `allocationLimit`, and the cap-adjusted `builderLimit` so
 * callers can report the precise shortfall.
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
}): { meetsMultipliers: boolean; meetsWithCaps: boolean; networkLimit: Gas; allocationLimit: Gas; builderLimit: Gas } {
  const { maxBlocksPerCheckpoint, manaCheckpointBudget } = opts;
  const networkLimit = computeNetworkTxGasLimits({ maxBlocksPerCheckpoint, manaCheckpointBudget });
  // Model the builder side with the raw checkpoint DA budget (`MAX_PROCESSABLE_DA_GAS_PER_CHECKPOINT`), since
  // the builder budgets DA from the raw blob capacity rather than the overhead-netted budget the network
  // admission limit uses. Netting the builder side too would make this guard slightly over-strict, refusing
  // startup for DA multipliers just under the minimum where the raw budget still grants enough.
  const allocationLimit = computeNetworkTxGasLimits({
    maxBlocksPerCheckpoint,
    manaCheckpointBudget,
    daMultiplier: opts.daMultiplier,
    l2Multiplier: opts.l2Multiplier,
    daCheckpointBudget: MAX_PROCESSABLE_DA_GAS_PER_CHECKPOINT,
  });
  // The builder caps each block by the node's absolute per-block gas limits in addition to the multiplier
  // allocation, so a tx is only buildable if it fits under both.
  const builderLimit = new Gas(
    Math.min(allocationLimit.daGas, opts.daBlockGasCap ?? Infinity),
    Math.min(allocationLimit.l2Gas, opts.l2BlockGasCap ?? Infinity),
  );
  const meetsMultipliers = allocationLimit.daGas >= networkLimit.daGas && allocationLimit.l2Gas >= networkLimit.l2Gas;
  const meetsWithCaps = builderLimit.daGas >= networkLimit.daGas && builderLimit.l2Gas >= networkLimit.l2Gas;
  return { meetsMultipliers, meetsWithCaps, networkLimit, allocationLimit, builderLimit };
}
