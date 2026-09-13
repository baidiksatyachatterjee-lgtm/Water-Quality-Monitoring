/**
 * Universal Web Serial Client
 * Direct USB connection to ANY ESP32 using the browser's Web Serial API
 * Supports configurable baud rates and universal payload parsing.
 */

import { PayloadAdapter } from './payload-adapter.js';

export class SerialClient {
  constructor(onDataCallback, onStatusChangeCallback, onRawLogCallback) {
    this.onDataCallback = onDataCallback;
    this.onStatusChangeCallback = onStatusChangeCallback;
    this.onRawLogCallback = onRawLogCallback;
    this.port = null;
    this.reader = null;
    this.readableStreamClosed = null;
    this.isConnected = false;
    this.lineBuffer = '';
    this.currentBaudRate = 115200;
  }

  isSupported() {
    return 'serial' in navigator;
  }

  async connect(baudRate = 115200) {
    if (!this.isSupported()) {
      alert('Web Serial API is not supported in this browser. Please use Google Chrome, Microsoft Edge, or Opera.');
      return false;
    }

    this.currentBaudRate = parseInt(baudRate) || 115200;

    try {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: this.currentBaudRate });

      this.isConnected = true;
      if (this.onStatusChangeCallback) {
        this.onStatusChangeCallback(true, `Connected (USB Serial @ ${this.currentBaudRate} baud)`);
      }

      this.readLoop();
      return true;
    } catch (err) {
      console.warn('Serial connection cancelled or failed', err);
      this.isConnected = false;
      if (this.onStatusChangeCallback) {
        this.onStatusChangeCallback(false, err.message);
      }
      return false;
    }
  }

  async readLoop() {
    const textDecoder = new TextDecoderStream();
    this.readableStreamClosed = this.port.readable.pipeTo(textDecoder.writable);
    this.reader = textDecoder.readable.getReader();

    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          this.processChunk(value);
        }
      }
    } catch (err) {
      console.error('Serial read error:', err);
    } finally {
      this.reader.releaseLock();
    }
  }

  processChunk(chunk) {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (this.onRawLogCallback) {
        this.onRawLogCallback('SERIAL', trimmed);
      }

      // Universal normalization for ANY ESP32 serial format
      const packet = PayloadAdapter.normalize(trimmed, 'usb-serial', 'ESP32_USB');
      if (packet && this.onDataCallback) {
        this.onDataCallback(packet);
      }
    }
  }

  async disconnect() {
    if (!this.port) return;
    try {
      if (this.reader) {
        await this.reader.cancel();
        await this.readableStreamClosed.catch(() => {});
      }
      await this.port.close();
      this.port = null;
      this.isConnected = false;
      if (this.onStatusChangeCallback) {
        this.onStatusChangeCallback(false, 'USB Serial Disconnected');
      }
    } catch (e) {
      console.warn('Error disconnecting serial port', e);
    }
  }
}
