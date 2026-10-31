import { describe, expect, it, vi } from "vitest";
import { PrivacyGate } from "../src/gate.js";
import { FrameSample } from "../src/types.js";

function makeFrame(
  detections: { kind: string; score: number }[],
  timestamp = Date.now(),
): FrameSample {
  return { timestamp, detections };
}

describe("PrivacyGate State Machine & Hysteresis", () => {
  it("initializes in RECORDING state with unblocked status", () => {
    const gate = new PrivacyGate();
    expect(gate.getState()).toBe("RECORDING");
    expect(gate.isBlocked()).toBe(false);

    const stats = gate.getStats();
    expect(stats.checks).toBe(0);
    expect(stats.blocks).toBe(0);
    expect(stats.wouldBlock).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it("requires N consecutive breaching samples to transition to BLOCKED", () => {
    const onBlock = vi.fn();
    const gate = new PrivacyGate({
      consecutiveBlockFrames: 3,
      rules: { face: 0.7 },
      onBlock,
    });

    // Sample 1: breach
    let res = gate.processFrame(makeFrame([{ kind: "face", score: 0.75 }]));
    expect(res.state).toBe("RECORDING");
    expect(res.isBlocked).toBe(false);
    expect(res.consecutiveBreaches).toBe(1);
    expect(onBlock).not.toHaveBeenCalled();

    // Sample 2: breach
    res = gate.processFrame(makeFrame([{ kind: "face", score: 0.8 }]));
    expect(res.state).toBe("RECORDING");
    expect(res.isBlocked).toBe(false);
    expect(res.consecutiveBreaches).toBe(2);
    expect(onBlock).not.toHaveBeenCalled();

    // Sample 3: breach (N reached)
    res = gate.processFrame(makeFrame([{ kind: "face", score: 0.85 }]));
    expect(res.state).toBe("BLOCKED");
    expect(res.isBlocked).toBe(true);
    expect(res.triggeredBlock).toBe(true);
    expect(res.consecutiveBreaches).toBe(3);
    expect(onBlock).toHaveBeenCalledTimes(1);

    expect(gate.getStats().blocks).toBe(1);
  });

  it("absorbs flicker / transient noise below N consecutive frames without blocking", () => {
    const onBlock = vi.fn();
    const gate = new PrivacyGate({
      consecutiveBlockFrames: 3,
      rules: { face: 0.7 },
      onBlock,
    });

    // Breach 1
    gate.processFrame(makeFrame([{ kind: "face", score: 0.9 }]));
    expect(gate.getState()).toBe("RECORDING");

    // Breach 2
    gate.processFrame(makeFrame([{ kind: "face", score: 0.9 }]));
    expect(gate.getState()).toBe("RECORDING");

    // Noise clears: clean frame resets consecutive breaches
    const cleanRes = gate.processFrame(makeFrame([]));
    expect(cleanRes.state).toBe("RECORDING");
    expect(cleanRes.consecutiveBreaches).toBe(0);
    expect(cleanRes.consecutiveClean).toBe(1);

    // Another single breach does not trigger block because count reset
    const breachAgain = gate.processFrame(makeFrame([{ kind: "face", score: 0.9 }]));
    expect(breachAgain.state).toBe("RECORDING");
    expect(breachAgain.consecutiveBreaches).toBe(1);
    expect(gate.isBlocked()).toBe(false);
    expect(onBlock).not.toHaveBeenCalled();
    expect(gate.getStats().blocks).toBe(0);
  });

  it("transitions to COOLDOWN and requires M clean samples to restore RECORDING", () => {
    const onBlock = vi.fn();
    const onClear = vi.fn();
    const gate = new PrivacyGate({
      consecutiveBlockFrames: 2,
      recoveryCleanFrames: 3,
      rules: { face: 0.6 },
      onBlock,
      onClear,
    });

    // Enter BLOCKED
    gate.processFrame(makeFrame([{ kind: "face", score: 0.8 }]));
    gate.processFrame(makeFrame([{ kind: "face", score: 0.8 }]));
    expect(gate.getState()).toBe("BLOCKED");
    expect(gate.isBlocked()).toBe(true);

    // Clean frame 1: transitions to COOLDOWN (still blocked in enforce mode)
    let res = gate.processFrame(makeFrame([]));
    expect(res.state).toBe("COOLDOWN");
    expect(res.isBlocked).toBe(true);
    expect(res.consecutiveClean).toBe(1);
    expect(onClear).not.toHaveBeenCalled();

    // Clean frame 2: remains in COOLDOWN
    res = gate.processFrame(makeFrame([]));
    expect(res.state).toBe("COOLDOWN");
    expect(res.isBlocked).toBe(true);
    expect(res.consecutiveClean).toBe(2);
    expect(onClear).not.toHaveBeenCalled();

    // Clean frame 3: reaches M, returns to RECORDING
    res = gate.processFrame(makeFrame([]));
    expect(res.state).toBe("RECORDING");
    expect(res.isBlocked).toBe(false);
    expect(res.triggeredClear).toBe(true);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("resets cooldown when a breach appears during recovery", () => {
    const gate = new PrivacyGate({
      consecutiveBlockFrames: 2,
      recoveryCleanFrames: 4,
      rules: { document: 0.8 },
    });

    // Trigger block
    gate.processFrame(makeFrame([{ kind: "document", score: 0.9 }]));
    gate.processFrame(makeFrame([{ kind: "document", score: 0.95 }]));
    expect(gate.getState()).toBe("BLOCKED");

    // Clean frame 1 -> enters COOLDOWN
    gate.processFrame(makeFrame([]));
    expect(gate.getState()).toBe("COOLDOWN");

    // Clean frame 2
    gate.processFrame(makeFrame([]));
    expect(gate.getState()).toBe("COOLDOWN");

    // Breach arrives during cooldown -> immediately reverts to BLOCKED and resets clean count
    const breachRes = gate.processFrame(makeFrame([{ kind: "document", score: 0.85 }]));
    expect(breachRes.state).toBe("BLOCKED");
    expect(breachRes.consecutiveClean).toBe(0);
    expect(breachRes.consecutiveBreaches).toBe(1);

    // Now needs full M clean frames again
    gate.processFrame(makeFrame([])); // clean 1 -> COOLDOWN
    gate.processFrame(makeFrame([])); // clean 2
    gate.processFrame(makeFrame([])); // clean 3
    expect(gate.getState()).toBe("COOLDOWN");

    gate.processFrame(makeFrame([])); // clean 4 -> RECORDING
    expect(gate.getState()).toBe("RECORDING");
  });
});

describe("PrivacyGate Modes: Shadow vs Enforce", () => {
  it("in shadow mode, tracks would-block events while isBlocked remains false", () => {
    const onBlock = vi.fn();
    const gate = new PrivacyGate({
      mode: "shadow",
      consecutiveBlockFrames: 2,
      rules: { face: 0.5 },
      onBlock,
    });

    expect(gate.getMode()).toBe("shadow");

    // Frame 1
    let res = gate.processFrame(makeFrame([{ kind: "face", score: 0.9 }]));
    expect(res.isBlocked).toBe(false);

    // Frame 2: triggers would-block
    res = gate.processFrame(makeFrame([{ kind: "face", score: 0.9 }]));
    expect(res.isBlocked).toBe(false); // Pipeline is never blocked in shadow mode
    expect(gate.isBlocked()).toBe(false);
    expect(res.triggeredBlock).toBe(true);

    const stats = gate.getStats();
    expect(stats.blocks).toBe(0);
    expect(stats.wouldBlock).toBe(1);

    expect(onBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "shadow",
        isShadow: true,
      }),
    );
  });

  it("supports dynamic mode switching between enforce and shadow", () => {
    const gate = new PrivacyGate({
      mode: "enforce",
      consecutiveBlockFrames: 1,
      rules: { face: 0.5 },
    });

    gate.processFrame(makeFrame([{ kind: "face", score: 0.9 }]));
    expect(gate.getState()).toBe("BLOCKED");
    expect(gate.isBlocked()).toBe(true);

    gate.setMode("shadow");
    expect(gate.getMode()).toBe("shadow");
    expect(gate.isBlocked()).toBe(false);

    gate.setMode("enforce");
    expect(gate.getMode()).toBe("enforce");
    expect(gate.isBlocked()).toBe(true);
  });
});

describe("PrivacyGate Error Handling & Fail Policy", () => {
  it("fails open by default: records error and maintains current unblocked state", () => {
    const onError = vi.fn();
    const gate = new PrivacyGate({
      failClosed: false,
      onError,
    });

    // Provide malformed frame
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = gate.processFrame({} as any);

    expect(res.isBlocked).toBe(false);
    expect(res.state).toBe("RECORDING");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(gate.getStats().errors).toBe(1);
  });

  it("fails closed when configured: treats exceptions as breach condition", () => {
    const onError = vi.fn();
    const gate = new PrivacyGate({
      failClosed: true,
      consecutiveBlockFrames: 1,
      onError,
    });

    // Corrupted frame triggers block under failClosed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = gate.processFrame({} as any);

    expect(res.isBlocked).toBe(true);
    expect(res.state).toBe("BLOCKED");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(gate.getStats().errors).toBe(1);
    expect(gate.getStats().blocks).toBe(1);
  });

  it("handles async detector wrapper failures with fail-closed", async () => {
    const gate = new PrivacyGate({
      failClosed: true,
      consecutiveBlockFrames: 1,
    });

    const failingDetector = async () => {
      throw new Error("Model inference crashed (e.g. OOM or hardware disconnect)");
    };

    const res = await gate.processDetectorCall(failingDetector);
    expect(res.isBlocked).toBe(true);
    expect(gate.getStats().errors).toBe(1);
  });

  it("handles async detector wrapper returning valid array of detections", async () => {
    const gate = new PrivacyGate({
      consecutiveBlockFrames: 1,
      rules: { face: 0.6 },
    });

    const successDetector = async () => [{ kind: "face", score: 0.85 }];
    const res = await gate.processDetectorCall(successDetector);

    expect(res.isBlocked).toBe(true);
    expect(res.state).toBe("BLOCKED");
    expect(res.breachingDetections).toHaveLength(1);
  });
});

describe("PrivacyGate Kind Configuration & Thresholds", () => {
  it("supports per-kind rules with custom thresholds and fallback to defaultThreshold", () => {
    const gate = new PrivacyGate({
      defaultThreshold: 0.9,
      rules: {
        face: 0.6,
        document: { threshold: 0.75 },
      },
    });

    expect(gate.getThresholdForKind("face")).toBe(0.6);
    expect(gate.getThresholdForKind("document")).toBe(0.75);
    expect(gate.getThresholdForKind("credit_card")).toBe(0.9);

    // Score 0.65 for face breaches (0.65 >= 0.6)
    const faceRes = gate.processFrame(makeFrame([{ kind: "face", score: 0.65 }]));
    expect(faceRes.hasBreach).toBe(true);

    gate.reset();

    // Score 0.65 for document is clean (0.65 < 0.75)
    const docRes = gate.processFrame(makeFrame([{ kind: "document", score: 0.65 }]));
    expect(docRes.hasBreach).toBe(false);

    // Score 0.80 for unknown kind is clean against default 0.90
    const cardRes = gate.processFrame(makeFrame([{ kind: "credit_card", score: 0.8 }]));
    expect(cardRes.hasBreach).toBe(false);
  });

  it("allows resetting state and stats independently", () => {
    const gate = new PrivacyGate({ consecutiveBlockFrames: 1 });
    gate.processFrame(makeFrame([{ kind: "face", score: 0.9 }]));
    expect(gate.getState()).toBe("BLOCKED");
    expect(gate.getStats().checks).toBe(1);

    gate.reset();
    expect(gate.getState()).toBe("RECORDING");
    expect(gate.getStats().checks).toBe(1);

    gate.resetStats();
    expect(gate.getStats().checks).toBe(0);
  });
});
