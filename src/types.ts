/**
 * Represents a single detection emitted by an upstream model or detector.
 */
export interface DetectionResult {
  /**
   * The classification category (e.g., 'face', 'document', or custom detector tag).
   */
  kind: "face" | "document" | string;

  /**
   * Confidence score between 0.0 and 1.0.
   */
  score: number;
}

/**
 * A discrete sample frame passing through the gate pipeline.
 */
export interface FrameSample {
  /**
   * Monotonic or epoch timestamp in milliseconds.
   */
  timestamp: number;

  /**
   * List of detections recognized in this frame.
   */
  detections: DetectionResult[];
}

/**
 * Valid states of the privacy gate state machine:
 * - RECORDING: Pipeline is active; no privacy threat confirmed.
 * - BLOCKED: Privacy violation confirmed; output/recording stream is suppressed.
 * - COOLDOWN: Privacy threat ceased; recovering over M clean frames before restoring.
 */
export type GateState = "RECORDING" | "BLOCKED" | "COOLDOWN";

/**
 * Gate execution modes:
 * - enforce: State transitions actively block stream (`isBlocked` returns true when BLOCKED or COOLDOWN).
 * - shadow: Silent observation mode; tracks violations and would-block events without blocking the pipeline.
 */
export type GateMode = "enforce" | "shadow";

/**
 * Rule configuration for a specific detection kind.
 */
export interface KindRule {
  /**
   * Score threshold at or above which the detection is considered a breach (0.0 - 1.0).
   */
  threshold: number;
}

/**
 * Privacy Gate constructor options.
 */
export interface PrivacyGateOptions {
  /**
   * Operating mode. Defaults to 'enforce'.
   */
  mode?: GateMode;

  /**
   * Consecutive positive detection frames required to trigger a BLOCKED state.
   * Default: 3.
   */
  consecutiveBlockFrames?: number;

  /**
   * Consecutive clean frames required to transition from BLOCKED/COOLDOWN back to RECORDING.
   * Default: 5.
   */
  recoveryCleanFrames?: number;

  /**
   * Per-kind thresholds. Example: `{ face: 0.70, document: 0.80 }`.
   */
  rules?: Record<string, number | KindRule>;

  /**
   * Default threshold applied to any detection kind not explicitly declared in `rules`.
   * Default: 0.50.
   */
  defaultThreshold?: number;

  /**
   * Policy when a detector error or corrupted frame occurs.
   * If true: treats error as a breach to protect privacy (fail-closed).
   * If false: ignores frame error and maintains current gate state (fail-open).
   * Default: false.
   */
  failClosed?: boolean;

  /**
   * Callback fired upon entering a confirmed block condition (or simulated block in shadow mode).
   */
  onBlock?: (event: BlockEvent) => void;

  /**
   * Callback fired upon returning to RECORDING state.
   */
  onClear?: (event: ClearEvent) => void;

  /**
   * Callback fired on detector/evaluation errors.
   */
  onError?: (error: unknown, frame?: unknown) => void;
}

/**
 * Payload delivered to `onBlock`.
 */
export interface BlockEvent {
  timestamp: number;
  breachingDetections: DetectionResult[];
  consecutiveBreaches: number;
  mode: GateMode;
  isShadow: boolean;
}

/**
 * Payload delivered to `onClear`.
 */
export interface ClearEvent {
  timestamp: number;
  cleanFramesElapsed: number;
  mode: GateMode;
}

/**
 * Aggregate metrics accumulated over the lifecycle of the gate instance.
 */
export interface PrivacyGateStats {
  /**
   * Total number of frame checks executed.
   */
  checks: number;

  /**
   * Number of times the gate entered the BLOCKED state (in enforce mode).
   */
  blocks: number;

  /**
   * Number of times the gate would have entered BLOCKED (shadow mode only).
   */
  wouldBlock: number;

  /**
   * Number of detector or processing errors encountered.
   */
  errors: number;

  /**
   * Current count of consecutive clean frames in the active cycle.
   */
  consecutiveCleanSamples: number;

  /**
   * Current count of consecutive breaching frames in the active cycle.
   */
  consecutiveBreachSamples: number;
}

/**
 * Result returned for each frame processed by the gate.
 */
export interface EvaluationResult {
  /**
   * Whether the stream should be suppressed / blocked.
   * In shadow mode, this is always false.
   */
  isBlocked: boolean;

  /**
   * The current internal state machine state.
   */
  state: GateState;

  /**
   * Detections in this frame that met or exceeded the threshold.
   */
  breachingDetections: DetectionResult[];

  /**
   * Whether this frame contained a privacy breach.
   */
  hasBreach: boolean;

  /**
   * Consecutive breach count up to and including this frame.
   */
  consecutiveBreaches: number;

  /**
   * Consecutive clean count up to and including this frame.
   */
  consecutiveClean: number;

  /**
   * True if this frame triggered a new transition into BLOCKED (or would-block in shadow).
   */
  triggeredBlock: boolean;

  /**
   * True if this frame triggered a transition back to RECORDING.
   */
  triggeredClear: boolean;
}
