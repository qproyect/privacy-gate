/**
 * Simulated Detector Pipeline Example
 *
 * Demonstrates the deterministic privacy gate processing a live stream
 * of synthetic frame detections across normal, noisy, breaching, and recovery phases.
 *
 * Run with: npx tsx examples/demo.ts
 */
import { PrivacyGate } from "../src/index.js";
import { FrameSample } from "../src/types.js";

// Initialize privacy gate with hysteresis thresholds
const gate = new PrivacyGate({
  mode: "enforce",
  consecutiveBlockFrames: 3, // Requires 3 consecutive breach samples to block
  recoveryCleanFrames: 4, // Requires 4 clean samples to restore recording
  rules: {
    face: 0.65,
    document: 0.75,
  },
  onBlock: (event) => {
    console.log(
      `\n🚨 [EVENT: ON_BLOCK] Pipeline suppressed at t=${event.timestamp}ms. ` +
        `Detected: ${event.breachingDetections.map((d) => `${d.kind} (${d.score.toFixed(2)})`).join(", ")}`,
    );
  },
  onClear: (event) => {
    console.log(
      `\n✅ [EVENT: ON_CLEAR] Pipeline resumed at t=${event.timestamp}ms after ${event.cleanFramesElapsed} clean frames.`,
    );
  },
  onError: (err) => {
    console.error(`\n⚠️  [EVENT: ON_ERROR] Detector error:`, err);
  },
});

console.log("===============================================================");
console.log("       PRIVACY GATE PIPELINE DEMONSTRATION (ENFORCE MODE)     ");
console.log("===============================================================");
console.log("Config: Block after 3 consecutive breach frames; restore after 4 clean frames.\n");

// Sequence of synthetic scenarios representing typical video/camera stream conditions:
const scenarios: { desc: string; frames: FrameSample[] }[] = [
  {
    desc: "Phase 1: Normal clean streaming",
    frames: [
      { timestamp: 1000, detections: [] },
      { timestamp: 1033, detections: [] },
      { timestamp: 1066, detections: [] },
    ],
  },
  {
    desc: "Phase 2: Transient detector noise (1-2 isolated spikes, below N=3)",
    frames: [
      { timestamp: 1100, detections: [{ kind: "face", score: 0.85 }] }, // Breach 1
      { timestamp: 1133, detections: [] }, // Cleared! Hysteresis resets breach count
      { timestamp: 1166, detections: [{ kind: "document", score: 0.9 }] }, // Breach 1
      { timestamp: 1200, detections: [] }, // Cleared!
    ],
  },
  {
    desc: "Phase 3: Sustained privacy breach (N=3 consecutive frames -> BLOCKED)",
    frames: [
      { timestamp: 1233, detections: [{ kind: "face", score: 0.72 }] }, // Breach 1
      { timestamp: 1266, detections: [{ kind: "face", score: 0.81 }] }, // Breach 2
      { timestamp: 1300, detections: [{ kind: "face", score: 0.89 }] }, // Breach 3 -> TRIGGER BLOCK!
      { timestamp: 1333, detections: [{ kind: "face", score: 0.84 }] }, // Still blocked
    ],
  },
  {
    desc: "Phase 4: Cooldown & Recovery (Clean frames -> COOLDOWN -> RECORDING)",
    frames: [
      { timestamp: 1366, detections: [] }, // Clean 1 (enters COOLDOWN)
      { timestamp: 1400, detections: [] }, // Clean 2
      { timestamp: 1433, detections: [] }, // Clean 3
      { timestamp: 1466, detections: [] }, // Clean 4 (restores RECORDING)
      { timestamp: 1500, detections: [] }, // Clean 5 (normal streaming)
    ],
  },
  {
    desc: "Phase 5: Interrupted Cooldown (Spike during recovery resets COOLDOWN to BLOCKED)",
    frames: [
      { timestamp: 1533, detections: [{ kind: "face", score: 0.95 }] }, // Breach 1
      { timestamp: 1566, detections: [{ kind: "face", score: 0.95 }] }, // Breach 2
      { timestamp: 1600, detections: [{ kind: "face", score: 0.95 }] }, // Breach 3 -> BLOCKED
      { timestamp: 1633, detections: [] }, // Clean 1 -> COOLDOWN
      { timestamp: 1666, detections: [{ kind: "face", score: 0.92 }] }, // Breach during COOLDOWN!
      { timestamp: 1700, detections: [] }, // Clean 1
      { timestamp: 1733, detections: [] }, // Clean 2
      { timestamp: 1766, detections: [] }, // Clean 3
      { timestamp: 1800, detections: [] }, // Clean 4 -> RESTORED
    ],
  },
];

for (const scenario of scenarios) {
  console.log(`\n--- ${scenario.desc} ---`);
  for (const frame of scenario.frames) {
    const result = gate.processFrame(frame);
    const breachInfo =
      result.breachingDetections.length > 0
        ? `[BREACH: ${result.breachingDetections.map((d) => `${d.kind}=${d.score}`).join(",")}]`
        : "[CLEAN]";
    const stateBadge =
      result.state === "BLOCKED"
        ? "⛔ BLOCKED "
        : result.state === "COOLDOWN"
          ? "⏳ COOLDOWN"
          : "🟢 RECORDING";

    console.log(
      `t=${frame.timestamp}ms | State: ${stateBadge} | Stream Blocked: ${result.isBlocked ? "YES" : "NO "} | ` +
        `Breaches: ${result.consecutiveBreaches} | Clean: ${result.consecutiveClean} | ${breachInfo}`,
    );
  }
}

console.log("\n===============================================================");
console.log("                    FINAL PIPELINE STATS                       ");
console.log("===============================================================");
console.table(gate.getStats());
console.log("Demo completed successfully.\n");
