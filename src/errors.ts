/** Errors the manifest layer and the runtime raise. All carry the pipeline id. */

export class PipelineContractError extends Error {
  readonly pipeline: string;
  readonly problems: string[];

  constructor(pipeline: string, problems: string[]) {
    super(
      `Pipeline "${pipeline}" violates the decision-pipeline contract:\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
    this.name = "PipelineContractError";
    this.pipeline = pipeline;
    this.problems = problems;
  }
}

/** A node needed a port the host did not supply. Named, so the fix is obvious. */
export class MissingPortError extends Error {
  constructor(port: string, nodeId: string, kind: string) {
    super(
      `No "${port}" port supplied, but node "${nodeId}" is a ${kind} node that needs one.`,
    );
    this.name = "MissingPortError";
  }
}

/** A node body failed and its `onFailure` was `fail` (the default). */
export class NodeFailedError extends Error {
  readonly nodeId: string;
  readonly cause: unknown;

  constructor(nodeId: string, cause: unknown) {
    super(
      `Node "${nodeId}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "NodeFailedError";
    this.nodeId = nodeId;
    this.cause = cause;
  }
}

/** A gate body returned a branch it never declared. */
export class UnknownBranchError extends Error {
  constructor(nodeId: string, branch: string, branches: string[]) {
    super(
      `Gate "${nodeId}" returned branch "${branch}", which is not one of [${branches.join(", ")}].`,
    );
    this.name = "UnknownBranchError";
  }
}
