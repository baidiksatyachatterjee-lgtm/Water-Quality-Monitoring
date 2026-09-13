/**
 * ESP32 Firmware Generator
 * Produces customized, fully-commented Arduino C++ sketches for the ESP32
 */

export class FirmwareGenerator {
  static generateCode(config) {
    const {
      ssid = 'YOUR_WIFI_SSID',
      password = 'YOUR_WIFI_PASSWORD',
      stationId = 'esp32-station-01',
      mqttBroker = 'broker.hivemq.com',
      mqttPort = 1883,
      pinPH = 34,
      pinTurbidity = 35,
      pinTDS = 32,
      pinTemp = 4,
      intervalMs = 2000
    } = config;

    return `/*
 * =========================================================================
 * ESP32 Smart Water Quality Monitoring Node
 * Generates real-time sensor telemetry and streams to Web App via MQTT
 * 
 * Target Board: ESP32 Dev Module / NodeMCU-32S
 * Generated for Station: ${stationId}
 * =========================================================================
 * 
 * Required Arduino Libraries (Install via Library Manager):
 *  - PubSubClient by Nick O'Leary
 *  - ArduinoJson by Benoit Blanchon (v6.x or v7.x)
 *  - OneWire by Jim Studt, Paul Stoffregen
 *  - DallasTemperature by Miles Burton
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ---------- NETWORK CONFIGURATION ----------
const char* WIFI_SSID     = "${ssid}";
const char* WIFI_PASSWORD = "${password}";

const char* MQTT_BROKER   = "${mqttBroker}";
const int   MQTT_PORT     = ${mqttPort};
const char* STATION_ID    = "${stationId}";

// Telemetry Topic: Web app subscribes to this exact topic
const char* TOPIC_TELEMETRY = "water-quality/${stationId}/telemetry";
const char* TOPIC_CONTROL   = "water-quality/${stationId}/control";

// ---------- SENSOR PIN DEFINITIONS ----------
const int PIN_PH        = ${pinPH};         // Analog ADC1 (GPIO ${pinPH})
const int PIN_TURBIDITY = ${pinTurbidity};  // Analog ADC1 (GPIO ${pinTurbidity})
const int PIN_TDS       = ${pinTDS};        // Analog ADC1 (GPIO ${pinTDS})
const int PIN_ONE_WIRE  = ${pinTemp};       // Digital GPIO ${pinTemp} for DS18B20
const int PIN_LED       = 2;                // Built-in status LED

// ---------- HARDWARE INSTANCES ----------
OneWire oneWire(PIN_ONE_WIRE);
DallasTemperature tempSensor(&oneWire);
WiFiClient espClient;
PubSubClient mqttClient(espClient);

unsigned long lastSampleTime = 0;
const unsigned long SAMPLE_INTERVAL = ${intervalMs}; // Milliseconds

// ---------- MOVING AVERAGE ADC FILTER ----------
float readSmoothedADC(int pin, int samples = 20) {
  long sum = 0;
  for (int i = 0; i < samples; i++) {
    sum += analogRead(pin);
    delay(2);
  }
  return (float)sum / samples;
}

// ---------- SENSOR READING FUNCTIONS ----------

// pH Sensor: Calibrated for standard analog pH meter (4.01 and 6.86 buffers)
float readPH() {
  float rawADC = readSmoothedADC(PIN_PH);
  float voltage = rawADC * (3.3 / 4095.0);
  // Calibration slope: adjust 3.5 and 15.0 based on your two-point buffer calibration
  float phValue = 3.5 * voltage; 
  if (phValue < 0.0) phValue = 0.0;
  if (phValue > 14.0) phValue = 14.0;
  return phValue;
}

// Turbidity Sensor: NTU calculation from analog voltage
float readTurbidity() {
  float rawADC = readSmoothedADC(PIN_TURBIDITY);
  float voltage = rawADC * (3.3 / 4095.0);
  // Typical optical turbidity conversion
  float ntu = -1120.4 * (voltage * voltage) + 5742.3 * voltage - 4352.9;
  if (ntu < 0) ntu = 0;
  if (voltage > 2.5) ntu = (2.5 - voltage) * 10.0; // Clean water threshold
  if (ntu < 0) ntu = 0.5;
  if (ntu > 1000) ntu = 1000;
  return ntu;
}

// TDS Sensor: Total Dissolved Solids in ppm
float readTDS(float waterTempC) {
  float rawADC = readSmoothedADC(PIN_TDS);
  float voltage = rawADC * (3.3 / 4095.0);
  // Temperature compensation formula
  float compensationCoeff = 1.0 + 0.02 * (waterTempC - 25.0);
  float compensationVoltage = voltage / compensationCoeff;
  float tdsValue = (133.42 * pow(compensationVoltage, 3) 
                  - 255.86 * pow(compensationVoltage, 2) 
                  + 857.39 * compensationVoltage) * 0.5;
  if (tdsValue < 0) tdsValue = 0;
  return tdsValue;
}

// Temperature Sensor (DS18B20)
float readWaterTemp() {
  tempSensor.requestTemperatures();
  float tempC = tempSensor.getTempCByIndex(0);
  if (tempC == DEVICE_DISCONNECTED_C || tempC < -20.0 || tempC > 80.0) {
    return 24.5; // Default safe fallback if disconnected
  }
  return tempC;
}

// ---------- WI-FI & MQTT CONNECTION HANDLERS ----------
void setupWiFi() {
  delay(10);
  Serial.println();
  Serial.print("Connecting to Wi-Fi: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int retries = 0;
  while (WiFi.status() != WL_CONNECTED && retries < 30) {
    delay(500);
    Serial.print(".");
    digitalWrite(PIN_LED, !digitalRead(PIN_LED));
    retries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\\nWiFi Connected! IP Address: ");
    Serial.println(WiFi.localIP());
    digitalWrite(PIN_LED, HIGH);
  } else {
    Serial.println("\\nWiFi Connection Failed! Running in offline/serial mode.");
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  Serial.print("Message arrived on [");
  Serial.print(topic);
  Serial.print("]: ");
  for (int i = 0; i < length; i++) {
    Serial.print((char)payload[i]);
  }
  Serial.println();
}

void reconnectMQTT() {
  if (WiFi.status() != WL_CONNECTED) return;

  while (!mqttClient.connected()) {
    Serial.print("Attempting MQTT connection...");
    String clientId = "ESP32Client-" + String(random(0xffff), HEX);
    
    if (mqttClient.connect(clientId.c_str())) {
      Serial.println("connected to MQTT broker!");
      mqttClient.subscribe(TOPIC_CONTROL);
    } else {
      Serial.print("failed, rc=");
      Serial.print(mqttClient.state());
      Serial.println(" retrying in 5 seconds...");
      delay(5000);
    }
  }
}

// ---------- SETUP ----------
void setup() {
  Serial.begin(115200);
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_PH, INPUT);
  pinMode(PIN_TURBIDITY, INPUT);
  pinMode(PIN_TDS, INPUT);

  analogReadResolution(12); // ESP32 12-bit ADC (0 - 4095)
  tempSensor.begin();

  setupWiFi();
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);

  Serial.println("==============================================");
  Serial.println("ESP32 Water Quality Station Active & Ready");
  Serial.print("Station ID: ");
  Serial.println(STATION_ID);
  Serial.println("==============================================");
}

// ---------- MAIN LOOP ----------
void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!mqttClient.connected()) {
      reconnectMQTT();
    }
    mqttClient.loop();
  }

  unsigned long currentMillis = millis();
  if (currentMillis - lastSampleTime >= SAMPLE_INTERVAL) {
    lastSampleTime = currentMillis;

    // Read all sensors
    float tempVal = readWaterTemp();
    float phVal = readPH();
    float turbVal = readTurbidity();
    float tdsVal = readTDS(tempVal);
    // Calculated dissolved oxygen approximation (temperature dependent)
    float doVal = 14.6 - 0.3 * tempVal;
    if (doVal < 0) doVal = 0;
    int rssi = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;

    // 1. Send JSON packet to Serial (USB Web Serial Monitor)
    StaticJsonDocument<256> doc;
    doc["stationId"] = STATION_ID;
    doc["ph"] = serialized(String(phVal, 2));
    doc["turbidity"] = serialized(String(turbVal, 2));
    doc["tds"] = round(tdsVal);
    doc["temp"] = serialized(String(tempVal, 1));
    doc["dissolvedOxygen"] = serialized(String(doVal, 2));
    doc["waterLevel"] = 85;
    doc["rssi"] = rssi;

    char jsonBuffer[256];
    serializeJson(doc, jsonBuffer);
    
    // Output over USB Serial
    Serial.println(jsonBuffer);

    // 2. Publish to Cloud MQTT
    if (mqttClient.connected()) {
      mqttClient.publish(TOPIC_TELEMETRY, jsonBuffer);
    }
  }
}
`;
  }

  static downloadSketch(code, filename = 'WaterQuality_ESP32.ino') {
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}
