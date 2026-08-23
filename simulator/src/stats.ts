export class Stats {
  registrations = { success: 0, failed: 0, duplicate: 0 };
  telemetry = { success: 0, failed: 0, replay_blocked: 0 };
  private startTime = Date.now();

  recordRegistration(status: number) {
    if (status === 200 || status === 201) this.registrations.success++;
    else if (status === 409) this.registrations.duplicate++;
    else this.registrations.failed++;
  }

  recordTelemetry(status: number, error?: string) {
    if (status === 200 || status === 201) this.telemetry.success++;
    else if (error?.includes("duplicate nonce")) this.telemetry.replay_blocked++;
    else this.telemetry.failed++;
  }

  print() {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const totalTx = this.telemetry.success + this.telemetry.failed + this.telemetry.replay_blocked;
    const tps = totalTx / (parseFloat(elapsed) || 1);

    console.log("\n==== Simulation Results ====");
    console.log(`Duration: ${elapsed}s`);
    console.log(`\nRegistrations:`);
    console.log(`  Success:    ${this.registrations.success}`);
    console.log(`  Duplicate:  ${this.registrations.duplicate}`);
    console.log(`  Failed:     ${this.registrations.failed}`);
    console.log(`\nTelemetry:`);
    console.log(`  Success:    ${this.telemetry.success}`);
    console.log(`  Replay blocked: ${this.telemetry.replay_blocked}`);
    console.log(`  Failed:     ${this.telemetry.failed}`);
    console.log(`  Throughput: ${tps.toFixed(1)} packets/sec`);
    console.log("============================\n");
  }
}
