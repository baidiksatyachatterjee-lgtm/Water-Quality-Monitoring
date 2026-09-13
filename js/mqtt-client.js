/**
 * Cloud MQTT WebSocket Client
 * Real-time cloud communication using MQTT over Secure WebSockets (WSS)
 */

export class MqttClient {
  constructor(onDataCallback, onStatusChangeCallback, onRawLogCallback) {
    this.onDataCallback = onDataCallback;
    this.onStatusChangeCallback = onStatusChangeCallback;
    this.onRawLogCallback = onRawLogCallback;
    this.client = null;
    this.isConnected = false;
    this.stationId = '';
    this.brokerUrl = '';
    this.packetCount = 0;
  }

  connect(brokerUrl, stationId) {
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
        const telemetryTopic = `water-quality/${this.stationId}/telemetry`;

        this.client.subscribe(telemetryTopic, (err) => {
          if (!err) {
            if (this.onStatusChangeCallback) {
              this.onStatusChangeCallback(true, `Connected to Cloud MQTT (Station: ${this.stationId})`);
            }
            if (this.onRawLogCallback) {
              this.onRawLogCallback('SYSTEM', `Subscribed to topic: ${telemetryTopic}`);
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
          this.onRawLogCallback('MQTT', msgStr);
        }

        try {
          const parsed = JSON.parse(msgStr);
          this.emitParsed(parsed);
        } catch (e) {
          console.warn('Non-JSON MQTT packet received:', msgStr);
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

  emitParsed(data) {
    const packet = {
      ph: data.ph !== undefined ? Number(data.ph) : 7.0,
      turbidity: data.turbidity !== undefined ? Number(data.turbidity) : 1.0,
      tds: data.tds !== undefined ? Number(data.tds) : 200,
      temp: data.temp !== undefined ? Number(data.temp) : 24.0,
      dissolvedOxygen: data.dissolvedOxygen !== undefined ? Number(data.dissolvedOxygen) : 7.5,
      waterLevel: data.waterLevel !== undefined ? Number(data.waterLevel) : 80,
      rssi: data.rssi || -60,
      source: 'cloud-mqtt',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    };

    if (this.onDataCallback) {
      this.onDataCallback(packet);
    }
  }

  publishControl(command, payload = {}) {
    if (!this.client || !this.isConnected) return false;
    const topic = `water-quality/${this.stationId}/control`;
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
