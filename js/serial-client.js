/**
 * Web Serial Client
 * Direct USB connection to ESP32 using the browser's Web Serial API
 */

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
  }

  isSupported() {
    return 'serial' in navigator;
  }

  async connect(baudRate = 115200) {
    if (!this.isSupported()) {
      alert('Web Serial API is not supported in this browser. Please use Google Chrome, Microsoft Edge, or Opera.');
      return false;
    }

    try {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate });

      this.isConnected = true;
      if (this.onStatusChangeCallback) {
        this.onStatusChangeCallback(true, 'Connected (USB Serial @ 115200 baud)');
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
    // Keep incomplete last chunk in buffer
    this.lineBuffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (this.onRawLogCallback) {
        this.onRawLogCallback('SERIAL', trimmed);
      }

      this.parseLine(trimmed);
    }
  }

  parseLine(text) {
    // Attempt 1: JSON payload
    if (text.startsWith('{') && text.endsWith('}')) {
      try {
        const data = JSON.parse(text);
        this.emitParsed(data);
        return;
      } catch (e) {
        // Fall through to CSV
      }
    }

    // Attempt 2: Key-value pairs (e.g. "pH: 7.2 | Temp: 24.5 | Turbidity: 2.1")
    if (text.includes(':') || text.includes('=')) {
      const data = {};
      const pairs = text.split(/[,;|]/);
      for (const pair of pairs) {
        const [k, v] = pair.split(/[:=]/).map(s => s.trim().toLowerCase());
        const num = parseFloat(v);
        if (!isNaN(num)) {
          if (k.includes('ph')) data.ph = num;
          else if (k.includes('turb')) data.turbidity = num;
          else if (k.includes('tds')) data.tds = num;
          else if (k.includes('temp')) data.temp = num;
          else if (k.includes('do') || k.includes('oxy')) data.dissolvedOxygen = num;
          else if (k.includes('level')) data.waterLevel = num;
        }
      }
      if (Object.keys(data).length > 0) {
        this.emitParsed(data);
        return;
      }
    }

    // Attempt 3: Comma separated numbers (ph, turbidity, tds, temp)
    const nums = text.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
    if (nums.length >= 3) {
      const data = {
        ph: nums[0],
        turbidity: nums[1],
        tds: nums[2],
        temp: nums[3] !== undefined ? nums[3] : 24.0,
        dissolvedOxygen: nums[4] !== undefined ? nums[4] : 7.5,
        waterLevel: nums[5] !== undefined ? nums[5] : 80
      };
      this.emitParsed(data);
    }
  }

  emitParsed(obj) {
    const packet = {
      ph: obj.ph !== undefined ? Number(obj.ph) : 7.0,
      turbidity: obj.turbidity !== undefined ? Number(obj.turbidity) : 1.0,
      tds: obj.tds !== undefined ? Number(obj.tds) : 200,
      temp: obj.temp !== undefined ? Number(obj.temp) : 24.0,
      dissolvedOxygen: obj.dissolvedOxygen !== undefined ? Number(obj.dissolvedOxygen) : 7.5,
      waterLevel: obj.waterLevel !== undefined ? Number(obj.waterLevel) : 80,
      rssi: obj.rssi || 0,
      source: 'usb-serial',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    };

    if (this.onDataCallback) {
      this.onDataCallback(packet);
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
