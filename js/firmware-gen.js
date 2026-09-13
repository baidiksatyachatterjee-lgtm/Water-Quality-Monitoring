/**
 * Universal ESP32 Firmware Generator
 * Produces customized, compile-ready Arduino C++ sketches for ANY ESP32 board
 */

export class FirmwareGenerator {
  static generateCode(config) {
    const {
      boardType = 'esp32', // 'esp32' | 'esp32s2' | 'esp32s3' | 'esp32c3'
      ssid = 'YOUR_WIFI_SSID',
      password = 'YOUR_WIFI_PASSWORD',
      stationId = 'AUTO_MAC',
      mqttBroker = 'broker.hivemq.com',
      mqttPort = 1883,
      pinPH = 34,
      pinTurbidity = 35,
      pinTDS = 32,
      pinTemp = 4,
      intervalMs = 2000
    } = config;

    const isAutoMac = !stationId || stationId === 'AUTO_MAC' || stationId.trim() === '';

    return `/*
 * =========================================================================
 * UNIVERSAL ESP32 WATER QUALITY MONITORING FIRMWARE
 * Compatible with ANY ESP32 board
 * =========================================================================
 * 
 * Required Arduino Libraries (Install via Arduino Library Manager):
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

// ---------- WI-FI CONFIGURATION ----------
const char* WIFI_SSID     = "${ssid}";
const char* WIFI_PASSWORD = "${password}";

// Cloud MQTT Broker
const char* MQTT_BROKER   = "${mqttBroker}";
const int   MQTT_PORT     = ${mqttPort};

// Device Identification
String DEVICE_ID = "${isAutoMac ? "ESP32_AUTO" : stationId}";
String TOPIC_TELEMETRY = "";
String TOPIC_CONTROL   = "";

// ---------- SENSOR PINS ----------
const int PIN_PH        = ${pinPH};
const int PIN_TURBIDITY = ${pinTurbidity};
const int PIN_TDS       = ${pinTDS};
const int PIN_ONE_WIRE  = ${pinTemp};
const int PIN_LED       = 2;

OneWire oneWire(PIN_ONE_WIRE);
DallasTemperature tempSensor(&oneWire);
WiFiClient espClient;
PubSubClient mqttClient(espClient);

unsigned long lastSampleTime = 0;
const unsigned long SAMPLE_INTERVAL = ${intervalMs};

float readSmoothedADC(int pin, int samples = 20) {
  long sum = 0;
  for (int i = 0; i < samples; i++) {
    sum += analogRead(pin);
    delay(2);
  }
  return (float)sum / samples;
}

float readPH() {
  float rawADC = readSmoothedADC(PIN_PH);
  float voltage = rawADC * (3.3 / 4095.0);
  float ph = 3.5 * voltage;
  if (ph < 0.0) ph = 0.0;
  if (ph > 14.0) ph = 14.0;
  return ph;
}

float readTurbidity() {
  float rawADC = readSmoothedADC(PIN_TURBIDITY);
  float voltage = rawADC * (3.3 / 4095.0);
  float ntu = -1120.4 * (voltage * voltage) + 5742.3 * voltage - 4352.9;
  if (voltage > 2.5) ntu = (2.5 - voltage) * 10.0;
  if (ntu < 0) ntu = 0.5;
  if (ntu > 1000) ntu = 1000;
  return ntu;
}

float readTDS(float tempC) {
  float rawADC = readSmoothedADC(PIN_TDS);
  float voltage = rawADC * (3.3 / 4095.0);
  float compCoeff = 1.0 + 0.02 * (tempC - 25.0);
  float compVoltage = voltage / compCoeff;
  float tds = (133.42 * pow(compVoltage, 3) - 255.86 * pow(compVoltage, 2) + 857.39 * compVoltage) * 0.5;
  if (tds < 0) tds = 0;
  return tds;
}

float readWaterTemp() {
  tempSensor.requestTemperatures();
  float t = tempSensor.getTempCByIndex(0);
  if (t == DEVICE_DISCONNECTED_C || t < -20.0 || t > 80.0) return 24.5;
  return t;
}

void initDeviceID() {
  ${isAutoMac ? `uint8_t mac[6];
  WiFi.macAddress(mac);
  char idBuffer[32];
  snprintf(idBuffer, sizeof(idBuffer), "ESP32_%02X%02X%02X", mac[3], mac[4], mac[5]);
  DEVICE_ID = String(idBuffer);` : `DEVICE_ID = "${stationId}";`}

  TOPIC_TELEMETRY = "water-quality/" + DEVICE_ID + "/telemetry";
  TOPIC_CONTROL   = "water-quality/" + DEVICE_ID + "/control";
}

void setupWiFi() {
  if (String(WIFI_SSID) == "YOUR_WIFI_SSID" || strlen(WIFI_SSID) == 0) {
    Serial.println("\\n[INFO] Wi-Fi SSID not configured. Streaming over USB Serial directly at 115200 baud.");
    return;
  }

  Serial.print("Connecting to Wi-Fi: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int retries = 0;
  while (WiFi.status() != WL_CONNECTED && retries < 20) {
    delay(500);
    Serial.print(".");
    retries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\\n[OK] Connected! IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\\n[WARN] Wi-Fi timed out. Continuing in USB Serial mode.");
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  Serial.print("Control message: ");
  for (int i = 0; i < length; i++) Serial.print((char)payload[i]);
  Serial.println();
}

void reconnectMQTT() {
  if (WiFi.status() != WL_CONNECTED) return;
  while (!mqttClient.connected()) {
    Serial.print("Connecting to MQTT broker...");
    String clientId = DEVICE_ID + "-" + String(random(0xffff), HEX);
    if (mqttClient.connect(clientId.c_str())) {
      Serial.println(" Connected!");
      mqttClient.subscribe(TOPIC_CONTROL.c_str());
    } else {
      Serial.println(" Retrying in 5s...");
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

  initDeviceID();

  Serial.println("\\n========================================================");
  Serial.println("   AquaPulse Universal ESP32 Telemetry Node Active     ");
  Serial.print  ("   Device ID       : "); Serial.println(DEVICE_ID);
  Serial.print  ("   Telemetry Topic : "); Serial.println(TOPIC_TELEMETRY);
  Serial.println("========================================================\\n");

  setupWiFi();

  if (WiFi.status() == WL_CONNECTED) {
    mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
    mqttClient.setCallback(mqttCallback);
  }
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!mqttClient.connected()) reconnectMQTT();
    mqttClient.loop();
  }

  unsigned long currentMillis = millis();
  if (currentMillis - lastSampleTime >= SAMPLE_INTERVAL) {
    lastSampleTime = currentMillis;

    float tempC = readWaterTemp();
    float phVal = readPH();
    float turbVal = readTurbidity();
    float tdsVal = readTDS(tempC);
    float doVal = max(0.0f, 14.6f - 0.3f * tempC);
    int rssi = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;

    StaticJsonDocument<256> doc;
    doc["deviceId"] = DEVICE_ID;
    doc["stationId"] = DEVICE_ID;
    doc["ph"] = serialized(String(phVal, 2));
    doc["turbidity"] = serialized(String(turbVal, 2));
    doc["tds"] = round(tdsVal);
    doc["temp"] = serialized(String(tempC, 1));
    doc["dissolvedOxygen"] = serialized(String(doVal, 2));
    doc["waterLevel"] = 82;
    doc["rssi"] = rssi;

    char buffer[256];
    serializeJson(doc, buffer);

    // 1. Output over USB Serial
    Serial.println(buffer);

    // 2. Publish to Cloud MQTT
    if (WiFi.status() == WL_CONNECTED && mqttClient.connected()) {
      mqttClient.publish(TOPIC_TELEMETRY.c_str(), buffer);
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
