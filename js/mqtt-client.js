/**
 * Cloud MQTT WebSocket Client with Auto-Discovery & Redundant Broker Failover
 * Connects over Secure WebSockets (WSS) to EMQX / HiveMQ public brokers.
 */

import { PayloadAdapter } from './payload-adapter.js';

const BROKER_FAILOVERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt'
];

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
    this.brokerIndex = 0;
    this.packetCount = 0;
    this.discoveredDevices = new Map();
    this.connectTimeoutTimer = null;
  }

  connect(brokerUrl, stationId = '') {
    if (this.client) {
      try {
        this.client.end(true);
      } catch (e) {}
    }

    this.brokerUrl = brokerUrl.trim() || BROKER_FAILOVERS[0];
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
      this.onStatusChangeCallback(false, `Connecting to Cloud Broker...`);
    }
    if (this.onRawLogCallback) {
      this.onRawLogCallback('SYSTEM', `Initiating WSS connection to ${this.brokerUrl}`);
    }

    const clientId = 'web_wqm_' + Math.random().toString(16).substring(2, 10);

    const options = {
      clientId: clientId,
      clean: true,
      connectTimeout: 8000,
      reconnectPeriod: 5000,
      keepalive: 30
    };

    try {
      this.client = mqtt.connect(this.brokerUrl, options);

      // Failover timer: if not connected within 8 seconds, attempt next broker in list
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = setTimeout(() => {
        if (!this.isConnected) {
          console.warn(`Connection to ${this.brokerUrl} timed out. Trying alternative broker...`);
          this.tryNextBroker();
        }
      }, 8500);

      this.client.on('connect', () => {
        clearTimeout(this.connectTimeoutTimer);
        this.isConnected = true;

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
              this.onStatusChangeCallback(true, `Cloud Live: Connected (${new URL(this.brokerUrl).hostname})`);
            }
            if (this.onRawLogCallback) {
              this.onRawLogCallback('SYSTEM', `Connected to broker! Listening for all ESP32 nodes...`);
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

        const parts = topic.split('/');
        let topicDeviceId = '';
        if (parts.length >= 2 && parts[0] === 'water-quality') {
          topicDeviceId = parts[1];
        }

        const packet = PayloadAdapter.normalize(msgStr, 'cloud-mqtt', topicDeviceId);
        if (!packet) return;

        this.registerDevice(packet.deviceId, packet.rssi);

        if (this.onDataCallback) {
          this.onDataCallback(packet);
        }
      });

      this.client.on('error', (err) => {
        console.warn('MQTT Connection error:', err);
        if (!this.isConnected) {
          this.tryNextBroker();
        }
      });

      this.client.on('offline', () => {
        this.isConnected = false;
        if (this.onStatusChangeCallback) {
          this.onStatusChangeCallback(false, 'Broker Reconnecting...');
        }
      });

      this.client.on('close', () => {
        this.isConnected = false;
      });

    } catch (err) {
      console.error('MQTT setup exception', err);
      this.tryNextBroker();
    }
  }

  tryNextBroker() {
    this.brokerIndex = (this.brokerIndex + 1) % BROKER_FAILOVERS.length;
    const nextUrl = BROKER_FAILOVERS[this.brokerIndex];
    if (nextUrl !== this.brokerUrl) {
      console.log(`Failing over to alternative broker: ${nextUrl}`);
      if (this.onRawLogCallback) {
        this.onRawLogCallback('SYSTEM', `Failing over to ${nextUrl}...`);
      }
      this.connect(nextUrl, this.stationId);
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

  /**
   * Publishes a synthetic test packet from the browser to test end-to-end MQTT communication
   */
  sendTestPacket() {
    if (!this.client || !this.isConnected) return false;
    const testId = 'ESP32_TestNode';
    const topic = `water-quality/${testId}/telemetry`;
    const payload = JSON.stringify({
      deviceId: testId,
      ph: 7.25,
      turbidity: 1.45,
      tds: 195,
      temp: 24.2,
      dissolvedOxygen: 7.9,
      waterLevel: 88,
      rssi: -50
    });
    this.client.publish(topic, payload);
    return true;
  }

  publishControl(targetDeviceId, command, payload = {}) {
    if (!this.client || !this.isConnected) return false;
    const topic = `water-quality/${targetDeviceId}/control`;
    const message = JSON.stringify({ command, ...payload, timestamp: Date.now() });
    this.client.publish(topic, message);
    return true;
  }

  disconnect() {
    clearTimeout(this.connectTimeoutTimer);
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
