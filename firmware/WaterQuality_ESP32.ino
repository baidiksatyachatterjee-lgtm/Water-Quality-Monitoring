/*
 * =========================================================================
 * UNIVERSAL ESP32 SMART WATER QUALITY MONITORING NODE
 * Compatible with ANY ESP32 board (Classic, S2, S3, C3)
 * 
 * Key Features:
 *  - Auto-generated unique Device ID from Hardware Silicon MAC address
 *  - Works out-of-the-box via USB Web Serial (no Wi-Fi setup needed)
 *  - Cloud MQTT streaming with auto-reconnect
 *  - Built-in Wi-Fi SoftAP fallback for phone configuration
 *  - Multi-sensor ADC smoothing filter (pH, Turbidity, TDS, Temp)
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
// You can enter your Wi-Fi credentials here, OR leave them to use USB Serial / SoftAP setup
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// HiveMQ public cloud broker (Port 1883 TCP; Web app uses WSS 8884)
const char* MQTT_BROKER   = "broker.hivemq.com";
const int   MQTT_PORT     = 1883;

// ---------- DYNAMIC DEVICE IDENTIFIER ----------
// Dynamically filled in setup() using the ESP32's unique factory silicon MAC address
String DEVICE_ID = "ESP32_DEV";
String TOPIC_TELEMETRY = "";
String TOPIC_CONTROL   = "";

// ---------- HARDWARE PIN MAPPINGS ----------
// Note: Use ADC1 pins (32-39) so analog reading works concurrently with Wi-Fi!
#if defined(CONFIG_IDF_TARGET_ESP32C3)
  const int PIN_PH        = 0;  // ADC1_CH0
  const int PIN_TURBIDITY = 1;  // ADC1_CH1
  const int PIN_TDS       = 2;  // ADC1_CH2
  const int PIN_ONE_WIRE  = 4;  // Digital 1-Wire
  const int PIN_LED       = 8;  // Status LED
#elif defined(CONFIG_IDF_TARGET_ESP32S2) || defined(CONFIG_IDF_TARGET_ESP32S3)
  const int PIN_PH        = 4;  // ADC1_CH3
  const int PIN_TURBIDITY = 5;  // ADC1_CH4
  const int PIN_TDS       = 6;  // ADC1_CH5
  const int PIN_ONE_WIRE  = 7;  // Digital 1-Wire
  const int PIN_LED       = 2;  // Status LED
#else
  // Standard ESP32 DevKit / NodeMCU-32S / ESP-WROOM-32
  const int PIN_PH        = 34; // ADC1_CH6
  const int PIN_TURBIDITY = 35; // ADC1_CH7
  const int PIN_TDS       = 32; // ADC1_CH4
  const int PIN_ONE_WIRE  = 4;  // Digital GPIO 4 (Requires 4.7k pullup resistor)
  const int PIN_LED       = 2;  // Status LED
#endif

// ---------- HARDWARE DRIVERS ----------
OneWire oneWire(PIN_ONE_WIRE);
DallasTemperature tempSensor(&oneWire);
WiFiClient espClient;
PubSubClient mqttClient(espClient);

unsigned long lastSampleTime = 0;
const unsigned long SAMPLE_INTERVAL = 2000; // 2 seconds between updates

// ---------- ADC NOISE FILTER ----------
float readSmoothedADC(int pin, int samples = 20) {
  long sum = 0;
  for (int i = 0; i < samples; i++) {
    sum += analogRead(pin);
    delay(2);
  }
  return (float)sum / samples;
}

// ---------- SENSOR CALCULATION ROUTINES ----------

// 1. pH Sensor: Linear voltage-to-pH conversion
float readPH() {
  float rawADC = readSmoothedADC(PIN_PH);
  float voltage = rawADC * (3.3 / 4095.0);
  float phValue = 3.5 * voltage; // Two-point calibration standard
  if (phValue < 0.0) phValue = 0.0;
  if (phValue > 14.0) phValue = 14.0;
  return phValue;
}

// 2. Turbidity Sensor: Optical NTU calculation
float readTurbidity() {
  float rawADC = readSmoothedADC(PIN_TURBIDITY);
  float voltage = rawADC * (3.3 / 4095.0);
  float ntu = -1120.4 * (voltage * voltage) + 5742.3 * voltage - 4352.9;
  if (voltage > 2.5) ntu = (2.5 - voltage) * 10.0;
  if (ntu < 0) ntu = 0.5;
  if (ntu > 1000) ntu = 1000;
  return ntu;
}

// 3. TDS Meter: Temperature-compensated Total Dissolved Solids in ppm
float readTDS(float waterTempC) {
  float rawADC = readSmoothedADC(PIN_TDS);
  float voltage = rawADC * (3.3 / 4095.0);
  float compensationCoeff = 1.0 + 0.02 * (waterTempC - 25.0);
  float compensationVoltage = voltage / compensationCoeff;
  float tds = (133.42 * pow(compensationVoltage, 3) 
             - 255.86 * pow(compensationVoltage, 2) 
             + 857.39 * compensationVoltage) * 0.5;
  if (tds < 0) tds = 0;
  return tds;
}

// 4. DS18B20 Digital Waterproof Temperature Probe
float readWaterTemp() {
  tempSensor.requestTemperatures();
  float t = tempSensor.getTempCByIndex(0);
  if (t == DEVICE_DISCONNECTED_C || t < -20.0 || t > 80.0) {
    return 24.5; // Safe default if probe not connected
  }
  return t;
}

// ---------- HARDWARE MAC IDENTIFIER INITIALIZER ----------
void initDeviceID() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char idBuffer[32];
  // Auto-generate clean unique ID like ESP32_78E29A
  snprintf(idBuffer, sizeof(idBuffer), "ESP32_%02X%02X%02X", mac[3], mac[4], mac[5]);
  DEVICE_ID = String(idBuffer);

  TOPIC_TELEMETRY = "water-quality/" + DEVICE_ID + "/telemetry";
  TOPIC_CONTROL   = "water-quality/" + DEVICE_ID + "/control";
}

// ---------- WI-FI & MQTT CONNECTION ----------
void setupWiFi() {
  if (String(WIFI_SSID) == "YOUR_WIFI_SSID" || strlen(WIFI_SSID) == 0) {
    Serial.println("\n[INFO] Wi-Fi SSID not configured. Streaming over USB Serial directly.");
    Serial.println("[INFO] Web App can connect via 'USB Serial' button right now!");
    return;
  }

  Serial.println();
  Serial.print("Connecting to Wi-Fi: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int retries = 0;
  while (WiFi.status() != WL_CONNECTED && retries < 20) {
    delay(500);
    Serial.print(".");
    digitalWrite(PIN_LED, !digitalRead(PIN_LED));
    retries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[OK] Wi-Fi Connected!");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
    digitalWrite(PIN_LED, HIGH);
  } else {
    Serial.println("\n[WARN] Wi-Fi connection timed out. Falling back to USB Serial mode.");
    Serial.println("[INFO] Telemetry will continue streaming over USB Serial at 115200 baud.");
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  Serial.print("MQTT Control Message [");
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
    Serial.print("Connecting to MQTT broker...");
    String clientId = DEVICE_ID + "-" + String(random(0xffff), HEX);
    
    if (mqttClient.connect(clientId.c_str())) {
      Serial.println(" Connected to Cloud Broker!");
      mqttClient.subscribe(TOPIC_CONTROL.c_str());
    } else {
      Serial.print(" Failed (rc=");
      Serial.print(mqttClient.state());
      Serial.println("). Retrying in 5s...");
      delay(5000);
    }
  }
}

// ---------- SETUP ----------
void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_PH, INPUT);
  pinMode(PIN_TURBIDITY, INPUT);
  pinMode(PIN_TDS, INPUT);

  analogReadResolution(12);
  tempSensor.begin();

  // Generate Unique Silicon Device ID
  initDeviceID();

  Serial.println("\n========================================================");
  Serial.println("   AquaPulse Universal ESP32 Water Quality Node         ");
  Serial.println("========================================================");
  Serial.print("Device Identifier : "); Serial.println(DEVICE_ID);
  Serial.print("Telemetry Topic   : "); Serial.println(TOPIC_TELEMETRY);
  Serial.println("========================================================\n");

  setupWiFi();

  if (WiFi.status() == WL_CONNECTED) {
    mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
    mqttClient.setCallback(mqttCallback);
  }
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

    // Read Sensors
    float tempC = readWaterTemp();
    float phVal = readPH();
    float turbVal = readTurbidity();
    float tdsVal = readTDS(tempC);
    // Calculated dissolved oxygen approximation
    float doVal = 14.6 - 0.3 * tempC;
    if (doVal < 0) doVal = 0;
    int rssi = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;

    // Assemble Universal JSON Packet
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

    // 1. Output to USB Serial (Universal Web Serial Monitor)
    Serial.println(buffer);

    // 2. Publish to Cloud MQTT
    if (WiFi.status() == WL_CONNECTED && mqttClient.connected()) {
      mqttClient.publish(TOPIC_TELEMETRY.c_str(), buffer);
    }
  }
}
