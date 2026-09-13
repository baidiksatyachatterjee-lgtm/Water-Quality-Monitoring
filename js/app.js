/**
 * Main Application Orchestrator
 * Coordinates real-time telemetry, WQI calculation, alerting, charting, and hardware clients
 */

import { StorageManager, WATER_PRESETS } from './storage.js';
import { GaugeManager } from './gauges.js';
import { ChartManager } from './charts.js';
import { SensorSimulator } from './simulator.js';
import { SerialClient } from './serial-client.js';
import { MqttClient } from './mqtt-client.js';
import { FirmwareGenerator } from './firmware-gen.js';

class WaterQualityApp {
  constructor() {
    this.storage = new StorageManager();
    this.gauges = null;
    this.charts = null;
    this.simulator = null;
    this.serial = null;
    this.mqtt = null;

    this.activeSource = 'none'; // 'simulation' | 'serial' | 'mqtt' | 'none'
    this.historyRecords = []; // Max 1000 data points for CSV export
    this.alertLogs = [];
    this.audioContext = null;
    this.lastAlarmTime = 0;
    this.isAudioMuted = !this.storage.isSoundEnabled();

    // Sparkline history buffers (last 20 points per parameter)
    this.sparklines = {
      ph: [],
      turbidity: [],
      tds: [],
      temp: [],
      dissolvedOxygen: [],
      waterLevel: []
    };
  }

  init() {
    this.gauges = new GaugeManager();
    this.charts = new ChartManager('telemetryChart');

    this.initHardwareClients();
    this.bindUIEvents();
    this.loadStationSettings();
    this.initFirmwareGeneratorView();

    // Start with Simulation active by default so the user sees live interactive data immediately
    this.startSimulation();
  }

  initHardwareClients() {
    // Simulator client
    this.simulator = new SensorSimulator((data) => this.handleTelemetry(data));

    // Serial USB client
    this.serial = new SerialClient(
      (data) => this.handleTelemetry(data),
      (connected, msg) => this.handleConnectionStatus('serial', connected, msg),
      (source, raw) => this.appendTerminalLog(source, raw)
    );

    // Cloud MQTT client
    this.mqtt = new MqttClient(
      (data) => this.handleTelemetry(data),
      (connected, msg) => this.handleConnectionStatus('mqtt', connected, msg),
      (source, raw) => this.appendTerminalLog(source, raw)
    );
  }

  loadStationSettings() {
    const stationId = this.storage.getStationId();
    const stationElem = document.getElementById('currentStationDisplay');
    if (stationElem) stationElem.textContent = stationId;

    const brokerUrl = this.storage.getBrokerUrl();
    const brokerElem = document.getElementById('currentBrokerDisplay');
    if (brokerElem) {
      try {
        const urlObj = new URL(brokerUrl);
        brokerElem.textContent = urlObj.hostname;
      } catch (e) {
        brokerElem.textContent = brokerUrl;
      }
    }

    // Sound toggle state
    this.updateAudioButtonState();
  }

  // =========================================================================
  // TELEMETRY PROCESSING & WATER QUALITY INDEX (WQI)
  // =========================================================================
  handleTelemetry(packet) {
    const thresholds = this.storage.getThresholds();

    // Calculate individual parameters status
    const statusPH = this.checkThreshold(packet.ph, thresholds.ph);
    const statusTurb = this.checkThreshold(packet.turbidity, thresholds.turbidity);
    const statusTDS = this.checkThreshold(packet.tds, thresholds.tds);
    const statusTemp = this.checkThreshold(packet.temp, thresholds.temp);
    const statusDO = this.checkThreshold(packet.dissolvedOxygen, thresholds.dissolvedOxygen);
    const statusLevel = this.checkThreshold(packet.waterLevel, thresholds.waterLevel);

    // Update individual gauge cards
    this.gauges.updateSensorCard('ph', packet.ph, thresholds.ph, statusPH);
    this.gauges.updateSensorCard('turbidity', packet.turbidity, thresholds.turbidity, statusTurb);
    this.gauges.updateSensorCard('tds', packet.tds, thresholds.tds, statusTDS);
    this.gauges.updateSensorCard('temp', packet.temp, thresholds.temp, statusTemp);
    this.gauges.updateSensorCard('dissolvedOxygen', packet.dissolvedOxygen, thresholds.dissolvedOxygen, statusDO);
    this.gauges.updateSensorCard('waterLevel', packet.waterLevel, thresholds.waterLevel, statusLevel);

    // Update Sparklines
    this.pushSparkline('ph', packet.ph, 'sparkline-ph');
    this.pushSparkline('turbidity', packet.turbidity, 'sparkline-turbidity');
    this.pushSparkline('tds', packet.tds, 'sparkline-tds');
    this.pushSparkline('temp', packet.temp, 'sparkline-temp');

    // Compute Overall Water Quality Index (WQI)
    const { wqiScore, wqiStatus, wqiDesc } = this.calculateWQI(packet, thresholds);
    this.gauges.updateWQI(wqiScore, wqiStatus, wqiDesc);

    // Update Chart.js stream
    this.charts.addDataPoint(packet.timestamp, packet);

    // Check for Anomaly / Danger triggers
    this.evaluateAlerts(packet, thresholds, {
      ph: statusPH,
      turbidity: statusTurb,
      tds: statusTDS,
      temp: statusTemp,
      dissolvedOxygen: statusDO
    });

    // Append to in-memory telemetry history
    const record = {
      timestamp: packet.timestamp,
      stationId: this.storage.getStationId(),
      source: packet.source,
      ...packet,
      wqi: wqiScore,
      wqiStatus: wqiStatus
    };
    this.historyRecords.push(record);
    if (this.historyRecords.length > 1000) this.historyRecords.shift();

    // Log to terminal
    this.appendTerminalLog(packet.source.toUpperCase(), JSON.stringify(packet));

    // Update Meta info
    const lastPktElem = document.getElementById('metaLastPacket');
    if (lastPktElem) lastPktElem.textContent = packet.timestamp;

    const rssiElem = document.getElementById('metaRssi');
    if (rssiElem && packet.rssi) {
      rssiElem.textContent = `${packet.rssi} dBm`;
    }
  }

  checkThreshold(value, bounds) {
    if (!bounds) return 'safe';
    if (value < bounds.min * 0.9 || value > bounds.max * 1.1) {
      return 'danger';
    }
    if (value < bounds.min || value > bounds.max) {
      return 'warning';
    }
    return 'safe';
  }

  pushSparkline(key, val, canvasId) {
    if (!this.sparklines[key]) this.sparklines[key] = [];
    this.sparklines[key].push(val);
    if (this.sparklines[key].length > 20) this.sparklines[key].shift();
    this.gauges.drawSparkline(canvasId, this.sparklines[key]);
  }

  /**
   * Standard Weighted Arithmetic Water Quality Index (WQI)
   */
  calculateWQI(packet, thresholds) {
    // Weights normalized to sum = 1.0
    const weights = {
      ph: 0.25,
      turbidity: 0.25,
      tds: 0.20,
      dissolvedOxygen: 0.15,
      temp: 0.15
    };

    // Sub-index score calculation (0 - 100 for each, 100 being best)
    // 1. pH: optimal 7.0 (100). Drops as it deviates from neutral
    const phDev = Math.abs(packet.ph - 7.0);
    const qPH = Math.max(0, 100 - phDev * 28);

    // 2. Turbidity: optimal 0 (100). Drops as turbidity rises
    const qTurb = Math.max(0, 100 - (packet.turbidity / (thresholds.turbidity.max || 5)) * 40);

    // 3. TDS: optimal 100-250 (100).
    const qTDS = Math.max(0, 100 - Math.max(0, (packet.tds - 200) / 6));

    // 4. Dissolved Oxygen: optimal >= 7.5 mg/L (100).
    const qDO = Math.min(100, (packet.dissolvedOxygen / 8.0) * 100);

    // 5. Temp: optimal 22°C
    const tempDev = Math.abs(packet.temp - 22.0);
    const qTemp = Math.max(0, 100 - tempDev * 5);

    const wqi = (qPH * weights.ph) +
                (qTurb * weights.turbidity) +
                (qTDS * weights.tds) +
                (qDO * weights.dissolvedOxygen) +
                (qTemp * weights.temp);

    const roundedWQI = Math.round(Math.max(0, Math.min(100, wqi)));

    let status = 'Excellent';
    let desc = 'Water quality is pristine. All physiological and chemical parameters are in optimal range.';

    if (roundedWQI >= 90) {
      status = 'Excellent';
      desc = 'Water quality is pristine. Safe for human consumption, aquaculture, and delicate aquatic ecosystems.';
    } else if (roundedWQI >= 75) {
      status = 'Good';
      desc = 'Water quality is acceptable for domestic use. Normal mineral balance with safe turbidity levels.';
    } else if (roundedWQI >= 55) {
      status = 'Moderate';
      desc = 'Mild water parameter deviation. Filtration recommended before consumption; continuous monitoring advised.';
    } else if (roundedWQI >= 35) {
      status = 'Poor';
      desc = 'Substandard water quality. Elevated contaminants or turbidity detected. Treatment required.';
    } else {
      status = 'Unsafe';
      desc = 'CRITICAL HAZARD: High contamination or extreme pH/turbidity. Not safe for consumption or aquatic life!';
    }

    return { wqiScore: roundedWQI, wqiStatus: status, wqiDesc: desc };
  }

  evaluateAlerts(packet, thresholds, statuses) {
    const alertBanner = document.getElementById('alertBanner');
    const alertText = document.getElementById('alertBannerText');
    const violations = [];

    if (statuses.ph === 'danger') violations.push(`pH ${packet.ph} (Safe: ${thresholds.ph.min}-${thresholds.ph.max})`);
    if (statuses.turbidity === 'danger') violations.push(`Turbidity ${packet.turbidity} NTU (Max: ${thresholds.turbidity.max})`);
    if (statuses.tds === 'danger') violations.push(`TDS ${packet.tds} ppm (Max: ${thresholds.tds.max})`);
    if (statuses.dissolvedOxygen === 'danger') violations.push(`DO ${packet.dissolvedOxygen} mg/L`);

    if (violations.length > 0) {
      if (alertBanner && alertText) {
        alertBanner.classList.add('active');
        alertText.textContent = `ALERT: Critical anomaly detected — ${violations.join(' | ')}`;
      }
      this.playAlarmChime();
    } else {
      if (alertBanner) alertBanner.classList.remove('active');
    }
  }

  playAlarmChime() {
    if (this.isAudioMuted) return;
    const now = Date.now();
    if (now - this.lastAlarmTime < 4000) return; // Debounce audio chimes
    this.lastAlarmTime = now;

    try {
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
      }

      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, this.audioContext.currentTime); // A5 note
      osc.frequency.exponentialRampToValueAtTime(440, this.audioContext.currentTime + 0.3);

      gain.gain.setValueAtTime(0.3, this.audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.4);

      osc.connect(gain);
      gain.connect(this.audioContext.destination);

      osc.start();
      osc.stop(this.audioContext.currentTime + 0.4);
    } catch (e) {
      console.warn('Audio playback error', e);
    }
  }

  // =========================================================================
  // CONNECTION CONTROLS
  // =========================================================================
  startSimulation() {
    this.disconnectAll();
    this.activeSource = 'simulation';
    this.simulator.start(1500);

    this.updateConnectionPill('simulated', 'Simulated Live Stream');
    this.updateModeButtons('btnModeSim');
  }

  async connectSerial() {
    this.disconnectAll();
    this.updateConnectionPill('disconnected', 'Connecting USB Serial...');
    const ok = await this.serial.connect(115200);
    if (ok) {
      this.activeSource = 'serial';
      this.updateConnectionPill('connected', 'ESP32 USB Serial (115200 baud)');
      this.updateModeButtons('btnModeSerial');
    } else {
      // Revert to simulation
      this.startSimulation();
    }
  }

  connectMQTT() {
    this.disconnectAll();
    const stationId = this.storage.getStationId();
    const brokerUrl = this.storage.getBrokerUrl();

    this.activeSource = 'mqtt';
    this.updateConnectionPill('disconnected', 'Connecting to Cloud MQTT...');
    this.mqtt.connect(brokerUrl, stationId);
    this.updateModeButtons('btnModeMqtt');
  }

  disconnectAll() {
    if (this.simulator) this.simulator.stop();
    if (this.serial && this.serial.isConnected) this.serial.disconnect();
    if (this.mqtt && this.mqtt.isConnected) this.mqtt.disconnect();
    this.activeSource = 'none';
  }

  handleConnectionStatus(clientType, isConnected, message) {
    if (isConnected) {
      this.updateConnectionPill('connected', message);
    } else {
      this.updateConnectionPill('disconnected', message);
    }
  }

  updateConnectionPill(statusClass, label) {
    const pill = document.getElementById('connectionPill');
    const text = document.getElementById('connectionStatusText');
    if (pill && text) {
      pill.className = `connection-pill ${statusClass}`;
      text.textContent = label;
    }
    const metaSource = document.getElementById('metaSource');
    if (metaSource) metaSource.textContent = label;
  }

  updateModeButtons(activeBtnId) {
    ['btnModeSim', 'btnModeSerial', 'btnModeMqtt'].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) {
        if (id === activeBtnId) {
          btn.classList.add('btn-primary');
          btn.classList.remove('btn-secondary');
        } else {
          btn.classList.remove('btn-primary');
          btn.classList.add('btn-secondary');
        }
      }
    });
  }

  // =========================================================================
  // TERMINAL & EXPORT
  // =========================================================================
  appendTerminalLog(source, rawText) {
    const terminal = document.getElementById('terminalBody');
    if (!terminal) return;

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const line = document.createElement('div');
    line.className = 'terminal-line';
    line.innerHTML = `
      <span class="terminal-time">[${time}]</span>
      <span class="terminal-topic">[${source}]</span>
      <span class="terminal-json">${this.escapeHtml(rawText)}</span>
    `;

    terminal.insertBefore(line, terminal.firstChild);

    // Limit lines to 100
    while (terminal.children.length > 100) {
      terminal.removeChild(terminal.lastChild);
    }
  }

  escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  exportCSV() {
    if (this.historyRecords.length === 0) {
      alert('No telemetry data collected yet to export.');
      return;
    }

    const headers = ['Timestamp', 'Station_ID', 'Source', 'pH', 'Turbidity_NTU', 'TDS_ppm', 'Temp_C', 'DO_mgL', 'WaterLevel_pct', 'WQI', 'WQI_Status'];
    const rows = this.historyRecords.map(r => [
      `"${r.timestamp}"`,
      `"${r.stationId}"`,
      `"${r.source}"`,
      r.ph,
      r.turbidity,
      r.tds,
      r.temp,
      r.dissolvedOxygen,
      r.waterLevel,
      r.wqi,
      `"${r.wqiStatus}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `water_quality_${this.storage.getStationId()}_${Date.now()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  exportJSON() {
    if (this.historyRecords.length === 0) {
      alert('No telemetry data collected yet to export.');
      return;
    }
    const jsonStr = JSON.stringify(this.historyRecords, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `water_quality_${this.storage.getStationId()}_${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  // =========================================================================
  // FIRMWARE & SETTINGS MODALS
  // =========================================================================
  initFirmwareGeneratorView() {
    const stationId = this.storage.getStationId();
    const stationInput = document.getElementById('fwStationId');
    if (stationInput) stationInput.value = stationId;

    this.updateFirmwareCodePreview();
  }

  updateFirmwareCodePreview() {
    const config = {
      ssid: document.getElementById('fwSsid')?.value || 'YOUR_WIFI_SSID',
      password: document.getElementById('fwPassword')?.value || 'YOUR_WIFI_PASSWORD',
      stationId: document.getElementById('fwStationId')?.value || this.storage.getStationId(),
      mqttBroker: document.getElementById('fwBroker')?.value || 'broker.hivemq.com',
      mqttPort: 1883,
      pinPH: parseInt(document.getElementById('fwPinPH')?.value || '34'),
      pinTurbidity: parseInt(document.getElementById('fwPinTurb')?.value || '35'),
      pinTDS: parseInt(document.getElementById('fwPinTDS')?.value || '32'),
      pinTemp: parseInt(document.getElementById('fwPinTemp')?.value || '4'),
      intervalMs: 2000
    };

    const code = FirmwareGenerator.generateCode(config);
    const codeElem = document.getElementById('generatedFirmwareCode');
    if (codeElem) codeElem.textContent = code;
    return code;
  }

  bindUIEvents() {
    // Mode toggles
    document.getElementById('btnModeSim')?.addEventListener('click', () => this.startSimulation());
    document.getElementById('btnModeSerial')?.addEventListener('click', () => this.connectSerial());
    document.getElementById('btnModeMqtt')?.addEventListener('click', () => this.connectMQTT());

    // Audio alarm toggle
    document.getElementById('btnToggleAudio')?.addEventListener('click', () => {
      this.isAudioMuted = !this.isAudioMuted;
      this.storage.setSoundEnabled(!this.isAudioMuted);
      this.updateAudioButtonState();
    });

    // Chart timeframe buttons
    document.querySelectorAll('.timeframe-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.timeframe-btn').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        const count = parseInt(e.currentTarget.dataset.count);
        this.charts.setTimeframe(count);
      });
    });

    // Chart dataset filter buttons
    document.querySelectorAll('.dataset-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.dataset-btn').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        const key = e.currentTarget.dataset.key;
        this.charts.setDatasetFilter(key);
      });
    });

    // Export buttons
    document.getElementById('btnExportCSV')?.addEventListener('click', () => this.exportCSV());
    document.getElementById('btnExportJSON')?.addEventListener('click', () => this.exportJSON());

    // Clear terminal
    document.getElementById('btnClearTerminal')?.addEventListener('click', () => {
      const term = document.getElementById('terminalBody');
      if (term) term.innerHTML = '';
    });

    // Anomaly simulation test triggers
    document.getElementById('btnTestAcid')?.addEventListener('click', () => {
      if (this.simulator) this.simulator.triggerAnomaly('acid');
    });
    document.getElementById('btnTestTurbid')?.addEventListener('click', () => {
      if (this.simulator) this.simulator.triggerAnomaly('turbid');
    });
    document.getElementById('btnTestSaline')?.addEventListener('click', () => {
      if (this.simulator) this.simulator.triggerAnomaly('saline');
    });

    // Modal triggers
    this.setupModal('btnOpenFirmwareModal', 'firmwareModal', 'btnCloseFirmwareModal');
    this.setupModal('btnOpenSettingsModal', 'settingsModal', 'btnCloseSettingsModal');

    // Firmware form inputs live update
    ['fwSsid', 'fwPassword', 'fwStationId', 'fwBroker', 'fwPinPH', 'fwPinTurb', 'fwPinTDS', 'fwPinTemp'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', () => this.updateFirmwareCodePreview());
    });

    // Copy Code button
    document.getElementById('btnCopyFirmwareCode')?.addEventListener('click', () => {
      const code = this.updateFirmwareCodePreview();
      navigator.clipboard.writeText(code).then(() => {
        const btn = document.getElementById('btnCopyFirmwareCode');
        const originalText = btn.innerHTML;
        btn.innerHTML = '✓ Copied!';
        setTimeout(() => { btn.innerHTML = originalText; }, 2000);
      });
    });

    // Download .ino button
    document.getElementById('btnDownloadFirmwareCode')?.addEventListener('click', () => {
      const code = this.updateFirmwareCodePreview();
      const stationId = document.getElementById('fwStationId')?.value || 'esp32';
      FirmwareGenerator.downloadSketch(code, `WaterQuality_${stationId}.ino`);
    });

    // Settings Modal Preset selector
    document.getElementById('settingPresetSelect')?.addEventListener('change', (e) => {
      const presetKey = e.target.value;
      this.storage.setPreset(presetKey);
      this.populateSettingsForm();
    });

    // Save Settings
    document.getElementById('btnSaveSettings')?.addEventListener('click', () => {
      this.saveCustomSettings();
    });
  }

  setupModal(openBtnId, modalId, closeBtnId) {
    const openBtn = document.getElementById(openBtnId);
    const modal = document.getElementById(modalId);
    const closeBtn = document.getElementById(closeBtnId);

    if (openBtn && modal) {
      openBtn.addEventListener('click', () => {
        modal.classList.add('active');
        if (modalId === 'settingsModal') this.populateSettingsForm();
        if (modalId === 'firmwareModal') this.updateFirmwareCodePreview();
      });
    }

    if (closeBtn && modal) {
      closeBtn.addEventListener('click', () => modal.classList.remove('active'));
    }

    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('active');
      });
    }
  }

  populateSettingsForm() {
    const stationInput = document.getElementById('settingStationId');
    if (stationInput) stationInput.value = this.storage.getStationId();

    const brokerInput = document.getElementById('settingBrokerUrl');
    if (brokerInput) brokerInput.value = this.storage.getBrokerUrl();

    const presetSelect = document.getElementById('settingPresetSelect');
    if (presetSelect) presetSelect.value = this.storage.getCurrentPreset();

    const thresholds = this.storage.getThresholds();
    if (thresholds.ph) {
      document.getElementById('threshPhMin').value = thresholds.ph.min;
      document.getElementById('threshPhMax').value = thresholds.ph.max;
    }
    if (thresholds.turbidity) {
      document.getElementById('threshTurbMax').value = thresholds.turbidity.max;
    }
    if (thresholds.tds) {
      document.getElementById('threshTdsMax').value = thresholds.tds.max;
    }
    if (thresholds.temp) {
      document.getElementById('threshTempMin').value = thresholds.temp.min;
      document.getElementById('threshTempMax').value = thresholds.temp.max;
    }
  }

  saveCustomSettings() {
    const stationId = document.getElementById('settingStationId')?.value.trim();
    if (stationId) {
      this.storage.setStationId(stationId);
    }

    const brokerUrl = document.getElementById('settingBrokerUrl')?.value.trim();
    if (brokerUrl) {
      this.storage.setBrokerUrl(brokerUrl);
    }

    const customThresholds = {
      ph: {
        min: parseFloat(document.getElementById('threshPhMin')?.value || '6.5'),
        max: parseFloat(document.getElementById('threshPhMax')?.value || '8.5'),
        unit: 'pH'
      },
      turbidity: {
        min: 0,
        max: parseFloat(document.getElementById('threshTurbMax')?.value || '5.0'),
        unit: 'NTU'
      },
      tds: {
        min: 50,
        max: parseFloat(document.getElementById('threshTdsMax')?.value || '300'),
        unit: 'ppm'
      },
      temp: {
        min: parseFloat(document.getElementById('threshTempMin')?.value || '10'),
        max: parseFloat(document.getElementById('threshTempMax')?.value || '30'),
        unit: '°C'
      },
      dissolvedOxygen: { min: 6.0, max: 14.0, unit: 'mg/L' },
      waterLevel: { min: 20, max: 100, unit: '%' }
    };

    this.storage.setThresholds(customThresholds);
    this.loadStationSettings();

    document.getElementById('settingsModal')?.classList.remove('active');
    alert('Settings successfully updated!');
  }

  updateAudioButtonState() {
    const btn = document.getElementById('btnToggleAudio');
    if (btn) {
      if (this.isAudioMuted) {
        btn.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="1" y1="1" x2="23" y2="23"></line>
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>
            <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
            <line x1="12" y1="19" x2="12" y2="23"></line>
            <line x1="8" y1="23" x2="16" y2="23"></line>
          </svg>
          Muted
        `;
        btn.className = 'btn btn-secondary';
      } else {
        btn.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
          </svg>
          Alarm Audio On
        `;
        btn.className = 'btn btn-amber';
      }
    }
  }
}

// Instantiate application upon DOM ready
window.addEventListener('DOMContentLoaded', () => {
  const app = new WaterQualityApp();
  app.init();
  window.WaterQualityApp = app; // Expose globally for console testing
});
