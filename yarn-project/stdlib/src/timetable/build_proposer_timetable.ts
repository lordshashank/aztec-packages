import {
  DEFAULT_CHECKPOINT_PROPOSAL_INIT_TIME,
  DEFAULT_CHECKPOINT_PROPOSAL_PREPARE_TIME,
  DEFAULT_MIN_BLOCK_DURATION,
  DEFAULT_P2P_PROPAGATION_TIME,
} from './budgets.js';
import type { SlotTimingConstants } from './consensus_timetable.js';
import { ProposerTimetable } from './proposer_timetable.js';

/**
 * Subset of the sequencer/p2p config the proposer timetable derives its operational budgets from. Both
 * {@link SequencerConfig} and {@link P2PConfig} structurally satisfy this, so the same builder is used by
 * the sequencer, the p2p layer, and the node's `getNodeInfo`.
 */
export type ProposerTimetableConfig = {
  blockDurationMs?: number;
  minBlockDuration?: number;
  attestationPropagationTime?: number;
  checkpointProposalPrepareTime?: number;
  checkpointProposalSyncGraceSeconds?: number;
  enforceTimeTable?: boolean;
};

/** Mainnet default Aztec slot duration in seconds. Used to derive client-side defaults when a node predates the network-info RPC. */
export const DEFAULT_MAINNET_AZTEC_SLOT_DURATION = 72;
/** Mainnet default Ethereum slot duration in seconds. */
export const DEFAULT_MAINNET_ETHEREUM_SLOT_DURATION = 12;
/** Mainnet default block duration in milliseconds. */
export const DEFAULT_MAINNET_BLOCK_DURATION_MS = 6000;

/**
 * Builds the proposer timetable from a sequencer/p2p config and the slot-timing protocol constants,
 * applying the shared stdlib budget defaults. Single source of truth shared by the sequencer, the p2p
 * layer, and the node's `getNodeInfo` so they all derive the same `maxBlocksPerCheckpoint`.
 */
export function buildProposerTimetable(
  config: ProposerTimetableConfig,
  l1Constants: SlotTimingConstants,
): ProposerTimetable {
  return new ProposerTimetable({
    l1Constants,
    blockDuration: config.blockDurationMs !== undefined ? config.blockDurationMs / 1000 : undefined,
    minBlockDuration: config.minBlockDuration ?? DEFAULT_MIN_BLOCK_DURATION,
    p2pPropagationTime: config.attestationPropagationTime ?? DEFAULT_P2P_PROPAGATION_TIME,
    checkpointProposalPrepareTime: config.checkpointProposalPrepareTime ?? DEFAULT_CHECKPOINT_PROPOSAL_PREPARE_TIME,
    checkpointProposalInitTime: DEFAULT_CHECKPOINT_PROPOSAL_INIT_TIME,
    checkpointProposalSyncGrace: config.checkpointProposalSyncGraceSeconds,
    enforce: config.enforceTimeTable ?? true,
  });
}

/**
 * Blocks-per-checkpoint a client should assume when talking to a node that predates the network-info RPC.
 * Derived from the mainnet defaults (72s slots, 6s blocks) through the same timetable used by proposers,
 * so there is no separate hardcoded count to drift.
 */
export function getDefaultMaxBlocksPerCheckpoint(): number {
  return buildProposerTimetable(
    { blockDurationMs: DEFAULT_MAINNET_BLOCK_DURATION_MS },
    {
      l1GenesisTime: 0n,
      slotDuration: DEFAULT_MAINNET_AZTEC_SLOT_DURATION,
      ethereumSlotDuration: DEFAULT_MAINNET_ETHEREUM_SLOT_DURATION,
    },
  ).getMaxBlocksPerCheckpoint();
}
