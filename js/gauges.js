/**
 * Gauges & Visual Indicators Manager
 * Handles animated SVG circular WQI meter and progress bar fills
 */

export class GaugeManager {
  constructor() {
    this.wqiCircle = document.getElementById('wqiCircleProgress');
    this.wqiNumber = document.getElementById('wqiNumber');
    this.wqiBadge = document.getElementById('wqiStatusBadge');
    this.wqiDesc = document.getElementById('wqiDescription');
    this.CIRCUMFERENCE = 408.4; // 2 * Math.PI * 65
  }

  /**
   * Update the Water Quality Index (WQI) Display
   * @param {number} score 0 to 100
   * @param {string} status 'excellent' | 'good' | 'moderate' | 'poor' | 'unsafe'
   * @param {string} description Explanatory health / safety text
   */
  updateWQI(score, status, description) {
    if (!this.wqiCircle || !this.wqiNumber) return;

    const clampedScore = Math.max(0, Math.min(100, Math.round(score)));
    const offset = this.CIRCUMFERENCE * (1 - clampedScore / 100);

    this.wqiCircle.style.strokeDashoffset = offset;
    this.wqiNumber.textContent = clampedScore;

    // Determine color
    let strokeColor = '#00f2fe';
    if (clampedScore >= 90) {
      strokeColor = '#10b981'; // emerald
    } else if (clampedScore >= 75) {
      strokeColor = '#38bdf8'; // sky cyan
    } else if (clampedScore >= 55) {
      strokeColor = '#fbbf24'; // amber
    } else if (clampedScore >= 35) {
      strokeColor = '#fb923c'; // orange
    } else {
      strokeColor = '#f43f5e'; // rose red
    }

    this.wqiCircle.style.stroke = strokeColor;

    if (this.wqiBadge) {
      this.wqiBadge.className = `wqi-status-badge ${status.toLowerCase()}`;
      this.wqiBadge.textContent = status.toUpperCase();
    }

    if (this.wqiDesc && description) {
      this.wqiDesc.textContent = description;
    }
  }

  /**
   * Update a Sensor Card's value, range bar, and status badge
   * @param {string} sensorKey 'ph' | 'turbidity' | 'tds' | 'temp' | 'dissolvedOxygen' | 'waterLevel'
   * @param {number} value
   * @param {object} threshold { min, max, unit }
   * @param {string} status 'safe' | 'warning' | 'danger'
   */
  updateSensorCard(sensorKey, value, threshold, status) {
    const valElem = document.getElementById(`val-${sensorKey}`);
    const badgeElem = document.getElementById(`badge-${sensorKey}`);
    const barElem = document.getElementById(`bar-${sensorKey}`);

    if (valElem) {
      valElem.textContent = typeof value === 'number' ? (Number.isInteger(value) ? value : value.toFixed(1)) : value;
    }

    if (badgeElem) {
      badgeElem.className = `sensor-badge ${status}`;
      badgeElem.textContent = status.toUpperCase();
    }

    if (barElem && threshold) {
      // Calculate fill % relative to an extended visual range
      const spanMin = threshold.min * 0.7;
      const spanMax = threshold.max * 1.3;
      const totalSpan = Math.max(1, spanMax - spanMin);
      const percent = Math.max(0, Math.min(100, ((value - spanMin) / totalSpan) * 100));
      
      barElem.style.width = `${percent}%`;

      if (status === 'safe') {
        barElem.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
      } else if (status === 'warning') {
        barElem.style.background = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
      } else {
        barElem.style.background = 'linear-gradient(135deg, #f43f5e 0%, #e11d48 100%)';
      }
    }
  }

  /**
   * Draws a mini sparkline trend on a canvas
   */
  drawSparkline(canvasId, historyArray, color = '#00f2fe') {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !historyArray || historyArray.length < 2) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    const min = Math.min(...historyArray);
    const max = Math.max(...historyArray);
    const range = max - min === 0 ? 1 : max - min;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';

    const step = width / (historyArray.length - 1);

    for (let i = 0; i < historyArray.length; i++) {
      const x = i * step;
      const y = height - ((historyArray[i] - min) / range) * (height - 6) - 3;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
  }
}
