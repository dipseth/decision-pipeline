/**
 * The composite version. Never hand-set: the runtime hashes what actually
 * resolved at run start, so `<fact>_version` names a real configuration rather
 * than whatever someone remembered to bump.
 *
 * The ARM is folded in — otherwise two arms of an experiment collide under one
 * `<fact>_version` and the records are unusable.
 *
 * Invalidation is per NODE (`node_version + input_hash`), not per pipeline: a
 * threshold bump on the gate must not re-run the decide call.
 */

import { shortHash } from "./hash";

export interface VersionInputs {
  pipeline: string;
  nodeVersions: Record<string, string>;
  /** Resolved Langfuse prompt versions, generate + decide. Null when unresolved. */
  promptVersions: Record<string, string | null>;
  /** Resolved threshold VALUES, by node then name. */
  thresholds: Record<string, Record<string, number>>;
  knowledgeVersion?: string | undefined;
  /** experiment id -> arm. */
  arms: Record<string, string>;
}

export const compositeVersion = (inputs: VersionInputs): string =>
  shortHash({
    pipeline: inputs.pipeline,
    nodeVersions: inputs.nodeVersions,
    promptVersions: inputs.promptVersions,
    thresholds: inputs.thresholds,
    knowledgeVersion: inputs.knowledgeVersion ?? null,
    arms: inputs.arms,
  });

/** Per-node cache key. The node version is IN the key, so a bump invalidates by itself. */
export const nodeCacheKey = (
  pipeline: string,
  nodeId: string,
  nodeVersion: string,
  inputHash: string,
): string => `${pipeline}:${nodeId}:${nodeVersion}:${inputHash}`;
