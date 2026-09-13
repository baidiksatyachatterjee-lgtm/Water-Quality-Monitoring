/**
 * Main Application Orchestrator (Universal Multi-ESP32 Edition)
 * Coordinates auto-discovery, telemetry normalization, WQI calculation, alerting, charting, and multi-device routing.
 */

import { StorageManager, WATER_PRESETS } from './storage.js';
import { GaugeManager } from './gauges.js';
import { ChartManager } from './charts.js';
import { SensorSimulator } from './simulator.js';
import { SerialClient } from './serial-client.js';
import { MqttClient } from './mqtt-client.js';
import { FirmwareGenerator } from './firmware-gen.js';
import { PayloadAdapter } from './payload-adapter.js';

class WaterQualityApp {
  constructor() {
    this.storage = new StorageManager();
    this.gauges = null;
    this.charts = null;
    this.simulator = null;
    this.serial = null;
    this.mqtt = null;

    this.activeSource = 'none'; // 'simulation' | 'serial' | 'mqtt' | 'none'
    this.historyRecords = [];
    this.alertLogs = [];
    this.audioContext = null;
    this.lastAlarmTime = 0;
    this.isAudioMuted = !this.storage.isSoundEnabled();

    // Multi-Device Registry
    this.discoveredDevices = new Map(); // id -> { id, lastSeen, rssi, packetCount }
    this.selectedDeviceId = 'auto'; // 'auto' | specific deviceId

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
    this.handleUrlParameters();

    // If deployed online (e.g. *.vercel.app, *.github.io), automatically start Cloud MQTT!
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (this.activeSource === 'none') {
      if (isLocalhost) {
        this.startSimulation();
      } else {
        this.connectMQTT();
      }
    }
  }

  handleUrlParameters() {
    const params = new URLSearchParams(window.location.search);
    const urlDevice = params.get('device');
    const urlMode = params.get('mode');
    const urlBroker = params.get('broker');

    if (urlBroker) {
      this.storage.setBrokerUrl(urlBroker);
    }

    if (urlDevice) {
      this.selectedDeviceId = urlDevice.trim();
      this.registerDevice({ id: this.selectedDeviceId, lastSeen: Date.now(), rssi: -60, packetCount: 0 });
    }

    if (urlMode === 'mqtt') {
      this.connectMQTT();
    } else if (urlMode === 'serial') {
      this.connectSerial();
    }
  }

  initHardwareClients() {
    // Simulator client
    this.simulator = new SensorSimulator((data) => {
      const normalized = PayloadAdapter.normalize(data, 'simulator', 'ESP32_Simulated');
      this.handleTelemetry(normalized);
    });

    // Serial USB client
    this.serial = new SerialClient(
      (data) => this.handleTelemetry(data),
      (connected, msg) => this.handleConnectionStatus('serial', connected, msg),
      (source, raw) => this.appendTerminalLog(source, raw)
    );

    // Cloud MQTT client with Auto-Discovery
    this.mqtt = new MqttClient(
      (data) => this.handleTelemetry(data),
      (connected, msg) => this.handleConnectionStatus('mqtt', connected, msg),
      (source, raw) => this.appendTerminalLog(source, raw),
      (deviceInfo, isNew, allDevices) => this.handleDeviceDiscovered(deviceInfo, isNew, allDevices)
    );
  }

  loadStationSettings() {
    const stationId = this.storage.getStationId();
    const stationElem = document.getElementById('currentStationDisplay');
    if (stationElem) stationElem.textContent = this.selectedDeviceId === 'auto' ? 'Auto-Detect' : this.selectedDeviceId;

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

    this.updateAudioButtonState();
  }

  // =========================================================================
  // MULTI-DEVICE AUTO-DISCOVERY & FILTERING
  // =========================================================================
  handleDeviceDiscovered(deviceInfo, isNew, allDevices) {
    this.registerDevice(deviceInfo);
  }

  registerDevice(deviceInfo) {
    const deviceId = deviceInfo.id;
    const isNew = !this.discoveredDevices.has(deviceId);

    this.discoveredDevices.set(deviceId, {
      ...deviceInfo,
      lastSeen: Date.now()
    });

    this.updateDeviceSelectorUI();

    if (isNew) {
      this.appendTerminalLog('DISCOVERY', `New ESP32 Detected: [${deviceId}]`);
    }
  }

  updateDeviceSelectorUI() {
    const selector = document.getElementById('deviceSelector');
    const badge = document.getElementById('deviceCountBadge');
    if (!selector) return;

    const count = this.discoveredDevices.size;
    if (badge) {
      badge.textContent = `${count} Online`;
      badge.style.display = count > 0 ? 'inline-flex' : 'none';
    }

    const currentSelection = this.selectedDeviceId;
    selector.innerHTML = '';

    // "Auto-Select Active Device" option
    const autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = `Auto-Select Active Device (${count} active)`;
    selector.appendChild(autoOpt);

    // List each detected ESP32
    for (const [id, info] of this.discoveredDevices.entries()) {
      const opt = document.createElement('option');
      opt.value = id;
      const secondsAgo = Math.round((Date.now() - info.lastSeen) / 1000);
      opt.textContent = `🟢 ${id} (${info.rssi ? info.rssi + ' dBm' : 'Online'})`;
      selector.appendChild(opt);
    }

    selector.value = currentSelection;
  }

  // =========================================================================
  // TELEMETRY PROCESSING & WATER QUALITY INDEX (WQI)
  // =========================================================================
  handleTelemetry(packet) {
    if (!packet) return;

    // Register device in multi-device map
    this.registerDevice({
      id: packet.deviceId,
      rssi: packet.rssi,
      packetCount: 1
    });

    // Device filtering: if a specific device is selected and this packet is from another, skip updating gauges
    if (this.selectedDeviceId !== 'auto' && packet.deviceId !== this.selectedDeviceId) {
      // Still log to terminal
      this.appendTerminalLog(packet.source.toUpperCase(), `[${packet.deviceId}] ${JSON.stringify(packet)}`);
      return;
    }

    const thresholds = this.storage.getThresholds();

    // Calculate parameter statuses
    const statusPH = this.checkThreshold(packet.ph, thresholds.ph);
    const statusTurb = this.checkThreshold(packet.turbidity, thresholds.turbidity);
    const statusTDS = this.checkThreshold(packet.tds, thresholds.tds);
    const statusTemp = this.checkThreshold(packet.temp, thresholds.temp);
    const statusDO = this.checkThreshold(packet.dissolvedOxygen, thresholds.dissolvedOxygen);
    const statusLevel = this.checkThreshold(packet.waterLevel, thresholds.waterLevel);

    // Update gauge cards
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

    // Evaluate hazard thresholds
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
      deviceId: packet.deviceId,
      stationId: packet.deviceId,
      source: packet.source,
      ...packet,
      wqi: wqiScore,
      wqiStatus: wqiStatus
    };
    this.historyRecords.push(record);
    if (this.historyRecords.length > 1000) this.historyRecords.shift();

    // Log to terminal
    this.appendTerminalLog(packet.source.toUpperCase(), `[${packet.deviceId}] ${JSON.stringify(packet)}`);

    // Update Meta info
    const lastPktElem = document.getElementById('metaLastPacket');
    if (lastPktElem) lastPktElem.textContent = `${packet.timestamp} (Node: ${packet.deviceId})`;

    const rssiElem = document.getElementById('metaRssi');
    if (rssiElem && packet.rssi) {
      rssiElem.textContent = `${packet.rssi} dBm`;
    }

    const stationElem = document.getElementById('currentStationDisplay');
    if (stationElem) {
      stationElem.textContent = packet.deviceId;
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

  calculateWQI(packet, thresholds) {
    const weights = {
      ph: 0.25,
      turbidity: 0.25,
      tds: 0.20,
      dissolvedOxygen: 0.15,
      temp: 0.15
    };

    const phDev = Math.abs(packet.ph - 7.0);
    const qPH = Math.max(0, 100 - phDev * 28);
    const qTurb = Math.max(0, 100 - (packet.turbidity / (thresholds.turbidity.max || 5)) * 40);
    const qTDS = Math.max(0, 100 - Math.max(0, (packet.tds - 200) / 6));
    const qDO = Math.min(100, (packet.dissolvedOxygen / 8.0) * 100);
    const tempDev = Math.abs(packet.temp - 22.0);
    const qTemp = Math.max(0, 100 - tempDev * 5);

    const wqi = (qPH * weights.ph) +
                (qTurb * weights.turbidity) +
                (qTDS * weights.tds) +
                (qDO * weights.dissolvedOxygen) +
                (qTemp * weights.temp);

    const roundedWQI = Math.round(Math.max(0, Math.min(100, wqi)));

    let status = 'Excellent';
    let desc = 'Water quality is pristine. All physiological, chemical, and mineral parameters are within optimal safety bounds.';

    if (roundedWQI >= 90) {
      status = 'Excellent';
      desc = 'Water quality is pristine. Safe for human consumption, aquaculture, and sensitive aquatic ecosystems.';
    } else if (roundedWQI >= 75) {
      status = 'Good';
      desc = 'Water quality is acceptable for domestic and recreational use with safe mineral balance.';
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
        alertText.textContent = `ALERT [${packet.deviceId}]: Critical anomaly detected — ${violations.join(' | ')}`;
      }
      this.playAlarmChime();
    } else {
      if (alertBanner) alertBanner.classList.remove('active');
    }
  }

  playAlarmChime() {
    if (this.isAudioMuted) return;
    const now = Date.now();
    if (now - this.lastAlarmTime < 4000) return;
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
      osc.frequency.setValueAtTime(880, this.audioContext.currentTime);
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
    const baudSelect = document.getElementById('serialBaudSelect');
    const baudRate = baudSelect ? parseInt(baudSelect.value) : 115200;

    this.updateConnectionPill('disconnected', `Connecting USB Serial @ ${baudRate}...`);
    const ok = await this.serial.connect(baudRate);
    if (ok) {
      this.activeSource = 'serial';
      this.updateConnectionPill('connected', `ESP32 USB Serial (${baudRate} baud)`);
      this.updateModeButtons('btnModeSerial');
    } else {
      this.startSimulation();
    }
  }

  connectMQTT() {
    this.disconnectAll();
    const stationId = this.storage.getStationId();
    const brokerUrl = this.storage.getBrokerUrl();

    this.activeSource = 'mqtt';
    this.updateConnectionPill('disconnected', 'Connecting Cloud MQTT Auto-Discovery...');
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

    const headers = ['Timestamp', 'Device_ID', 'Source', 'pH', 'Turbidity_NTU', 'TDS_ppm', 'Temp_C', 'DO_mgL', 'WaterLevel_pct', 'WQI', 'WQI_Status'];
    const rows = this.historyRecords.map(r => [
      `"${r.timestamp}"`,
      `"${r.deviceId || r.stationId}"`,
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
    link.download = `water_quality_${this.selectedDeviceId}_${Date.now()}.csv`;
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
    link.download = `water_quality_${this.selectedDeviceId}_${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  // =========================================================================
  // FIRMWARE & SETTINGS MODALS
  // =========================================================================
  initFirmwareGeneratorView() {
    this.updateFirmwareCodePreview();
  }

  updateFirmwareCodePreview() {
    const config = {
      boardType: document.getElementById('fwBoardType')?.value || 'esp32',
      ssid: document.getElementById('fwSsid')?.value || 'YOUR_WIFI_SSID',
      password: document.getElementById('fwPassword')?.value || 'YOUR_WIFI_PASSWORD',
      stationId: document.getElementById('fwStationId')?.value || 'AUTO_MAC',
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

    // Test MQTT packet button
    document.getElementById('btnTestMqtt')?.addEventListener('click', () => {
      if (!this.mqtt.isConnected) {
        this.connectMQTT();
      }
      setTimeout(() => {
        this.mqtt.sendTestPacket();
      }, 500);
    });

    // Device Selector change
    document.getElementById('deviceSelector')?.addEventListener('change', (e) => {
      this.selectedDeviceId = e.target.value;
      const stationElem = document.getElementById('currentStationDisplay');
      if (stationElem) stationElem.textContent = this.selectedDeviceId === 'auto' ? 'Auto-Detect' : this.selectedDeviceId;
    });

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
    ['fwBoardType', 'fwSsid', 'fwPassword', 'fwStationId', 'fwBroker', 'fwPinPH', 'fwPinTurb', 'fwPinTDS', 'fwPinTemp'].forEach(id => {
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
      FirmwareGenerator.downloadSketch(code, `WaterQuality_ESP32.ino`);
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

window.addEventListener('DOMContentLoaded', () => {
  const app = new WaterQualityApp();
  app.init();
  window.WaterQualityApp = app;
});
