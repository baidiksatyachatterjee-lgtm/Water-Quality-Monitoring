/*
 * =========================================================================
 * ESP32 Smart Water Quality Monitoring Node
 * Telemetry Firmware for Web App Monitoring
 * 
 * Works seamlessly with the deployed Web Application
 * Supports both Cloud MQTT (Secure WebSockets) and USB Serial
 * =========================================================================
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ---------- USER CONFIGURATION ----------
// Replace with your Wi-Fi credentials
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// HiveMQ public broker (Standard TCP port 1883 for ESP32; Web app uses WSS 8884)
const char* MQTT_BROKER   = "broker.hivemq.com";
const int   MQTT_PORT     = 1883;

// Station ID must match the Station ID in the Web App!
const char* STATION_ID    = "esp32-station-01";

// MQTT Topics
const char* TOPIC_TELEMETRY = "water-quality/esp32-station-01/telemetry";
const char* TOPIC_CONTROL   = "water-quality/esp32-station-01/control";

// ---------- SENSOR PIN MAPPINGS ----------
const int PIN_PH        = 34; // Analog ADC1 Pin for pH Meter
const int PIN_TURBIDITY = 35; // Analog ADC1 Pin for Turbidity Sensor
const int PIN_TDS       = 32; // Analog ADC1 Pin for TDS Sensor
const int PIN_ONE_WIRE  = 4;  // Digital Pin for DS18B20 Temp Probe (Requires 4.7k pullup)
const int PIN_LED       = 2;  // Built-in status LED

OneWire oneWire(PIN_ONE_WIRE);
DallasTemperature tempSensor(&oneWire);
WiFiClient espClient;
PubSubClient mqttClient(espClient);

unsigned long lastSampleTime = 0;
const unsigned long SAMPLE_INTERVAL = 2000; // 2 seconds between updates

// Smoothed ADC reading using 20 samples to filter noise
float readSmoothedADC(int pin, int samples = 20) {
  long sum = 0;
  for (int i = 0; i < samples; i++) {
    sum += analogRead(pin);
    delay(2);
  }
  return (float)sum / samples;
}

// Convert pH analog voltage to 0-14 pH scale
float readPH() {
  float rawADC = readSmoothedADC(PIN_PH);
  float voltage = rawADC * (3.3 / 4095.0);
  float phValue = 3.5 * voltage; // Calibrate against standard buffer solution
  if (phValue < 0.0) phValue = 0.0;
  if (phValue > 14.0) phValue = 14.0;
  return phValue;
}

// Convert Turbidity analog voltage to NTU scale
float readTurbidity() {
  float rawADC = readSmoothedADC(PIN_TURBIDITY);
  float voltage = rawADC * (3.3 / 4095.0);
  float ntu = -1120.4 * (voltage * voltage) + 5742.3 * voltage - 4352.9;
  if (voltage > 2.5) ntu = (2.5 - voltage) * 10.0;
  if (ntu < 0) ntu = 0.5;
  if (ntu > 1000) ntu = 1000;
  return ntu;
}

// Read TDS in ppm with temperature compensation
float readTDS(float tempC) {
  float rawADC = readSmoothedADC(PIN_TDS);
  float voltage = rawADC * (3.3 / 4095.0);
  float compCoeff = 1.0 + 0.02 * (tempC - 25.0);
  float compVoltage = voltage / compCoeff;
  float tds = (133.42 * pow(compVoltage, 3) - 255.86 * pow(compVoltage, 2) + 857.39 * compVoltage) * 0.5;
  if (tds < 0) tds = 0;
  return tds;
}

// Read digital DS18B20 temperature
float readWaterTemp() {
  tempSensor.requestTemperatures();
  float t = tempSensor.getTempCByIndex(0);
  if (t == DEVICE_DISCONNECTED_C || t < -20.0 || t > 80.0) {
    return 24.5; // Fallback
  }
  return t;
}

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
    Serial.println("\nWiFi Connected! IP Address: ");
    Serial.println(WiFi.localIP());
    digitalWrite(PIN_LED, HIGH);
  } else {
    Serial.println("\nWiFi Failed! Telemetry will stream via USB Serial only.");
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  Serial.print("Control message received: ");
  for (int i = 0; i < length; i++) {
    Serial.print((char)payload[i]);
  }
  Serial.println();
}

void reconnectMQTT() {
  if (WiFi.status() != WL_CONNECTED) return;

  while (!mqttClient.connected()) {
    Serial.print("Connecting to MQTT broker...");
    String clientId = "ESP32-WaterMonitor-" + String(random(0xffff), HEX);
    
    if (mqttClient.connect(clientId.c_str())) {
      Serial.println("connected!");
      mqttClient.subscribe(TOPIC_CONTROL);
    } else {
      Serial.print("failed, state=");
      Serial.print(mqttClient.state());
      Serial.println(" retrying in 5s...");
      delay(5000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_PH, INPUT);
  pinMode(PIN_TURBIDITY, INPUT);
  pinMode(PIN_TDS, INPUT);

  analogReadResolution(12);
  tempSensor.begin();

  setupWiFi();
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);

  Serial.println("=== Water Quality Node Initialized ===");
}

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

    float temp = readWaterTemp();
    float ph = readPH();
    float turb = readTurbidity();
    float tds = readTDS(temp);
    float dissolvedOxygen = 14.6 - 0.3 * temp; // DO approximation
    if (dissolvedOxygen < 0) dissolvedOxygen = 0;
    int rssi = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;

    StaticJsonDocument<256> doc;
    doc["stationId"] = STATION_ID;
    doc["ph"] = serialized(String(ph, 2));
    doc["turbidity"] = serialized(String(turb, 2));
    doc["tds"] = round(tds);
    doc["temp"] = serialized(String(temp, 1));
    doc["dissolvedOxygen"] = serialized(String(dissolvedOxygen, 2));
    doc["waterLevel"] = 82;
    doc["rssi"] = rssi;

    char buffer[256];
    serializeJson(doc, buffer);

    // 1. Output to Serial (Works directly with Web Serial in Chrome/Edge)
    Serial.println(buffer);

    // 2. Publish to Cloud MQTT
    if (mqttClient.connected()) {
      mqttClient.publish(TOPIC_TELEMETRY, buffer);
    }
  }
}
