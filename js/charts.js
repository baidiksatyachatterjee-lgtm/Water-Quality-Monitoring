/**
 * Live Chart Manager
 * Renders high-performance, neon-gradient streaming charts using Chart.js
 */

export class ChartManager {
  constructor(canvasId) {
    this.canvasId = canvasId;
    this.chart = null;
    this.activeDatasetKey = 'all'; // 'all' | 'ph' | 'turbidity' | 'tds' | 'temp'
    this.timeframeWindow = 60; // default to last 60 records
    this.dataBuffer = {
      labels: [],
      ph: [],
      turbidity: [],
      tds: [],
      temp: [],
      dissolvedOxygen: []
    };
    this.initChart();
  }

  initChart() {
    const canvas = document.getElementById(this.canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    // Gradient definitions
    const gradientCyan = ctx.createLinearGradient(0, 0, 0, 320);
    gradientCyan.addColorStop(0, 'rgba(0, 242, 254, 0.25)');
    gradientCyan.addColorStop(1, 'rgba(0, 242, 254, 0.00)');

    const gradientAmber = ctx.createLinearGradient(0, 0, 0, 320);
    gradientAmber.addColorStop(0, 'rgba(245, 158, 11, 0.25)');
    gradientAmber.addColorStop(1, 'rgba(245, 158, 11, 0.00)');

    const gradientEmerald = ctx.createLinearGradient(0, 0, 0, 320);
    gradientEmerald.addColorStop(0, 'rgba(16, 185, 129, 0.25)');
    gradientEmerald.addColorStop(1, 'rgba(16, 185, 129, 0.00)');

    const gradientRose = ctx.createLinearGradient(0, 0, 0, 320);
    gradientRose.addColorStop(0, 'rgba(244, 63, 94, 0.25)');
    gradientRose.addColorStop(1, 'rgba(244, 63, 94, 0.00)');

    this.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'pH Level',
            key: 'ph',
            borderColor: '#00f2fe',
            backgroundColor: gradientCyan,
            borderWidth: 2.5,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointBackgroundColor: '#00f2fe',
            pointBorderColor: '#060b14',
            pointBorderWidth: 2,
            tension: 0.35,
            fill: true,
            yAxisID: 'yPH',
            data: []
          },
          {
            label: 'Turbidity (NTU)',
            key: 'turbidity',
            borderColor: '#f59e0b',
            backgroundColor: gradientAmber,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointBackgroundColor: '#f59e0b',
            pointBorderColor: '#060b14',
            pointBorderWidth: 2,
            tension: 0.35,
            fill: true,
            yAxisID: 'yTurbidity',
            data: []
          },
          {
            label: 'TDS (ppm)',
            key: 'tds',
            borderColor: '#10b981',
            backgroundColor: gradientEmerald,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointBackgroundColor: '#10b981',
            pointBorderColor: '#060b14',
            pointBorderWidth: 2,
            tension: 0.35,
            fill: true,
            yAxisID: 'yTDS',
            data: []
          },
          {
            label: 'Temperature (°C)',
            key: 'temp',
            borderColor: '#f43f5e',
            backgroundColor: gradientRose,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointBackgroundColor: '#f43f5e',
            pointBorderColor: '#060b14',
            pointBorderWidth: 2,
            tension: 0.35,
            fill: true,
            yAxisID: 'yTemp',
            data: []
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 300,
          easing: 'linear'
        },
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            backgroundColor: 'rgba(13, 24, 44, 0.95)',
            titleColor: '#f8fafc',
            bodyColor: '#94a3b8',
            borderColor: 'rgba(56, 189, 248, 0.25)',
            borderWidth: 1,
            padding: 12,
            boxPadding: 6,
            cornerRadius: 10,
            usePointStyle: true,
            titleFont: { family: 'Outfit', size: 13, weight: 'bold' },
            bodyFont: { family: 'JetBrains Mono', size: 12 }
          }
        },
        scales: {
          x: {
            grid: {
              color: 'rgba(255, 255, 255, 0.04)',
              drawBorder: false
            },
            ticks: {
              color: '#64748b',
              font: { family: 'JetBrains Mono', size: 11 },
              maxTicksLimit: 8
            }
          },
          yPH: {
            type: 'linear',
            position: 'left',
            min: 0,
            max: 14,
            grid: {
              color: 'rgba(56, 189, 248, 0.08)',
              drawBorder: false
            },
            ticks: {
              color: '#00f2fe',
              font: { family: 'JetBrains Mono', size: 11 }
            },
            title: {
              display: true,
              text: 'pH',
              color: '#00f2fe',
              font: { family: 'Outfit', size: 11, weight: '600' }
            }
          },
          yTurbidity: {
            type: 'linear',
            position: 'right',
            grid: { drawOnChartArea: false },
            ticks: {
              color: '#f59e0b',
              font: { family: 'JetBrains Mono', size: 11 }
            },
            title: {
              display: false
            }
          },
          yTDS: {
            type: 'linear',
            position: 'right',
            grid: { drawOnChartArea: false },
            ticks: { display: false }
          },
          yTemp: {
            type: 'linear',
            position: 'right',
            grid: { drawOnChartArea: false },
            ticks: { display: false }
          }
        }
      }
    });
  }

  addDataPoint(timestamp, metrics) {
    if (!this.chart) return;

    this.dataBuffer.labels.push(timestamp);
    this.dataBuffer.ph.push(metrics.ph);
    this.dataBuffer.turbidity.push(metrics.turbidity);
    this.dataBuffer.tds.push(metrics.tds);
    this.dataBuffer.temp.push(metrics.temp);
    this.dataBuffer.dissolvedOxygen.push(metrics.dissolvedOxygen);

    // Keep max 500 historical points in buffer
    if (this.dataBuffer.labels.length > 500) {
      this.dataBuffer.labels.shift();
      this.dataBuffer.ph.shift();
      this.dataBuffer.turbidity.shift();
      this.dataBuffer.tds.shift();
      this.dataBuffer.temp.shift();
      this.dataBuffer.dissolvedOxygen.shift();
    }

    this.renderWindow();
  }

  renderWindow() {
    if (!this.chart) return;

    const count = this.timeframeWindow;
    const labelsSlice = this.dataBuffer.labels.slice(-count);

    this.chart.data.labels = labelsSlice;
    this.chart.data.datasets[0].data = this.dataBuffer.ph.slice(-count);
    this.chart.data.datasets[1].data = this.dataBuffer.turbidity.slice(-count);
    this.chart.data.datasets[2].data = this.dataBuffer.tds.slice(-count);
    this.chart.data.datasets[3].data = this.dataBuffer.temp.slice(-count);

    this.chart.update('none'); // Update without full redraw animation for smoothness
  }

  setDatasetFilter(key) {
    this.activeDatasetKey = key;
    if (!this.chart) return;

    this.chart.data.datasets.forEach((ds) => {
      if (key === 'all') {
        ds.hidden = false;
      } else {
        ds.hidden = ds.key !== key;
      }
    });

    this.chart.update();
  }

  setTimeframe(secondsOrCount) {
    this.timeframeWindow = secondsOrCount;
    this.renderWindow();
  }

  clearData() {
    this.dataBuffer = {
      labels: [],
      ph: [],
      turbidity: [],
      tds: [],
      temp: [],
      dissolvedOxygen: []
    };
    if (this.chart) {
      this.chart.data.labels = [];
      this.chart.data.datasets.forEach(ds => ds.data = []);
      this.chart.update();
    }
  }
}
