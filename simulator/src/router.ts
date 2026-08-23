import crypto from "crypto";

export type RouterBehavior =
  | "healthy"       // good metrics, honest nonces
  | "degraded"      // poor metrics but honest
  | "offline"       // stops sending
  | "replay"        // resends the same nonce (attack)
  | "sybil"         // rapid device registration (attack)
  | "spoofed";      // impossibly good metrics (attack)

export interface TelemetryPacket {
  device_id: string;
  sequence_num: number;
  latency_ms: number;
  packet_loss_pct: number;
  download_mbps: number;
  upload_mbps: number;
  availability: boolean;
  nonce: string;
}

export class SimulatedRouter {
  readonly routerId: string;
  readonly region: string;
  deviceUuid: string = "";
  private sequence: number = 0;
  private lastNonce: string = "";
  behavior: RouterBehavior;

  constructor(index: number, behavior: RouterBehavior = "healthy") {
    this.routerId = `sim-router-${String(index).padStart(5, "0")}`;
    this.region = pickRegion();
    this.behavior = behavior;
  }

  /** Generate a telemetry packet based on this router's behavior. */
  generateTelemetry(): TelemetryPacket {
    this.sequence++;

    // Replay attack: reuse the previous nonce
    const nonce =
      this.behavior === "replay" && this.lastNonce
        ? this.lastNonce
        : crypto.randomBytes(16).toString("hex");

    this.lastNonce = nonce;

    const metrics = this.generateMetrics();

    return {
      device_id: this.deviceUuid,
      sequence_num: this.sequence,
      ...metrics,
      nonce,
    };
  }

  private generateMetrics() {
    switch (this.behavior) {
      case "healthy":
        return {
          latency_ms: randomBetween(15, 50),
          packet_loss_pct: randomBetween(0, 2),
          download_mbps: randomBetween(50, 150),
          upload_mbps: randomBetween(10, 50),
          availability: true,
        };
      case "degraded":
        return {
          latency_ms: randomBetween(100, 500),
          packet_loss_pct: randomBetween(5, 25),
          download_mbps: randomBetween(1, 20),
          upload_mbps: randomBetween(0.5, 5),
          availability: Math.random() > 0.3,
        };
      case "offline":
        return {
          latency_ms: 0,
          packet_loss_pct: 100,
          download_mbps: 0,
          upload_mbps: 0,
          availability: false,
        };
      case "spoofed":
        // Impossibly perfect metrics — the verification engine
        // (Step 5) should flag these as suspicious
        return {
          latency_ms: 0.1,
          packet_loss_pct: 0,
          download_mbps: 10000,
          upload_mbps: 10000,
          availability: true,
        };
      case "replay":
      case "sybil":
      default:
        return {
          latency_ms: randomBetween(20, 60),
          packet_loss_pct: randomBetween(0, 3),
          download_mbps: randomBetween(40, 120),
          upload_mbps: randomBetween(8, 40),
          availability: true,
        };
    }
  }
}

const REGIONS = [
  "bangalore", "mumbai", "delhi", "hyderabad", "chennai",
  "pune", "kolkata", "jaipur", "singapore", "dubai",
];

function pickRegion(): string {
  return REGIONS[Math.floor(Math.random() * REGIONS.length)];
}

function randomBetween(min: number, max: number): number {
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}
