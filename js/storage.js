/**
 * Storage & Configuration Manager
 * Handles local persistence of station configuration, thresholds, and presets
 */

const STORAGE_KEYS = {
  STATION_ID: 'wqm_station_id',
  MQTT_BROKER: 'wqm_mqtt_broker',
  THRESHOLDS: 'wqm_thresholds',
  CURRENT_PRESET: 'wqm_preset',
  ALERT_SOUND: 'wqm_alert_sound',
  SIMULATION_AUTO: 'wqm_simulation_auto'
};

// Preset Standards
export const WATER_PRESETS = {
  drinking: {
    name: 'Drinking Water (WHO / EPA)',
    thresholds: {
      ph: { min: 6.5, max: 8.5, unit: 'pH' },
      turbidity: { min: 0, max: 5.0, unit: 'NTU' },
      tds: { min: 50, max: 300, unit: 'ppm' },
      temp: { min: 10, max: 25, unit: '°C' },
      dissolvedOxygen: { min: 6.5, max: 14, unit: 'mg/L' },
      waterLevel: { min: 20, max: 100, unit: '%' }
    }
  },
  aquaculture: {
    name: 'Aquaculture / Freshwater Fish Pond',
    thresholds: {
      ph: { min: 6.8, max: 8.2, unit: 'pH' },
      turbidity: { min: 5, max: 30, unit: 'NTU' },
      tds: { min: 150, max: 600, unit: 'ppm' },
      temp: { min: 20, max: 30, unit: '°C' },
      dissolvedOxygen: { min: 5.0, max: 12, unit: 'mg/L' },
      waterLevel: { min: 40, max: 95, unit: '%' }
    }
  },
  swimming: {
    name: 'Swimming Pool Sanitation',
    thresholds: {
      ph: { min: 7.2, max: 7.8, unit: 'pH' },
      turbidity: { min: 0, max: 1.0, unit: 'NTU' },
      tds: { min: 300, max: 1500, unit: 'ppm' },
      temp: { min: 24, max: 30, unit: '°C' },
      dissolvedOxygen: { min: 4.0, max: 10, unit: 'mg/L' },
      waterLevel: { min: 50, max: 90, unit: '%' }
    }
  },
  environmental: {
    name: 'River / Lake Environmental Monitoring',
    thresholds: {
      ph: { min: 6.0, max: 9.0, unit: 'pH' },
      turbidity: { min: 0, max: 50.0, unit: 'NTU' },
      tds: { min: 50, max: 1000, unit: 'ppm' },
      temp: { min: 5, max: 32, unit: '°C' },
      dissolvedOxygen: { min: 4.0, max: 14, unit: 'mg/L' },
      waterLevel: { min: 10, max: 100, unit: '%' }
    }
  }
};

export class StorageManager {
  constructor() {
    this.initDefaults();
  }

  initDefaults() {
    if (!this.getStationId()) {
      const randId = 'ESP32_' + Math.random().toString(36).substring(2, 6).toUpperCase();
      this.setStationId(randId);
    }
    // High-reliability public EMQX broker with WSS port 8084
    const currentBroker = localStorage.getItem(STORAGE_KEYS.MQTT_BROKER);
    if (!currentBroker || currentBroker.includes('hivemq')) {
      this.setBrokerUrl('wss://broker.emqx.io:8084/mqtt');
    }
    if (!this.getThresholds()) {
      this.setPreset('drinking');
    }
  }

  getStationId() {
    return localStorage.getItem(STORAGE_KEYS.STATION_ID) || '';
  }

  setStationId(id) {
    const cleanId = id.trim().replace(/[^a-zA-Z0-9-_]/g, '');
    localStorage.setItem(STORAGE_KEYS.STATION_ID, cleanId);
    return cleanId;
  }

  getBrokerUrl() {
    return localStorage.getItem(STORAGE_KEYS.MQTT_BROKER) || 'wss://broker.emqx.io:8084/mqtt';
  }

  setBrokerUrl(url) {
    localStorage.setItem(STORAGE_KEYS.MQTT_BROKER, url.trim());
  }

  getThresholds() {
    const raw = localStorage.getItem(STORAGE_KEYS.THRESHOLDS);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch (e) {
        console.error('Failed to parse thresholds from localStorage', e);
      }
    }
    return WATER_PRESETS.drinking.thresholds;
  }

  setThresholds(thresholds) {
    localStorage.setItem(STORAGE_KEYS.THRESHOLDS, JSON.stringify(thresholds));
  }

  getCurrentPreset() {
    return localStorage.getItem(STORAGE_KEYS.CURRENT_PRESET) || 'drinking';
  }

  setPreset(presetKey) {
    if (WATER_PRESETS[presetKey]) {
      localStorage.setItem(STORAGE_KEYS.CURRENT_PRESET, presetKey);
      this.setThresholds(WATER_PRESETS[presetKey].thresholds);
      return true;
    }
    return false;
  }

  isSoundEnabled() {
    return localStorage.getItem(STORAGE_KEYS.ALERT_SOUND) !== 'false';
  }

  setSoundEnabled(enabled) {
    localStorage.setItem(STORAGE_KEYS.ALERT_SOUND, enabled ? 'true' : 'false');
  }
}
