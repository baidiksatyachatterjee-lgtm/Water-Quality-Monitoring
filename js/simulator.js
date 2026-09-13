/**
 * Sensor Simulation Engine
 * Generates realistic real-time telemetry with micro-fluctuations and anomaly testing
 */

export class SensorSimulator {
  constructor(onDataCallback) {
    this.onDataCallback = onDataCallback;
    this.timer = null;
    this.isRunning = false;

    // Base state
    this.state = {
      ph: 7.38,
      turbidity: 1.85,
      tds: 215,
      temp: 23.6,
      dissolvedOxygen: 7.9,
      waterLevel: 82.0,
      rssi: -58
    };

    this.anomalyMode = null; // null | 'acid' | 'turbid' | 'saline'
    this.anomalyCountdown = 0;
  }

  start(intervalMs = 1500) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.tick(); // Immediate first tick
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }

  tick() {
    // Random walk with damping towards healthy baseline
    if (this.anomalyCountdown > 0) {
      this.anomalyCountdown--;
      if (this.anomalyCountdown === 0) {
        this.anomalyMode = null;
      }
    }

    if (this.anomalyMode === 'acid') {
      this.state.ph = Math.max(3.8, this.state.ph - 0.35 + (Math.random() * 0.1 - 0.05));
      this.state.tds += 8;
    } else if (this.anomalyMode === 'turbid') {
      this.state.turbidity = Math.min(85.0, this.state.turbidity + 6.5 + (Math.random() * 2 - 1));
      this.state.dissolvedOxygen = Math.max(3.2, this.state.dissolvedOxygen - 0.25);
    } else if (this.anomalyMode === 'saline') {
      this.state.tds = Math.min(880, this.state.tds + 45 + (Math.random() * 10 - 5));
    } else {
      // Normal drift towards equilibrium
      this.state.ph += (7.35 - this.state.ph) * 0.08 + (Math.random() * 0.08 - 0.04);
      this.state.turbidity += (1.9 - this.state.turbidity) * 0.08 + (Math.random() * 0.15 - 0.075);
      this.state.tds += (210 - this.state.tds) * 0.05 + (Math.random() * 4 - 2);
      this.state.temp += (23.5 - this.state.temp) * 0.04 + (Math.random() * 0.1 - 0.05);
      this.state.dissolvedOxygen += (7.8 - this.state.dissolvedOxygen) * 0.06 + (Math.random() * 0.1 - 0.05);
      this.state.waterLevel += (80.0 - this.state.waterLevel) * 0.02 + (Math.random() * 0.4 - 0.2);
    }

    // Wi-Fi RSSI variance
    this.state.rssi = -55 + Math.floor(Math.random() * 7 - 3);

    // Format packet identical to ESP32 payload
    const packet = {
      ph: Number(this.state.ph.toFixed(2)),
      turbidity: Number(this.state.turbidity.toFixed(2)),
      tds: Math.round(this.state.tds),
      temp: Number(this.state.temp.toFixed(1)),
      dissolvedOxygen: Number(this.state.dissolvedOxygen.toFixed(2)),
      waterLevel: Math.round(this.state.waterLevel),
      rssi: this.state.rssi,
      source: 'simulator',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    };

    if (this.onDataCallback) {
      this.onDataCallback(packet);
    }
  }

  triggerAnomaly(type, durationTicks = 12) {
    this.anomalyMode = type;
    this.anomalyCountdown = durationTicks;
  }
}
