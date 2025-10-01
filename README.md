# 🏥 MediCare Assistant - Intelligent Elderly Care & Medication System

![ESP32](https://img.shields.io/badge/ESP32-Enabled-blue)
![Netlify](https://img.shields.io/badge/Netlify-Deployed-00C7B7)

An **AI-powered IoT medication management system** combining **Google Gemini AI** with **ESP32 hardware**.

🌐 **Live:** [https://medicare-assistant.netlify.app/](https://medicare-assistant.netlify.app/)

---

## ✨ Key Features

- 🤖 **Google Gemini AI** - Prescription scanning, health chatbot
- 🔌 **ESP32 IoT** - 20x4 LCD, LEDs, buzzer, buttons
- 💊 **Smart Reminders** - Visual, audio, push notifications
- 📱 **PWA** - Works on all devices, offline support
- 👨‍👩‍👧‍👦 **Family Portal** - Remote monitoring
- 📊 **Analytics** - Adherence tracking, reports

---

## 🏗️ Architecture

**Separated Architecture (NEW)**

```
Netlify (Website) ←→ REST API + WebSocket ←→ ESP32 (Hardware)
  Unlimited Size        http://IP:80            246KB Memory
  Fast Loading          ws://IP:81              274KB Free
```

**Before:** 450KB (86% - CRITICAL ❌)
**After:** 246KB (47% - HEALTHY ✅)
**Freed:** 204KB for new features

---

## 🚀 Quick Start

### 1. Deploy Website
```powershell
git clone https://github.com/HorizonHnk/-Intelligent-Elderly-Care-Medication-Assistant.git
cd -Intelligent-Elderly-Care-Medication-Assistant
.\SEPARATE_FILES.ps1
git push origin main
```

### 2. Upload ESP32
- Open `arduino/medicare_esp32_api/medicare_esp32_api.ino`
- Update WiFi credentials (lines 20-21)
- Upload to ESP32 (Arduino IDE)

### 3. Connect
- Open https://medicare-assistant.netlify.app/
- Enter ESP32 IP address
- Click "Connect"

**Full Guide:** `IMPLEMENTATION_GUIDE.md`

---

## 🔧 Hardware

- ESP32 DevKit V1
- 20x4 LCD I2C (0x27)
- 3× LEDs (Red/Green/Blue)
- Active Buzzer
- 4× Buttons
- Potentiometer

**Wiring:** `docs/HARDWARE_SETUP.md`

---

## 📡 API

```
GET  /api/status
GET  /api/medications
POST /api/medications
POST /api/confirm
POST /api/scan-document
```

**Docs:** `docs/API_DOCUMENTATION.md`

---

## 📚 Documentation

- 📘 **Implementation Guide** - `IMPLEMENTATION_GUIDE.md`
- 🚀 **Quick Start** - `QUICKSTART.md`
- 💻 **Commands** - `COMMANDS.txt`
- 🔌 **Hardware** - `docs/HARDWARE_SETUP.md`
- 📡 **API** - `docs/API_DOCUMENTATION.md`

---

## 🐛 Troubleshooting

**Website can't connect?**
- Check same WiFi network
- Verify IP on LCD display
- Try `http://[IP]/api/status` in browser

**ESP32 won't compile?**
- Tools → Partition Scheme → "Minimal SPIFFS"
- Update ESP32 board package
- Reinstall libraries

---

## 📊 Performance

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Memory | 450KB (86%) | 246KB (47%) | +204KB freed |
| Deploy Time | 3 min | 60 sec | 3x faster |
| Loading | 3-5 sec | <2 sec | 2.5x faster |

---

## 🤝 Contributing

1. Fork repository
2. Create feature branch
3. Commit changes
4. Push and create PR

---

## 📄 License

MIT License

---

## 👥 Author

**Horizon** - [HorizonHnk](https://github.com/HorizonHnk)

---

**Built with ❤️ for elderly care in South Africa**
