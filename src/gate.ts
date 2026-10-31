import {
  BlockEvent,
  ClearEvent,
  DetectionResult,
  EvaluationResult,
  FrameSample,
  GateMode,
  GateState,
  PrivacyGateOptions,
  PrivacyGateStats,
} from "./types.js";

/**
 * Pure TypeScript deterministic privacy gate state machine.
 *
 * Implements hysteresis over a temporal stream of sampled frames to prevent
 * noisy transitions (flicker) while safeguarding sensitive visual data.
 */
export class PrivacyGate {
  private mode: GateMode;
  private consecutiveBlockFrames: number;
  private recoveryCleanFrames: number;
  private rules: Map<string, number>;
  private defaultThreshold: number;
  private failClosed: boolean;

  private onBlockCallback?: (event: BlockEvent) => void;
  private onClearCallback?: (event: ClearEvent) => void;
  private onErrorCallback?: (error: unknown, frame?: unknown) => void;

  private currentState: GateState = "RECORDING";
  private consecutiveBreaches = 0;
  private consecutiveClean = 0;

  private totalChecks = 0;
  private totalBlocks = 0;
  private totalWouldBlock = 0;
  private totalErrors = 0;

  constructor(options: PrivacyGateOptions = {}) {
    this.mode = options.mode ?? "enforce";
    this.consecutiveBlockFrames = Math.max(1, options.consecutiveBlockFrames ?? 3);
    this.recoveryCleanFrames = Math.max(1, options.recoveryCleanFrames ?? 5);
    this.defaultThreshold = options.defaultThreshold ?? 0.5;
    this.failClosed = options.failClosed ?? false;
    this.onBlockCallback = options.onBlock;
    this.onClearCallback = options.onClear;
    this.onErrorCallback = options.onError;

    this.rules = new Map();
    if (options.rules) {
      for (const [key, val] of Object.entries(options.rules)) {
        if (typeof val === "number") {
          this.rules.set(key, val);
        } else if (typeof val === "object" && val !== null && typeof val.threshold === "number") {
          this.rules.set(key, val.threshold);
        }
      }
    }
  }

  /**
   * Returns current state machine state.
   */
  public getState(): GateState {
    return this.currentState;
  }

  /**
   * Returns active execution mode.
   */
  public getMode(): GateMode {
    return this.mode;
  }

  /**
   * Switch gate execution mode dynamically ('enforce' <-> 'shadow').
   */
  public setMode(mode: GateMode): void {
    this.mode = mode;
  }

  /**
   * Returns whether the stream is effectively blocked in enforce mode.
   * In shadow mode, this always returns false.
   */
  public isBlocked(): boolean {
    if (this.mode === "shadow") {
      return false;
    }
    return this.currentState === "BLOCKED" || this.currentState === "COOLDOWN";
  }

  /**
   * Returns lifetime metrics summary.
   */
  public getStats(): PrivacyGateStats {
    return {
      checks: this.totalChecks,
      blocks: this.totalBlocks,
      wouldBlock: this.totalWouldBlock,
      errors: this.totalErrors,
      consecutiveCleanSamples: this.consecutiveClean,
      consecutiveBreachSamples: this.consecutiveBreaches,
    };
  }

  /**
   * Resets internal state machine and counters back to initial RECORDING state.
   */
  public reset(): void {
    this.currentState = "RECORDING";
    this.consecutiveBreaches = 0;
    this.consecutiveClean = 0;
  }

  /**
   * Resets all lifetime statistics.
   */
  public resetStats(): void {
    this.totalChecks = 0;
    this.totalBlocks = 0;
    this.totalWouldBlock = 0;
    this.totalErrors = 0;
  }

  /**
   * Resolves the threshold for a given detection kind.
   */
  public getThresholdForKind(kind: string): number {
    return this.rules.get(kind) ?? this.defaultThreshold;
  }

  /**
   * Process a frame sample from the detector stream.
   *
   * @param sample The detector result frame.
   * @returns EvaluationResult detailing state and actions taken.
   */
  public processFrame(sample: FrameSample): EvaluationResult {
    this.totalChecks++;

    try {
      if (!sample || !Array.isArray(sample.detections)) {
        throw new TypeError("Invalid FrameSample: detections must be an array");
      }

      return this.evaluateDetections(sample.timestamp ?? Date.now(), sample.detections);
    } catch (err) {
      return this.handleProcessingError(err, sample);
    }
  }

  /**
   * Convenience method to wrap an asynchronous or synchronous detector invocation.
   * Handles detector exceptions gracefully per the failClosed configuration.
   *
   * @param detectorFn Function producing a FrameSample or DetectionResult array.
   * @param timestamp Optional timestamp override.
   */
  public async processDetectorCall(
    detectorFn: () => Promise<FrameSample | DetectionResult[]> | FrameSample | DetectionResult[],
    timestamp: number = Date.now(),
  ): Promise<EvaluationResult> {
    this.totalChecks++;

    try {
      const res = await detectorFn();
      let frame: FrameSample;

      if (Array.isArray(res)) {
        frame = { timestamp, detections: res };
      } else if (res && Array.isArray(res.detections)) {
        frame = res;
      } else {
        throw new TypeError("Detector returned an invalid result format");
      }

      return this.evaluateDetections(frame.timestamp ?? timestamp, frame.detections);
    } catch (err) {
      return this.handleProcessingError(err, undefined);
    }
  }

  private handleProcessingError(err: unknown, frameSample?: unknown): EvaluationResult {
    this.totalErrors++;

    if (this.onErrorCallback) {
      try {
        this.onErrorCallback(err, frameSample);
      } catch {
        // Suppress errors inside external callbacks to avoid crashing host pipeline
      }
    }

    if (this.failClosed) {
      // Treat unexpected failure as an immediate breach condition to prevent data leakage
      const syntheticBreach: DetectionResult[] = [{ kind: "detector_error", score: 1.0 }];
      return this.evaluateDetections(Date.now(), syntheticBreach);
    }

    // Fail-open: keep state as is
    return {
      isBlocked: this.isBlocked(),
      state: this.currentState,
      breachingDetections: [],
      hasBreach: false,
      consecutiveBreaches: this.consecutiveBreaches,
      consecutiveClean: this.consecutiveClean,
      triggeredBlock: false,
      triggeredClear: false,
    };
  }

  private evaluateDetections(timestamp: number, detections: DetectionResult[]): EvaluationResult {
    const breachingDetections: DetectionResult[] = [];

    for (const det of detections) {
      if (!det || typeof det.score !== "number" || typeof det.kind !== "string") {
        continue;
      }
      const threshold = this.getThresholdForKind(det.kind);
      if (det.score >= threshold) {
        breachingDetections.push(det);
      }
    }

    const hasBreach = breachingDetections.length > 0;
    let triggeredBlock = false;
    let triggeredClear = false;

    if (hasBreach) {
      this.consecutiveBreaches++;
      this.consecutiveClean = 0;

      if (this.currentState === "RECORDING") {
        if (this.consecutiveBreaches >= this.consecutiveBlockFrames) {
          this.currentState = "BLOCKED";
          triggeredBlock = true;
          this.recordBlockEvent(timestamp, breachingDetections);
        }
      } else if (this.currentState === "COOLDOWN") {
        // Cooldown interrupted: immediately revert to BLOCKED
        this.currentState = "BLOCKED";
      }
    } else {
      // Clean frame
      this.consecutiveClean++;
      this.consecutiveBreaches = 0;

      if (this.currentState === "BLOCKED") {
        // Transition to COOLDOWN upon first clean sample (or immediate RECORDING if recoveryCleanFrames === 1)
        if (this.consecutiveClean >= this.recoveryCleanFrames) {
          this.currentState = "RECORDING";
          triggeredClear = true;
          this.recordClearEvent(timestamp);
        } else {
          this.currentState = "COOLDOWN";
        }
      } else if (this.currentState === "COOLDOWN") {
        if (this.consecutiveClean >= this.recoveryCleanFrames) {
          this.currentState = "RECORDING";
          triggeredClear = true;
          this.recordClearEvent(timestamp);
        }
      }
    }

    return {
      isBlocked: this.isBlocked(),
      state: this.currentState,
      breachingDetections,
      hasBreach,
      consecutiveBreaches: this.consecutiveBreaches,
      consecutiveClean: this.consecutiveClean,
      triggeredBlock,
      triggeredClear,
    };
  }

  private recordBlockEvent(timestamp: number, breachingDetections: DetectionResult[]): void {
    if (this.mode === "shadow") {
      this.totalWouldBlock++;
    } else {
      this.totalBlocks++;
    }

    if (this.onBlockCallback) {
      try {
        this.onBlockCallback({
          timestamp,
          breachingDetections,
          consecutiveBreaches: this.consecutiveBreaches,
          mode: this.mode,
          isShadow: this.mode === "shadow",
        });
      } catch {
        // Suppress external callback errors
      }
    }
  }

  private recordClearEvent(timestamp: number): void {
    if (this.onClearCallback) {
      try {
        this.onClearCallback({
          timestamp,
          cleanFramesElapsed: this.consecutiveClean,
          mode: this.mode,
        });
      } catch {
        // Suppress external callback errors
      }
    }
  }
}
