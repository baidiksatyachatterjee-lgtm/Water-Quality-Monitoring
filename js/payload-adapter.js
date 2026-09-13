/**
 * Universal Payload Adapter
 * Normalizes telemetry from ANY ESP32 regardless of JSON property names or formatting.
 */

export class PayloadAdapter {
  /**
   * Parse and normalize input data (string or object)
   * @param {string|object} rawInput
   * @param {string} fallbackSource
   * @param {string} fallbackDeviceId
   */
  static normalize(rawInput, fallbackSource = 'esp32', fallbackDeviceId = '') {
    let parsedObj = null;

    if (typeof rawInput === 'object' && rawInput !== null) {
      parsedObj = rawInput;
    } else if (typeof rawInput === 'string') {
      const trimmed = rawInput.trim();

      // Case 1: Standard JSON
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          parsedObj = JSON.parse(trimmed);
        } catch (e) {
          parsedObj = null;
        }
      }

      // Case 2: Key-Value text (e.g. "pH: 7.2 | Temp: 24.5" or "ph=7.2,tds=210")
      if (!parsedObj && (trimmed.includes(':') || trimmed.includes('='))) {
        parsedObj = {};
        const pairs = trimmed.split(/[,;|]/);
        for (const pair of pairs) {
          const parts = pair.split(/[:=]/);
          if (parts.length === 2) {
            const k = parts[0].trim();
            const v = parseFloat(parts[1].trim());
            if (!isNaN(v)) parsedObj[k] = v;
            else parsedObj[k] = parts[1].trim();
          }
        }
      }

      // Case 3: Comma-separated values (pH, Turbidity, TDS, Temp, DO, Level)
      if (!parsedObj && trimmed.includes(',')) {
        const nums = trimmed.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
        if (nums.length >= 3) {
          parsedObj = {
            ph: nums[0],
            turbidity: nums[1],
            tds: nums[2],
            temp: nums[3] !== undefined ? nums[3] : 24.0,
            dissolvedOxygen: nums[4] !== undefined ? nums[4] : 7.5,
            waterLevel: nums[5] !== undefined ? nums[5] : 80
          };
        }
      }
    }

    if (!parsedObj) return null;

    // Normalization helper: find first matching key in object case-insensitively
    const findKey = (possibleNames) => {
      const lowerKeys = Object.keys(parsedObj).reduce((acc, k) => {
        acc[k.toLowerCase().replace(/[-_]/g, '')] = parsedObj[k];
        return acc;
      }, {});

      for (const name of possibleNames) {
        const cleaned = name.toLowerCase().replace(/[-_]/g, '');
        if (lowerKeys[cleaned] !== undefined) {
          return lowerKeys[cleaned];
        }
      }
      return undefined;
    };

    // Extract device ID
    const rawId = findKey(['stationId', 'station_id', 'deviceId', 'device_id', 'mac', 'id', 'name', 'node', 'client']);
    const deviceId = rawId ? String(rawId).trim() : (fallbackDeviceId || 'ESP32_Generic');

    // Extract and parse numeric metrics
    const parseNum = (val, defaultVal) => {
      if (val === undefined || val === null) return defaultVal;
      const num = parseFloat(val);
      return isNaN(num) ? defaultVal : num;
    };

    const phVal = parseNum(findKey(['ph', 'phValue', 'ph_val', 'phlevel', 'acidity']), 7.0);
    const turbVal = parseNum(findKey(['turbidity', 'turb', 'ntu', 'clarity', 'turb_val']), 1.0);
    const tdsVal = parseNum(findKey(['tds', 'ppm', 'ec', 'conductivity', 'tds_val', 'solids']), 200);
    const tempVal = parseNum(findKey(['temp', 'temperature', 'tempc', 'temp_c', 't', 'watertemp']), 24.0);
    const doVal = parseNum(findKey(['dissolvedOxygen', 'dissolved_oxygen', 'do', 'oxygen', 'do_mg_l', 'domgl']), 7.5);
    const levelVal = parseNum(findKey(['waterLevel', 'water_level', 'level', 'depth', 'distance', 'capacity']), 80);
    const rssiVal = parseNum(findKey(['rssi', 'signal', 'wifirssi', 'wifi']), -60);
    const batteryVal = parseNum(findKey(['battery', 'batt', 'vbatt', 'voltage']), null);

    return {
      deviceId: deviceId,
      stationId: deviceId, // compatibility alias
      ph: Number(phVal.toFixed(2)),
      turbidity: Number(turbVal.toFixed(2)),
      tds: Math.round(tdsVal),
      temp: Number(tempVal.toFixed(1)),
      dissolvedOxygen: Number(doVal.toFixed(2)),
      waterLevel: Math.round(levelVal),
      rssi: Math.round(rssiVal),
      battery: batteryVal !== null ? Number(batteryVal.toFixed(2)) : null,
      source: fallbackSource,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    };
  }
}
