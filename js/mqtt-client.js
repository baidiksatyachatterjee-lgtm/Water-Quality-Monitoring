/**
 * Cloud MQTT WebSocket Client with Auto-Discovery
 * Real-time cloud communication using MQTT over Secure WebSockets (WSS)
 * Subscribes to wildcard topics to discover and receive data from ANY ESP32.
 */

import { PayloadAdapter } from './payload-adapter.js';

export class MqttClient {
  constructor(onDataCallback, onStatusChangeCallback, onRawLogCallback, onDeviceDiscoveredCallback) {
    this.onDataCallback = onDataCallback;
    this.onStatusChangeCallback = onStatusChangeCallback;
    this.onRawLogCallback = onRawLogCallback;
    this.onDeviceDiscoveredCallback = onDeviceDiscoveredCallback;
    this.client = null;
    this.isConnected = false;
    this.stationId = '';
    this.brokerUrl = '';
    this.packetCount = 0;
    this.discoveredDevices = new Map();
  }

  connect(brokerUrl, stationId = '') {
    if (this.client) {
      try {
        this.client.end(true);
      } catch (e) {}
    }

    this.brokerUrl = brokerUrl.trim();
    this.stationId = stationId.trim();
    this.packetCount = 0;

    if (typeof mqtt === 'undefined') {
      console.error('MQTT.js library not loaded');
      if (this.onStatusChangeCallback) {
        this.onStatusChangeCallback(false, 'MQTT Library Missing');
      }
      return;
    }

    if (this.onStatusChangeCallback) {
      this.onStatusChangeCallback(false, 'Connecting to Cloud Broker...');
    }

    const clientId = 'web-client-' + Math.random().toString(16).substring(2, 10);

    const options = {
      clientId: clientId,
      clean: true,
      connectTimeout: 7000,
      reconnectPeriod: 4000
    };

    try {
      this.client = mqtt.connect(this.brokerUrl, options);

      this.client.on('connect', () => {
        this.isConnected = true;

        // Subscribe to Wildcard Topics to automatically discover ANY ESP32
        const topics = [
          'water-quality/+/telemetry',
          'water-quality/+/data',
          'water-quality/#'
        ];

        if (this.stationId) {
          topics.push(`water-quality/${this.stationId}/telemetry`);
        }

        this.client.subscribe(topics, (err) => {
          if (!err) {
            if (this.onStatusChangeCallback) {
              this.onStatusChangeCallback(true, `Connected to Cloud Broker (Auto-Discovery Active)`);
            }
            if (this.onRawLogCallback) {
              this.onRawLogCallback('SYSTEM', `Listening on wildcard topics: ${topics.join(', ')}`);
            }
          } else {
            console.error('Subscription error', err);
          }
        });
      });

      this.client.on('message', (topic, message) => {
        this.packetCount++;
        const msgStr = message.toString();

        if (this.onRawLogCallback) {
          this.onRawLogCallback('MQTT', `[${topic}] ${msgStr}`);
        }

        // Extract potential device ID from MQTT topic (e.g. water-quality/<DEVICE_ID>/telemetry)
        const parts = topic.split('/');
        let topicDeviceId = '';
        if (parts.length >= 2 && parts[0] === 'water-quality') {
          topicDeviceId = parts[1];
        }

        // Normalize using universal adapter
        const packet = PayloadAdapter.normalize(msgStr, 'cloud-mqtt', topicDeviceId);
        if (!packet) return;

        // Register device in discovered list
        this.registerDevice(packet.deviceId, packet.rssi);

        // Emit normalized telemetry packet
        if (this.onDataCallback) {
          this.onDataCallback(packet);
        }
      });

      this.client.on('error', (err) => {
        console.warn('MQTT Connection error:', err);
        if (this.onStatusChangeCallback) {
          this.onStatusChangeCallback(false, 'Connection Error');
        }
      });

      this.client.on('offline', () => {
        this.isConnected = false;
        if (this.onStatusChangeCallback) {
          this.onStatusChangeCallback(false, 'Broker Offline / Reconnecting...');
        }
      });

      this.client.on('close', () => {
        this.isConnected = false;
      });

    } catch (err) {
      console.error('MQTT setup exception', err);
      if (this.onStatusChangeCallback) {
        this.onStatusChangeCallback(false, err.message);
      }
    }
  }

  registerDevice(deviceId, rssi) {
    const isNew = !this.discoveredDevices.has(deviceId);
    const info = {
      id: deviceId,
      lastSeen: Date.now(),
      rssi: rssi || -60,
      packetCount: (this.discoveredDevices.get(deviceId)?.packetCount || 0) + 1
    };

    this.discoveredDevices.set(deviceId, info);

    if (this.onDeviceDiscoveredCallback) {
      this.onDeviceDiscoveredCallback(info, isNew, Array.from(this.discoveredDevices.values()));
    }
  }

  publishControl(targetDeviceId, command, payload = {}) {
    if (!this.client || !this.isConnected) return false;
    const topic = `water-quality/${targetDeviceId}/control`;
    const message = JSON.stringify({ command, ...payload, timestamp: Date.now() });
    this.client.publish(topic, message);
    return true;
  }

  disconnect() {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
    this.isConnected = false;
    if (this.onStatusChangeCallback) {
      this.onStatusChangeCallback(false, 'MQTT Disconnected');
    }
  }
}
