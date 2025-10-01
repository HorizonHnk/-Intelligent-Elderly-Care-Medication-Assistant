/*
 * ==================================================================================
 * MEDICARE ASSISTANT - ESP32 API SERVER
 * ==================================================================================
 *
 * IoT Elderly Care Medication Reminder System
 * Pure REST API + WebSocket Server (No HTML serving)
 *
 * Hardware:
 *   - ESP32 DevKit V1 (30-pin)
 *   - 20x4 LCD I2C (0x27) - SDA: GPIO 21, SCL: GPIO 22
 *   - LEDs: Red (GPIO 25), Green (GPIO 26), Blue (GPIO 27)
 *   - Active Buzzer: GPIO 14
 *   - Buttons: GPIO 32, 33, 35, 34 (internal pull-up)
 *   - Potentiometer: GPIO 36 (ADC)
 *
 * Website: https://medicare-assistant.netlify.app/
 * Repository: https://github.com/HorizonHnk/-Intelligent-Elderly-Care-Medication-Assistant
 *
 * Memory Usage Target: <250KB (vs 450KB with monolithic HTML)
 *
 * ==================================================================================
 */

// ====================================================================================
// LIBRARIES
// ====================================================================================
#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>
#include <SPIFFS.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <HTTPClient.h>

// ====================================================================================
// CONFIGURATION
// ====================================================================================

// WiFi Credentials
const char* ssid = "YOUR_WIFI_SSID";      // ← Change this
const char* password = "YOUR_WIFI_PASSWORD"; // ← Change this

// Google Gemini AI API Key
const char* geminiApiKey = "YOUR_GEMINI_API_KEY"; // ← Change this

// Hardware Pin Definitions
#define LED_RED   25
#define LED_GREEN 26
#define LED_BLUE  27
#define BUZZER    14
#define BTN_1     32
#define BTN_2     33
#define BTN_3     35
#define BTN_4     34
#define POT       36

// I2C LCD
#define LCD_ADDR  0x27
#define LCD_COLS  20
#define LCD_ROWS  4

// Servers
WebServer server(80);           // HTTP API Server
WebSocketsServer ws(81);        // WebSocket Server

// LCD
LiquidCrystal_I2C lcd(LCD_ADDR, LCD_COLS, LCD_ROWS);

// ====================================================================================
// GLOBAL VARIABLES
// ====================================================================================

// Timing
unsigned long lastMedicationCheck = 0;
const unsigned long MEDICATION_CHECK_INTERVAL = 60000; // Check every minute

unsigned long lastButtonCheck = 0;
const unsigned long BUTTON_CHECK_INTERVAL = 50; // Debounce 50ms

// Button states (for debouncing)
bool btnState[4] = {HIGH, HIGH, HIGH, HIGH};
bool btnLastState[4] = {HIGH, HIGH, HIGH, HIGH};
unsigned long btnLastDebounce[4] = {0, 0, 0, 0};
const unsigned long DEBOUNCE_DELAY = 50;

// Medication alert active flag
bool medicationAlertActive = false;
String currentMedicationAlert = "";

// Device uptime
unsigned long bootTime = 0;

// WebSocket clients tracking
uint8_t wsClientCount = 0;

// ====================================================================================
// SETUP
// ====================================================================================

void setup() {
  Serial.begin(115200);
  Serial.println("\n\n╔═══════════════════════════════════════════════════╗");
  Serial.println("║   MEDICARE ASSISTANT - ESP32 API SERVER          ║");
  Serial.println("╚═══════════════════════════════════════════════════╝");

  bootTime = millis();

  // Initialize Hardware
  initHardware();

  // Initialize SPIFFS
  initSPIFFS();

  // Connect WiFi
  connectWiFi();

  // Initialize LCD
  initLCD();

  // Setup HTTP API Routes
  setupAPIRoutes();

  // Start Servers
  server.begin();
  ws.begin();
  ws.onEvent(wsEvent);

  Serial.println("\n✅ ESP32 API Server Ready!");
  Serial.print("📡 API Endpoint: http://");
  Serial.print(WiFi.localIP());
  Serial.println("/api/");
  Serial.print("🔌 WebSocket: ws://");
  Serial.print(WiFi.localIP());
  Serial.println(":81");
  Serial.println("\n✨ Waiting for connections from website...\n");

  // Display IP on LCD
  displayIPAddress();
}

// ====================================================================================
// MAIN LOOP
// ====================================================================================

void loop() {
  // Handle HTTP requests
  server.handleClient();

  // Handle WebSocket
  ws.loop();

  // Check medications (every minute)
  if (millis() - lastMedicationCheck >= MEDICATION_CHECK_INTERVAL) {
    lastMedicationCheck = millis();
    checkMedicationSchedule();
  }

  // Check buttons (with debouncing)
  if (millis() - lastButtonCheck >= BUTTON_CHECK_INTERVAL) {
    lastButtonCheck = millis();
    checkButtons();
  }

  // Update LCD display periodically
  static unsigned long lastLCDUpdate = 0;
  if (millis() - lastLCDUpdate >= 5000) { // Every 5 seconds
    lastLCDUpdate = millis();
    updateLCDStatus();
  }
}

// ====================================================================================
// HARDWARE INITIALIZATION
// ====================================================================================

void initHardware() {
  Serial.println("[Hardware] Initializing...");

  // LEDs
  pinMode(LED_RED, OUTPUT);
  pinMode(LED_GREEN, OUTPUT);
  pinMode(LED_BLUE, OUTPUT);
  digitalWrite(LED_RED, LOW);
  digitalWrite(LED_GREEN, LOW);
  digitalWrite(LED_BLUE, LOW);

  // Buzzer
  pinMode(BUZZER, OUTPUT);
  digitalWrite(BUZZER, LOW);

  // Buttons (internal pull-up)
  pinMode(BTN_1, INPUT_PULLUP);
  pinMode(BTN_2, INPUT_PULLUP);
  pinMode(BTN_3, INPUT_PULLUP);
  pinMode(BTN_4, INPUT_PULLUP);

  // Potentiometer (ADC)
  analogReadResolution(12); // 12-bit resolution (0-4095)

  Serial.println("[Hardware] ✓ Initialized");
}

// ====================================================================================
// SPIFFS INITIALIZATION
// ====================================================================================

void initSPIFFS() {
  Serial.println("[SPIFFS] Initializing...");

  if (!SPIFFS.begin(true)) { // true = format if mount fails
    Serial.println("[SPIFFS] ✗ Mount failed!");
    return;
  }

  Serial.println("[SPIFFS] ✓ Mounted");

  // Create default files if they don't exist
  if (!SPIFFS.exists("/medications.json")) {
    File file = SPIFFS.open("/medications.json", "w");
    file.print("{\"medications\":[]}");
    file.close();
    Serial.println("[SPIFFS] Created medications.json");
  }

  if (!SPIFFS.exists("/history.json")) {
    File file = SPIFFS.open("/history.json", "w");
    file.print("{\"history\":[]}");
    file.close();
    Serial.println("[SPIFFS] Created history.json");
  }

  if (!SPIFFS.exists("/settings.json")) {
    File file = SPIFFS.open("/settings.json", "w");
    file.print("{\"volume\":80,\"language\":\"en\"}");
    file.close();
    Serial.println("[SPIFFS] Created settings.json");
  }
}

// ====================================================================================
// WIFI CONNECTION
// ====================================================================================

void connectWiFi() {
  Serial.print("[WiFi] Connecting to ");
  Serial.print(ssid);
  Serial.print("...");

  WiFi.begin(ssid, password);
  WiFi.setHostname("medicare-esp32");

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WiFi] ✓ Connected!");
    Serial.print("[WiFi] IP Address: ");
    Serial.println(WiFi.localIP());
    Serial.print("[WiFi] Signal: ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
  } else {
    Serial.println("\n[WiFi] ✗ Connection failed!");
    Serial.println("[WiFi] Please check credentials and restart");
  }
}

// ====================================================================================
// LCD INITIALIZATION & DISPLAY
// ====================================================================================

void initLCD() {
  Serial.println("[LCD] Initializing...");

  Wire.begin(21, 22); // SDA=21, SCL=22
  lcd.init();
  lcd.backlight();
  lcd.clear();

  // Boot message
  lcd.setCursor(0, 0);
  lcd.print("  MEDICARE ASSISTANT");
  lcd.setCursor(0, 1);
  lcd.print("  Booting ESP32...");
  lcd.setCursor(0, 2);
  lcd.print("  Please Wait...");

  delay(2000);

  Serial.println("[LCD] ✓ Initialized");
}

void displayIPAddress() {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("MEDICARE ASSISTANT");
  lcd.setCursor(0, 1);
  lcd.print("====================");
  lcd.setCursor(0, 2);
  lcd.print("IP: ");
  lcd.print(WiFi.localIP());
  lcd.setCursor(0, 3);
  lcd.print("Status: Ready");

  // Flash green LED to indicate ready
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_GREEN, HIGH);
    delay(200);
    digitalWrite(LED_GREEN, LOW);
    delay(200);
  }
}

void updateLCDStatus() {
  // Update LCD with current status (called periodically)
  lcd.setCursor(0, 3);
  lcd.print("Clients: ");
  lcd.print(wsClientCount);
  lcd.print("  ");

  // Show uptime
  unsigned long uptime = (millis() - bootTime) / 1000; // seconds
  unsigned long hours = uptime / 3600;
  unsigned long minutes = (uptime % 3600) / 60;

  lcd.setCursor(12, 3);
  lcd.print(hours);
  lcd.print("h");
  lcd.print(minutes);
  lcd.print("m");
  lcd.print("  ");
}

void displayMedicationAlert(String medName) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("** MEDICATION TIME **");
  lcd.setCursor(0, 1);
  lcd.print("====================");
  lcd.setCursor(0, 2);

  // Truncate if too long
  if (medName.length() > 20) {
    lcd.print(medName.substring(0, 17) + "...");
  } else {
    lcd.print(medName);
  }

  lcd.setCursor(0, 3);
  lcd.print("Press BTN to confirm");
}

// ====================================================================================
// API ROUTES SETUP
// ====================================================================================

void setupAPIRoutes() {
  Serial.println("[API] Setting up routes...");

  // Enable CORS for all routes
  server.enableCORS(true);

  // Root (just for testing)
  server.on("/", HTTP_GET, handleRoot);

  // API Status
  server.on("/api/status", HTTP_GET, handleGetStatus);

  // Medications
  server.on("/api/medications", HTTP_GET, handleGetMedications);
  server.on("/api/medications", HTTP_POST, handleAddMedication);
  server.on("/api/medications", HTTP_OPTIONS, handleCORS); // Pre-flight

  // Medication by ID
  server.on("/api/medications/*", HTTP_PUT, handleUpdateMedication);
  server.on("/api/medications/*", HTTP_DELETE, handleDeleteMedication);

  // Confirm medication
  server.on("/api/confirm", HTTP_POST, handleConfirmMedication);
  server.on("/api/confirm", HTTP_OPTIONS, handleCORS);

  // History
  server.on("/api/history", HTTP_GET, handleGetHistory);

  // Settings
  server.on("/api/settings", HTTP_POST, handleUpdateSettings);
  server.on("/api/settings", HTTP_OPTIONS, handleCORS);

  // Document scanning (Gemini AI)
  server.on("/api/scan-document", HTTP_POST, handleScanDocument);
  server.on("/api/scan-document", HTTP_OPTIONS, handleCORS);

  // 404 handler
  server.onNotFound(handleNotFound);

  Serial.println("[API] ✓ Routes configured");
}

// ====================================================================================
// CORS HANDLER
// ====================================================================================

void handleCORS() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  server.send(200, "text/plain", "");
}

// ====================================================================================
// API HANDLERS
// ====================================================================================

void handleRoot() {
  String html = "<!DOCTYPE html><html><head><title>Medicare ESP32</title></head><body>";
  html += "<h1>MediCare Assistant ESP32 API Server</h1>";
  html += "<p>Status: <span style='color:green;'>Online</span></p>";
  html += "<p>IP Address: " + WiFi.localIP().toString() + "</p>";
  html += "<p>Uptime: " + String((millis() - bootTime) / 1000) + " seconds</p>";
  html += "<h2>API Endpoints:</h2><ul>";
  html += "<li>GET /api/status</li>";
  html += "<li>GET /api/medications</li>";
  html += "<li>POST /api/medications</li>";
  html += "<li>PUT /api/medications/:id</li>";
  html += "<li>DELETE /api/medications/:id</li>";
  html += "<li>POST /api/confirm</li>";
  html += "<li>GET /api/history</li>";
  html += "<li>POST /api/settings</li>";
  html += "<li>POST /api/scan-document</li>";
  html += "</ul>";
  html += "<p><a href='https://medicare-assistant.netlify.app/' target='_blank'>Open Website</a></p>";
  html += "</body></html>";

  server.send(200, "text/html", html);
}

void handleGetStatus() {
  Serial.println("[API] GET /api/status");

  StaticJsonDocument<512> doc;
  doc["success"] = true;
  doc["uptime"] = (millis() - bootTime) / 1000;
  doc["wifi_signal"] = WiFi.RSSI();
  doc["free_memory"] = ESP.getFreeHeap();
  doc["connected_clients"] = wsClientCount;
  doc["ip_address"] = WiFi.localIP().toString();

  String response;
  serializeJson(doc, response);

  server.send(200, "application/json", response);
}

void handleGetMedications() {
  Serial.println("[API] GET /api/medications");

  if (!SPIFFS.exists("/medications.json")) {
    server.send(404, "application/json", "{\"success\":false,\"error\":\"File not found\"}");
    return;
  }

  File file = SPIFFS.open("/medications.json", "r");
  String content = file.readString();
  file.close();

  server.send(200, "application/json", content);
}

void handleAddMedication() {
  Serial.println("[API] POST /api/medications");

  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"No body\"}");
    return;
  }

  String body = server.arg("plain");
  Serial.println("[API] Body: " + body);

  // Parse existing medications
  File file = SPIFFS.open("/medications.json", "r");
  String content = file.readString();
  file.close();

  DynamicJsonDocument doc(4096);
  deserializeJson(doc, content);

  // Parse new medication
  DynamicJsonDocument newMed(1024);
  deserializeJson(newMed, body);

  // Add to array
  JsonArray meds = doc["medications"].as<JsonArray>();
  meds.add(newMed.as<JsonObject>());

  // Save back
  file = SPIFFS.open("/medications.json", "w");
  serializeJson(doc, file);
  file.close();

  server.send(200, "application/json", "{\"success\":true}");

  // Broadcast update via WebSocket
  broadcastWebSocket("{\"type\":\"medication_added\"}");
}

void handleUpdateMedication() {
  Serial.println("[API] PUT /api/medications/*");

  // Extract ID from URL
  String uri = server.uri();
  int lastSlash = uri.lastIndexOf('/');
  String id = uri.substring(lastSlash + 1);

  Serial.println("[API] Updating medication ID: " + id);

  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"No body\"}");
    return;
  }

  String body = server.arg("plain");

  // Read existing
  File file = SPIFFS.open("/medications.json", "r");
  String content = file.readString();
  file.close();

  DynamicJsonDocument doc(4096);
  deserializeJson(doc, content);

  // Find and update
  JsonArray meds = doc["medications"].as<JsonArray>();
  bool found = false;

  for (JsonObject med : meds) {
    if (med["id"] == id) {
      DynamicJsonDocument updateDoc(1024);
      deserializeJson(updateDoc, body);

      // Update fields
      for (JsonPair kv : updateDoc.as<JsonObject>()) {
        med[kv.key()] = kv.value();
      }

      found = true;
      break;
    }
  }

  if (found) {
    // Save
    file = SPIFFS.open("/medications.json", "w");
    serializeJson(doc, file);
    file.close();

    server.send(200, "application/json", "{\"success\":true}");
  } else {
    server.send(404, "application/json", "{\"success\":false,\"error\":\"Not found\"}");
  }
}

void handleDeleteMedication() {
  Serial.println("[API] DELETE /api/medications/*");

  String uri = server.uri();
  int lastSlash = uri.lastIndexOf('/');
  String id = uri.substring(lastSlash + 1);

  Serial.println("[API] Deleting medication ID: " + id);

  // Read existing
  File file = SPIFFS.open("/medications.json", "r");
  String content = file.readString();
  file.close();

  DynamicJsonDocument doc(4096);
  deserializeJson(doc, content);

  // Remove from array
  JsonArray meds = doc["medications"].as<JsonArray>();
  JsonArray newMeds = doc.createNestedArray("medications");

  bool found = false;
  for (JsonObject med : meds) {
    if (med["id"] != id) {
      newMeds.add(med);
    } else {
      found = true;
    }
  }

  if (found) {
    doc.remove("medications");
    doc["medications"] = newMeds;

    // Save
    file = SPIFFS.open("/medications.json", "w");
    serializeJson(doc, file);
    file.close();

    server.send(200, "application/json", "{\"success\":true}");
  } else {
    server.send(404, "application/json", "{\"success\":false,\"error\":\"Not found\"}");
  }
}

void handleConfirmMedication() {
  Serial.println("[API] POST /api/confirm");

  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"No body\"}");
    return;
  }

  // Turn off alert
  medicationAlertActive = false;
  currentMedicationAlert = "";

  // Turn off buzzer and red LED
  digitalWrite(BUZZER, LOW);
  digitalWrite(LED_RED, LOW);

  // Flash green LED (confirmed)
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_GREEN, HIGH);
    delay(100);
    digitalWrite(LED_GREEN, LOW);
    delay(100);
  }

  // Update LCD
  lcd.clear();
  lcd.setCursor(0, 1);
  lcd.print("   CONFIRMED! :)");
  delay(2000);
  displayIPAddress();

  // Log to history
  String body = server.arg("plain");
  DynamicJsonDocument logDoc(512);
  deserializeJson(logDoc, body);
  logDoc["timestamp"] = millis();
  logDoc["status"] = "confirmed";

  // Append to history
  File histFile = SPIFFS.open("/history.json", "r");
  String histContent = histFile.readString();
  histFile.close();

  DynamicJsonDocument histDoc(8192);
  deserializeJson(histDoc, histContent);

  JsonArray history = histDoc["history"].as<JsonArray>();
  history.add(logDoc.as<JsonObject>());

  histFile = SPIFFS.open("/history.json", "w");
  serializeJson(histDoc, histFile);
  histFile.close();

  server.send(200, "application/json", "{\"success\":true}");

  // Broadcast via WebSocket
  broadcastWebSocket("{\"type\":\"medication_confirmed\"}");
}

void handleGetHistory() {
  Serial.println("[API] GET /api/history");

  if (!SPIFFS.exists("/history.json")) {
    server.send(404, "application/json", "{\"success\":false,\"error\":\"File not found\"}");
    return;
  }

  File file = SPIFFS.open("/history.json", "r");
  String content = file.readString();
  file.close();

  server.send(200, "application/json", content);
}

void handleUpdateSettings() {
  Serial.println("[API] POST /api/settings");

  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"No body\"}");
    return;
  }

  String body = server.arg("plain");

  File file = SPIFFS.open("/settings.json", "w");
  file.print(body);
  file.close();

  server.send(200, "application/json", "{\"success\":true}");
}

void handleScanDocument() {
  Serial.println("[API] POST /api/scan-document");

  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"No body\"}");
    return;
  }

  String body = server.arg("plain");
  DynamicJsonDocument doc(32768); // Large buffer for base64 image
  deserializeJson(doc, body);

  String imageBase64 = doc["image"].as<String>();

  // Call Gemini AI
  String result = callGeminiAI(imageBase64);

  server.send(200, "application/json", result);
}

void handleNotFound() {
  Serial.print("[API] 404 Not Found: ");
  Serial.println(server.uri());

  server.send(404, "application/json", "{\"success\":false,\"error\":\"Not found\"}");
}

// ====================================================================================
// GEMINI AI INTEGRATION
// ====================================================================================

String callGeminiAI(String imageBase64) {
  HTTPClient http;

  String url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-vision:generateContent?key=";
  url += geminiApiKey;

  // Build request
  DynamicJsonDocument requestDoc(32768);
  JsonArray contents = requestDoc.createNestedArray("contents");
  JsonObject content = contents.createNestedObject();
  JsonArray parts = content.createNestedArray("parts");

  JsonObject textPart = parts.createNestedObject();
  textPart["text"] = "Analyze this prescription or pill image and extract medication names, dosages, and instructions.";

  JsonObject imagePart = parts.createNestedObject();
  JsonObject inlineData = imagePart.createNestedObject("inline_data");
  inlineData["mime_type"] = "image/jpeg";
  inlineData["data"] = imageBase64;

  String requestBody;
  serializeJson(requestDoc, requestBody);

  // Send request
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  int httpCode = http.POST(requestBody);
  String response = "{}";

  if (httpCode == HTTP_CODE_OK) {
    response = http.getString();
    Serial.println("[Gemini] ✓ Success");
  } else {
    Serial.print("[Gemini] ✗ Error: ");
    Serial.println(httpCode);
    response = "{\"success\":false,\"error\":\"Gemini API error\"}";
  }

  http.end();
  return response;
}

// ====================================================================================
// WEBSOCKET HANDLERS
// ====================================================================================

void wsEvent(uint8_t num, WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.printf("[WS] Client #%u disconnected\n", num);
      if (wsClientCount > 0) wsClientCount--;
      break;

    case WStype_CONNECTED: {
      IPAddress ip = ws.remoteIP(num);
      Serial.printf("[WS] Client #%u connected from %d.%d.%d.%d\n", num, ip[0], ip[1], ip[2], ip[3]);
      wsClientCount++;

      // Send welcome message
      ws.sendTXT(num, "{\"type\":\"welcome\",\"message\":\"Connected to ESP32\"}");
      break;
    }

    case WStype_TEXT:
      Serial.printf("[WS] Received from #%u: %s\n", num, payload);
      // Handle incoming messages if needed
      break;
  }
}

void broadcastWebSocket(String message) {
  ws.broadcastTXT(message);
  Serial.println("[WS] Broadcast: " + message);
}

// ====================================================================================
// MEDICATION SCHEDULER
// ====================================================================================

void checkMedicationSchedule() {
  // Read medications
  File file = SPIFFS.open("/medications.json", "r");
  if (!file) return;

  String content = file.readString();
  file.close();

  DynamicJsonDocument doc(4096);
  deserializeJson(doc, content);

  JsonArray meds = doc["medications"].as<JsonArray>();

  // Get current time (you may want to use NTP for accurate time)
  // For now, using millis() as placeholder
  // In production, implement proper time checking with NTP

  for (JsonObject med : meds) {
    // Check if medication time matches current time
    // This is simplified - implement proper time matching logic
    String medTime = med["time"].as<String>();
    bool enabled = med["enabled"] | true;

    if (enabled) {
      // For demo: randomly trigger alert (replace with actual time checking)
      // triggerMedicationAlert(med["name"].as<String>());
    }
  }
}

void triggerMedicationAlert(String medName) {
  if (medicationAlertActive) return; // Already alerting

  Serial.println("[Alert] Medication reminder: " + medName);

  medicationAlertActive = true;
  currentMedicationAlert = medName;

  // Display on LCD
  displayMedicationAlert(medName);

  // Flash red LED
  digitalWrite(LED_RED, HIGH);

  // Sound buzzer (get volume from potentiometer)
  int volume = map(analogRead(POT), 0, 4095, 0, 255);
  analogWrite(BUZZER, volume);

  // Broadcast via WebSocket
  DynamicJsonDocument alertDoc(256);
  alertDoc["type"] = "medication_alert";
  alertDoc["medication"] = medName;

  String alertMsg;
  serializeJson(alertDoc, alertMsg);
  broadcastWebSocket(alertMsg);
}

// ====================================================================================
// BUTTON HANDLING (with debouncing)
// ====================================================================================

void checkButtons() {
  int buttons[4] = {BTN_1, BTN_2, BTN_3, BTN_4};

  for (int i = 0; i < 4; i++) {
    int reading = digitalRead(buttons[i]);

    if (reading != btnLastState[i]) {
      btnLastDebounce[i] = millis();
    }

    if ((millis() - btnLastDebounce[i]) > DEBOUNCE_DELAY) {
      if (reading != btnState[i]) {
        btnState[i] = reading;

        if (btnState[i] == LOW) { // Button pressed (active low with pull-up)
          handleButtonPress(i + 1);
        }
      }
    }

    btnLastState[i] = reading;
  }
}

void handleButtonPress(int buttonNum) {
  Serial.printf("[Button] Button %d pressed\n", buttonNum);

  // Button 1: Confirm medication
  if (buttonNum == 1 && medicationAlertActive) {
    // Same as API confirm
    medicationAlertActive = false;
    digitalWrite(BUZZER, LOW);
    digitalWrite(LED_RED, LOW);

    for (int i = 0; i < 3; i++) {
      digitalWrite(LED_GREEN, HIGH);
      delay(100);
      digitalWrite(LED_GREEN, LOW);
      delay(100);
    }

    lcd.clear();
    lcd.setCursor(0, 1);
    lcd.print("   CONFIRMED! :)");
    delay(2000);
    displayIPAddress();

    broadcastWebSocket("{\"type\":\"medication_confirmed\"}");
  }

  // Other buttons can be programmed for different functions
}

// ====================================================================================
// END OF CODE
// ====================================================================================
