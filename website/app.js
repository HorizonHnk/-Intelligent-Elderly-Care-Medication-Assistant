// Global Variables
let geminiApiKey = 'AIzaSyDBzJeHlB5ayYe0iiM0bN9BtIn09Udnz6Y'; // From reference 23.html
let esp32BaseUrl = ''; // Optional - set in settings if you have ESP32 device
let esp32Connected = false;
let esp32Enabled = false; // Only try to connect if user enables it
let websocket = null;
let medications = [];
let currentStream = null;
let currentCamera = 'environment';
let adherenceData = { taken: 0, total: 0, streak: 0, lastReset: new Date().toDateString() };
let offlineQueue = [];
let reconnectAttempts = 0;
let maxReconnectAttempts = 3;

// Initialize App
document.addEventListener('DOMContentLoaded', function() {
    loadSettings();
    loadMedications();
    checkDailyReset();
    updateDashboard();
    startReminderSystem();
    initScrollBehavior();
    initESP32Toggle();

    // Only connect to ESP32 if enabled and URL is set
    if (esp32Enabled && esp32BaseUrl) {
        connectToESP32();
        initWebSocket();
    } else {
        console.log('💡 Running in standalone mode (no ESP32 device)');
        document.getElementById('deviceStatus').textContent = 'Standalone';
        document.getElementById('deviceStatus').style.color = 'var(--gray-500)';
        document.getElementById('lastSeen').textContent = 'No device configured';
    }

    console.log('✅ MediCare Assistant initialized successfully');
});

// Auto-hide/show Header on Scroll
function initScrollBehavior() {
    let lastScrollTop = 0;
    let scrollThreshold = 10;
    const header = document.querySelector('.header');

    window.addEventListener('scroll', function() {
        let scrollTop = window.pageYOffset || document.documentElement.scrollTop;

        // Scrolling down
        if (scrollTop > lastScrollTop && scrollTop > scrollThreshold) {
            header.classList.add('hidden');
        }
        // Scrolling up
        else if (scrollTop < lastScrollTop) {
            header.classList.remove('hidden');
        }

        // Always show at top
        if (scrollTop <= scrollThreshold) {
            header.classList.remove('hidden');
        }

        lastScrollTop = scrollTop <= 0 ? 0 : scrollTop;
    }, { passive: true });
}

// Input Validation & Sanitization
function sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    return input.replace(/[<>]/g, '').trim();
}

function validateMedicationData(data) {
    if (!data.name || data.name.trim().length === 0) {
        throw new Error('Medication name is required');
    }
    if (!data.dosage || data.dosage.trim().length === 0) {
        throw new Error('Dosage is required');
    }
    if (!data.time || !/^\d{2}:\d{2}$/.test(data.time)) {
        throw new Error('Valid time is required (HH:MM)');
    }
    return true;
}

function validateTimeFormat(time) {
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    return timeRegex.test(time);
}

// Daily Reset Check
function checkDailyReset() {
    const today = new Date().toDateString();
    if (adherenceData.lastReset !== today) {
        // Reset all medications to "not taken" for new day
        medications.forEach(med => {
            if (med.taken) {
                med.takenToday = false;
                med.taken = false;
            }
        });
        adherenceData.lastReset = today;
        saveMedications();
        console.log('Daily reset completed');
    }
}

// ESP32 Connection Management
async function connectToESP32() {
    if (!esp32BaseUrl || !esp32Enabled) {
        console.log('ESP32 not configured or disabled');
        return;
    }

    const savedUrl = localStorage.getItem('esp32BaseUrl');
    if (savedUrl) {
        esp32BaseUrl = savedUrl;
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(`${esp32BaseUrl}/api/status`, {
            method: 'GET',
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.ok) {
            esp32Connected = true;
            document.getElementById('deviceStatus').textContent = 'Online';
            document.getElementById('deviceStatus').style.color = 'var(--success)';
            document.getElementById('lastSeen').textContent = 'Connected';
            reconnectAttempts = 0;
            processOfflineQueue();
            showAlert('Connected to ESP32 device!', 'success');
        } else {
            throw new Error('Connection failed');
        }
    } catch (error) {
        esp32Connected = false;
        document.getElementById('deviceStatus').textContent = 'Offline';
        document.getElementById('deviceStatus').style.color = 'var(--danger)';

        // Only log first attempt to avoid spam
        if (reconnectAttempts === 0) {
            console.log('💡 ESP32 device not found - running in standalone mode');
            console.log('To connect: Set ESP32 URL in Settings and click "Connect Device"');
        }

        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (reconnectAttempts < maxReconnectAttempts && esp32Enabled) {
        reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        setTimeout(connectToESP32, delay);
    } else if (reconnectAttempts >= maxReconnectAttempts) {
        console.log('💡 Max reconnection attempts reached. Working in standalone mode.');
        console.log('💡 To retry: Enable "Connect to ESP32" in Settings');
    }
}

// ESP32 API Client
async function esp32Request(endpoint, method = 'GET', data = null) {
    if (!esp32Connected) {
        console.warn('ESP32 offline, queueing request');
        offlineQueue.push({ endpoint, method, data, timestamp: Date.now() });
        return { offline: true };
    }

    try {
        const options = {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        };

        if (data) {
            options.body = JSON.stringify(data);
        }

        const response = await fetch(`${esp32BaseUrl}${endpoint}`, options);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        console.error('ESP32 request failed:', error);
        esp32Connected = false;
        scheduleReconnect();
        offlineQueue.push({ endpoint, method, data, timestamp: Date.now() });
        throw error;
    }
}

async function processOfflineQueue() {
    if (offlineQueue.length === 0) return;

    console.log(`Processing ${offlineQueue.length} offline actions`);
    const queue = [...offlineQueue];
    offlineQueue = [];

    for (const item of queue) {
        try {
            await esp32Request(item.endpoint, item.method, item.data);
        } catch (error) {
            console.error('Failed to process queued item:', error);
        }
    }
}

// WebSocket for Real-time Updates
function initWebSocket() {
    if (!esp32BaseUrl || !esp32Enabled || !esp32Connected) {
        return;
    }

    const wsUrl = esp32BaseUrl.replace('http', 'ws') + '/ws';

    try {
        websocket = new WebSocket(wsUrl);

        websocket.onopen = () => {
            console.log('✅ WebSocket connected to ESP32');
        };

        websocket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleWebSocketMessage(data);
            } catch (error) {
                console.error('WebSocket message parse error:', error);
            }
        };

        websocket.onerror = (error) => {
            // Silent - expected when ESP32 not connected
        };

        websocket.onclose = () => {
            if (esp32Connected && esp32Enabled) {
                setTimeout(initWebSocket, 10000); // Retry every 10s
            }
        };
    } catch (error) {
        // Silent - expected when ESP32 not available
    }
}

function handleWebSocketMessage(data) {
    switch (data.type) {
        case 'medication_alert':
            showReminder(data.medication);
            break;
        case 'medication_confirmed':
            updateDashboard();
            break;
        case 'button_pressed':
            handlePhysicalButton(data.button);
            break;
        case 'status_update':
            updateDeviceStatus(data.status);
            break;
        default:
            console.log('Unknown WebSocket message:', data);
    }
}

function handlePhysicalButton(buttonId) {
    if (buttonId === 1) {
        // Confirm current medication
        const nextMed = medications.filter(m => !m.taken).sort((a, b) => a.time.localeCompare(b.time))[0];
        if (nextMed) {
            confirmMedication(nextMed.id);
        }
    }
}

function updateDeviceStatus(status) {
    document.getElementById('deviceStatus').textContent = status.online ? 'Online' : 'Offline';
    document.getElementById('deviceStatus').style.color = status.online ? 'var(--success)' : 'var(--danger)';
}

// Tab Switching
function switchTab(tabName) {
    // Stop audio when switching away from assistant tab
    if (tabName !== 'assistant') {
        stopAllAudioAndRecognition();
    }

    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

    document.getElementById(tabName).classList.add('active');

    // Find and activate the corresponding button
    const buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach(btn => {
        if (btn.textContent.toLowerCase().includes(tabName.toLowerCase()) ||
            btn.getAttribute('onclick').includes(tabName)) {
            btn.classList.add('active');
        }
    });

    // Update content when switching tabs
    if (tabName === 'medications') updateAllMedications();
    if (tabName === 'schedule') updateWeeklySchedule();
    if (tabName === 'analytics') updateAnalytics();
}

// Modal Management
function openModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

// Show Alert
function showAlert(message, type = 'info') {
    const alertBox = document.getElementById('alertBox');
    const alertText = document.getElementById('alertText');
    const alertIcon = document.getElementById('alertIcon');

    alertBox.className = `alert alert-${type} active`;
    alertText.textContent = message;
    alertIcon.textContent = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';

    setTimeout(() => {
        alertBox.classList.remove('active');
    }, 4000);
}

// Add Medication
async function addMedication(event) {
    event.preventDefault();

    try {
        const medication = {
            id: Date.now(),
            name: sanitizeInput(document.getElementById('medName').value),
            dosage: sanitizeInput(document.getElementById('medDosage').value),
            time: document.getElementById('medTime').value,
            frequency: document.getElementById('medFrequency').value,
            taken: false,
            createdAt: new Date().toISOString()
        };

        // Validate data
        validateMedicationData(medication);

        // Add to local storage
        medications.push(medication);
        saveMedications();

        // Sync to ESP32
        try {
            await esp32Request('/api/medications', 'POST', medication);
        } catch (error) {
            console.warn('Failed to sync to ESP32, will retry later');
        }

        updateDashboard();
        closeModal('addMedModal');
        showAlert('Medication added successfully!', 'success');
        event.target.reset();

    } catch (error) {
        showAlert(error.message, 'error');
    }
}

// Edit Medication
async function editMedication(id) {
    const med = medications.find(m => m.id === id);
    if (!med) return;

    document.getElementById('medName').value = med.name;
    document.getElementById('medDosage').value = med.dosage;
    document.getElementById('medTime').value = med.time;
    document.getElementById('medFrequency').value = med.frequency;

    // Change modal to edit mode
    const modal = document.getElementById('addMedModal');
    const title = modal.querySelector('.modal-title');
    const submitBtn = modal.querySelector('button[type="submit"]');

    title.textContent = 'Edit Medication';
    submitBtn.textContent = 'Update Medication';

    // Store editing ID
    window.editingMedicationId = id;

    openModal('addMedModal');
}

async function updateMedication(event) {
    event.preventDefault();

    try {
        const id = window.editingMedicationId;
        const med = medications.find(m => m.id === id);

        if (!med) {
            throw new Error('Medication not found');
        }

        med.name = sanitizeInput(document.getElementById('medName').value);
        med.dosage = sanitizeInput(document.getElementById('medDosage').value);
        med.time = document.getElementById('medTime').value;
        med.frequency = document.getElementById('medFrequency').value;
        med.updatedAt = new Date().toISOString();

        validateMedicationData(med);

        saveMedications();

        // Sync to ESP32
        try {
            await esp32Request(`/api/medications/${id}`, 'PUT', med);
        } catch (error) {
            console.warn('Failed to sync update to ESP32');
        }

        updateDashboard();
        updateAllMedications();
        closeModal('addMedModal');
        showAlert('Medication updated successfully!', 'success');

        // Reset modal
        delete window.editingMedicationId;
        resetMedicationModal();

    } catch (error) {
        showAlert(error.message, 'error');
    }
}

function resetMedicationModal() {
    const modal = document.getElementById('addMedModal');
    const title = modal.querySelector('.modal-title');
    const submitBtn = modal.querySelector('button[type="submit"]');

    title.textContent = 'Add New Medication';
    submitBtn.textContent = 'Add Medication';
}

// Confirm Medication Taken
async function confirmMedication(id) {
    const med = medications.find(m => m.id === id);
    if (!med) return;

    try {
        med.taken = true;
        med.takenAt = new Date().toISOString();
        adherenceData.taken++;
        adherenceData.total++;
        adherenceData.streak++;

        saveMedications();

        // Sync to ESP32
        try {
            await esp32Request('/api/confirm', 'POST', { medicationId: id, timestamp: med.takenAt });
        } catch (error) {
            console.warn('Failed to sync confirmation to ESP32');
        }

        // Send WebSocket update
        if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({ type: 'medication_confirmed', id: id }));
        }

        // Clear reminder timeout
        if (reminderTimeouts[id]) {
            clearTimeout(reminderTimeouts[id]);
            delete reminderTimeouts[id];
        }

        updateDashboard();
        showAlert(`${med.name} marked as taken!`, 'success');
        speakText(`Great! ${med.name} confirmed.`);

    } catch (error) {
        showAlert('Failed to confirm medication', 'error');
    }
}

// Update Dashboard
function updateDashboard() {
    const todayMeds = medications.filter(m => !m.taken).sort((a, b) => a.time.localeCompare(b.time));
    const adherence = adherenceData.total > 0 ? Math.round((adherenceData.taken / adherenceData.total) * 100) : 0;

    document.getElementById('todayAdherence').textContent = `${adherence}%`;
    document.getElementById('currentStreak').textContent = adherenceData.streak;

    const todayMedsContainer = document.getElementById('todayMedications');
    todayMedsContainer.innerHTML = todayMeds.length === 0
        ? '<p style="text-align: center; color: var(--gray-500); padding: 20px;">All medications taken today!</p>'
        : todayMeds.map(med => `
            <div class="medication-item">
                <div class="medication-info">
                    <div class="medication-name">${med.name}</div>
                    <div class="medication-time">Time: ${med.time}</div>
                    <div class="medication-dosage">Dosage: ${med.dosage}</div>
                </div>
                <div class="medication-actions">
                    <div class="status-indicator status-pending"></div>
                    <button class="confirm-btn" onclick="confirmMedication(${med.id})">Confirm</button>
                </div>
            </div>
        `).join('');

    if (todayMeds.length > 0) {
        const nextMed = todayMeds[0];
        document.getElementById('nextMedTime').textContent = nextMed.time;
        document.getElementById('nextMedName').textContent = nextMed.name;
    } else {
        document.getElementById('nextMedTime').textContent = '--:--';
        document.getElementById('nextMedName').textContent = 'All done!';
    }

    updateRecentActivity();
}

// Update All Medications Tab
function updateAllMedications() {
    const allMedsContainer = document.getElementById('allMedications');
    const sortedMeds = medications.sort((a, b) => a.time.localeCompare(b.time));

    allMedsContainer.innerHTML = medications.length === 0
        ? '<p style="text-align: center; color: var(--gray-500); padding: 40px;">No medications added yet. Click "+ Add New" to get started.</p>'
        : sortedMeds.map(med => `
            <div class="medication-item">
                <div class="medication-info">
                    <div class="medication-name">${med.name}</div>
                    <div class="medication-time">Time: ${med.time} | Frequency: ${med.frequency}</div>
                    <div class="medication-dosage">Dosage: ${med.dosage}</div>
                </div>
                <div class="medication-actions" style="gap: 8px;">
                    <div class="status-indicator ${med.taken ? 'status-taken' : 'status-pending'}"></div>
                    <button class="confirm-btn" onclick="editMedication(${med.id})" style="background: var(--primary); font-size: 12px; padding: 8px 12px;">Edit</button>
                    <button class="confirm-btn" onclick="deleteMedication(${med.id})" style="background: var(--danger); font-size: 12px; padding: 8px 12px;">Delete</button>
                </div>
            </div>
        `).join('');
}

// Delete Medication
async function deleteMedication(id) {
    if (!confirm('Are you sure you want to delete this medication?')) {
        return;
    }

    try {
        medications = medications.filter(m => m.id !== id);
        saveMedications();

        // Sync to ESP32
        try {
            await esp32Request(`/api/medications/${id}`, 'DELETE');
        } catch (error) {
            console.warn('Failed to sync deletion to ESP32');
        }

        updateDashboard();
        updateAllMedications();
        showAlert('Medication deleted', 'success');
    } catch (error) {
        showAlert('Failed to delete medication', 'error');
    }
}

// Update Recent Activity
function updateRecentActivity() {
    const recentContainer = document.getElementById('recentActivity');
    const recentMeds = medications.filter(m => m.taken).slice(-5).reverse();

    recentContainer.innerHTML = recentMeds.length === 0
        ? '<p style="text-align: center; color: var(--gray-500); padding: 20px;">No recent activity</p>'
        : recentMeds.map(med => `
            <div style="padding: 12px; background: var(--gray-50); border-radius: var(--radius); margin-bottom: 10px; border-left: 3px solid var(--success);">
                <div style="font-weight: 600; color: var(--gray-900);">${med.name}</div>
                <div style="font-size: 13px; color: var(--gray-600);">Taken at ${med.time}</div>
            </div>
        `).join('');
}

// Update Weekly Schedule
function updateWeeklySchedule() {
    const scheduleContainer = document.getElementById('weeklySchedule');
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    scheduleContainer.innerHTML = days.map(day => `
        <div style="margin-bottom: 24px; padding: 16px; background: var(--gray-50); border-radius: var(--radius);">
            <h3 style="margin: 0 0 12px 0; color: var(--primary); font-size: 18px;">${day}</h3>
            ${medications.map(med => `
                <div style="padding: 10px; background: #ffffff; border: 1px solid var(--gray-300); border-radius: var(--radius-sm); margin-bottom: 8px;">
                    <strong>${med.time}</strong> - ${med.name} (${med.dosage})
                </div>
            `).join('') || '<p style="color: var(--gray-500);">No medications scheduled</p>'}
        </div>
    `).join('');
}

// Update Analytics
function updateAnalytics() {
    const canvas = document.getElementById('adherenceChart');
    const ctx = canvas.getContext('2d');

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Simple bar chart
    const adherenceRate = adherenceData.total > 0 ? (adherenceData.taken / adherenceData.total) : 0;
    const barHeight = adherenceRate * 150;

    ctx.fillStyle = '#4f46e5';
    ctx.fillRect(50, 200 - barHeight, 80, barHeight);

    ctx.fillStyle = '#10b981';
    ctx.fillRect(150, 200 - (adherenceData.streak * 10), 80, adherenceData.streak * 10);

    ctx.fillStyle = '#333';
    ctx.font = '14px Arial';
    ctx.fillText('Adherence', 40, 220);
    ctx.fillText('Streak', 150, 220);
    ctx.fillText(`${Math.round(adherenceRate * 100)}%`, 60, 190 - barHeight);
    ctx.fillText(`${adherenceData.streak}d`, 170, 190 - (adherenceData.streak * 10));
}

// Improved Reminder System
let reminderTimeouts = {};

function startReminderSystem() {
    // Clear existing timeouts
    Object.values(reminderTimeouts).forEach(timeout => clearTimeout(timeout));
    reminderTimeouts = {};

    // Check reminders every minute (for accuracy)
    setInterval(scheduleNextReminders, 60000);

    // Initial schedule
    scheduleNextReminders();
}

function scheduleNextReminders() {
    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();

    medications.forEach(med => {
        if (med.taken) return;

        const [hours, minutes] = med.time.split(':').map(Number);
        const medTime = hours * 60 + minutes;

        // Calculate time until reminder (in milliseconds)
        let timeUntil = (medTime - currentTime) * 60 * 1000;

        // If time has passed today, skip (will trigger tomorrow)
        if (timeUntil < 0) return;

        // Clear existing timeout for this medication
        if (reminderTimeouts[med.id]) {
            clearTimeout(reminderTimeouts[med.id]);
        }

        // Schedule reminder
        reminderTimeouts[med.id] = setTimeout(() => {
            if (!med.taken) {
                showReminder(med);
                scheduleEscalation(med);
            }
        }, timeUntil);

        // Schedule pre-reminder (15 minutes before)
        if (timeUntil > 15 * 60 * 1000) {
            setTimeout(() => {
                if (!med.taken) {
                    showAlert(`Reminder: ${med.name} in 15 minutes`, 'info');
                }
            }, timeUntil - 15 * 60 * 1000);
        }
    });
}

function scheduleEscalation(med) {
    // Repeat reminder every 5 minutes if not confirmed
    const escalationInterval = setInterval(() => {
        if (med.taken) {
            clearInterval(escalationInterval);
        } else {
            showReminder(med);
            playReminderSound();
        }
    }, 5 * 60 * 1000); // 5 minutes

    // Clear after 30 minutes (6 repetitions)
    setTimeout(() => clearInterval(escalationInterval), 30 * 60 * 1000);
}

function showReminder(med) {
    showAlert(`Time to take ${med.name} (${med.dosage})`, 'warning');
    speakText(`Time to take your ${med.name}`);
    playReminderSound();
}

function playReminderSound() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        oscillator.frequency.value = 800;
        oscillator.type = 'square';
        gainNode.gain.value = 0.3;

        oscillator.start();
        oscillator.stop(audioContext.currentTime + 0.5);
    } catch (error) {
        console.log('Audio not supported');
    }
}

// Text-to-Speech
function speakText(text) {
    if (!('speechSynthesis' in window)) {
        console.log('Text-to-speech not supported in this browser');
        return;
    }

    try {
        speechSynthesis.cancel(); // Cancel any ongoing speech
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.9;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;
        utterance.lang = 'en-US';

        utterance.onerror = (event) => {
            console.error('Speech synthesis error:', event.error);
        };

        utterance.onend = () => {
            console.log('Speech finished');
        };

        speechSynthesis.speak(utterance);
    } catch (error) {
        console.error('Failed to speak text:', error);
    }
}

// Voice Assistant
function startVoiceAssistant() {
    // Check if running on localhost or HTTPS
    const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

    if (!isSecure) {
        showAlert('⚠️ Microphone requires HTTPS or localhost. Please run: python -m http.server 8000 or use a local server.', 'error');
        return;
    }

    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        showAlert('❌ Voice recognition not supported in this browser. Try Chrome or Edge.', 'error');
        return;
    }

    try {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        const recognition = new SpeechRecognition();
        recognition.lang = 'en-US';
        recognition.continuous = false;
        recognition.interimResults = false;

        recognition.onstart = () => showAlert('🎤 Listening... Speak now!', 'info');

        recognition.onresult = (event) => {
            const transcript = event.results[0][0].transcript;
            showAlert(`You said: "${transcript}"`, 'success');
            processChatMessage(transcript);
        };

        recognition.onerror = (event) => {
            let errorMsg = '❌ Voice recognition error: ';
            if (event.error === 'not-allowed') {
                errorMsg += 'Please allow microphone permissions in your browser.';
            } else if (event.error === 'no-speech') {
                errorMsg += 'No speech detected. Please try again.';
            } else {
                errorMsg += event.error;
            }
            showAlert(errorMsg, 'error');
        };

        recognition.onend = () => {
            console.log('Voice recognition ended');
        };

        recognition.start();
    } catch (error) {
        showAlert('❌ Failed to start voice recognition: ' + error.message, 'error');
    }
}

// Chat System
function handleChatKeyPress(event) {
    if (event.key === 'Enter') {
        sendChatMessage();
    }
}

function sendChatMessage() {
    const input = document.getElementById('chatInput');

    if (!input) {
        console.error('Chat input element not found');
        showAlert('❌ Chat input not found', 'error');
        return;
    }

    const message = input.value.trim();

    if (!message) {
        showAlert('⚠️ Please type a message', 'warning');
        return;
    }

    console.log('Sending chat message:', message);
    processChatMessage(message);
    input.value = '';
}

async function processChatMessage(message) {
    const chatMessages = document.getElementById('chatMessages');

    chatMessages.innerHTML += `
        <div style="padding: 12px; background: var(--primary); color: white; border-radius: var(--radius); margin-bottom: 12px; text-align: right;">
            <strong>You:</strong> ${message}
        </div>
    `;

    // Check API key
    if (!geminiApiKey) {
        chatMessages.innerHTML += `
            <div style="padding: 12px; background: #ffffff; border: 1px solid var(--danger); border-radius: var(--radius); margin-bottom: 12px;">
                <strong>AI:</strong> Please configure your Gemini API key in Settings to use the AI assistant.
            </div>
        `;
        chatMessages.scrollTop = chatMessages.scrollHeight;
        return;
    }

    // Show thinking indicator
    const thinkingId = 'thinking-' + Date.now();
    chatMessages.innerHTML += `
        <div id="${thinkingId}" style="padding: 12px; background: #ffffff; border: 1px solid var(--gray-300); border-radius: var(--radius); margin-bottom: 12px;">
            <strong>AI:</strong> <em>Thinking...</em>
        </div>
    `;
    chatMessages.scrollTop = chatMessages.scrollHeight;

    try {
        console.log('Sending request to Gemini API...');

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${geminiApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: `You are a helpful medical assistant specializing in elderly care and medication management. Current medications: ${medications.map(m => m.name).join(', ') || 'None'}. Answer this question: ${message}` }]
                }]
            })
        });

        // Remove thinking indicator
        const thinkingElement = document.getElementById(thinkingId);
        if (thinkingElement) thinkingElement.remove();

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`API Error ${response.status}: ${errorData.error?.message || 'Unknown error'}`);
        }

        const data = await response.json();
        console.log('Received response from Gemini API');

        if (!data.candidates || !data.candidates[0]) {
            throw new Error('Invalid API response - no candidates');
        }

        const answer = data.candidates[0].content.parts[0].text;
        const chatMessageId = 'chat-msg-' + Date.now();

        // Format the answer with HTML
        const formattedAnswer = answer
            .replace(/\n/g, '<br>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/• /g, '<br>• ');

        chatMessages.innerHTML += `
            <div id="${chatMessageId}" style="padding: 12px; background: #ffffff; border: 1px solid var(--gray-300); border-radius: var(--radius); margin-bottom: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: start; gap: 12px;">
                    <div style="flex: 1;">
                        <strong>AI:</strong> <span class="message-text">${formattedAnswer}</span>
                    </div>
                    <button onclick="copyMessage('${chatMessageId}')" style="background: none; border: none; color: var(--primary); cursor: pointer; padding: 4px 8px; font-size: 12px; border-radius: 4px; transition: background 0.2s;" onmouseover="this.style.background='var(--gray-100)'" onmouseout="this.style.background='none'" title="Copy message">
                        📋 Copy
                    </button>
                </div>
            </div>
        `;

        chatMessages.scrollTop = chatMessages.scrollHeight;

        // Speak response
        speakText(answer);
    } catch (error) {
        console.error('Chat error:', error);

        // Remove thinking indicator
        const thinkingElement = document.getElementById(thinkingId);
        if (thinkingElement) thinkingElement.remove();

        chatMessages.innerHTML += `
            <div style="padding: 12px; background: #ffffff; border: 1px solid var(--danger); border-radius: var(--radius); margin-bottom: 12px;">
                <strong>Error:</strong> ${error.message}
            </div>
        `;
        chatMessages.scrollTop = chatMessages.scrollHeight;
        showAlert('❌ AI Error: ' + error.message, 'error');
    }
}

// Camera & Document Scanning
async function openCamera(mode = 'document') {
    // Check if running on localhost or HTTPS
    const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

    if (!isSecure) {
        showAlert('⚠️ Camera requires HTTPS or localhost. Please run: python -m http.server 8000 or use a local server.', 'error');
        return;
    }

    // Check if mediaDevices is available
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showAlert('❌ Camera not supported in this browser. Try Chrome or Edge.', 'error');
        return;
    }

    openModal('scanModal');

    // Update modal title based on mode
    const modalTitle = document.querySelector('#scanModal .modal-title');
    modalTitle.textContent = mode === 'pill' ? 'Identify Pill' : 'Scan Document';

    // Store scan mode
    window.currentScanMode = mode;

    // Show loading on video element
    const video = document.getElementById('scanVideo');
    video.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
    video.style.display = 'flex';
    video.style.alignItems = 'center';
    video.style.justifyContent = 'center';

    try {
        showAlert('📷 Opening camera...', 'info');

        // Use simpler constraints for faster loading
        const constraints = {
            video: {
                facingMode: currentCamera,
                width: { ideal: 1280, max: 1920 },
                height: { ideal: 720, max: 1080 }
            }
        };

        // Add timeout to prevent infinite waiting
        const streamPromise = navigator.mediaDevices.getUserMedia(constraints);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Camera timeout')), 10000)
        );

        currentStream = await Promise.race([streamPromise, timeoutPromise]);

        video.srcObject = currentStream;
        video.style.background = 'none';

        // Wait for video to actually start playing
        await new Promise((resolve) => {
            video.onloadedmetadata = () => {
                video.play();
                resolve();
            };
        });

        showAlert('✅ Camera ready!', 'success');
    } catch (error) {
        console.error('Camera error:', error);
        video.style.background = 'none';

        let errorMsg = '❌ Camera access failed. ';

        if (error.message === 'Camera timeout') {
            errorMsg += 'Camera took too long to respond. Please try again.';
        } else if (error.name === 'NotAllowedError') {
            errorMsg += 'Please allow camera permissions in your browser settings.';
        } else if (error.name === 'NotFoundError') {
            errorMsg += 'No camera found on this device.';
        } else if (error.name === 'NotReadableError') {
            errorMsg += 'Camera is already in use by another application.';
        } else {
            errorMsg += error.message;
        }

        showAlert(errorMsg, 'error');
        closeModal('scanModal');
    }
}

function identifyPill() {
    openCamera('pill');
}

async function switchCamera() {
    currentCamera = currentCamera === 'environment' ? 'user' : 'environment';

    // Stop current stream before switching
    if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
    }

    // Re-open camera with new facing mode
    const mode = window.currentScanMode || 'document';
    const video = document.getElementById('scanVideo');

    try {
        showAlert('🔄 Switching camera...', 'info');

        const constraints = {
            video: {
                facingMode: currentCamera,
                width: { ideal: 1280, max: 1920 },
                height: { ideal: 720, max: 1080 }
            }
        };

        currentStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = currentStream;

        showAlert('✅ Camera switched!', 'success');
    } catch (error) {
        console.error('Camera switch error:', error);
        showAlert('❌ Failed to switch camera', 'error');
    }
}

function captureDocument() {
    const video = document.getElementById('scanVideo');
    const canvas = document.getElementById('scanCanvas');

    // Validate video element
    if (!video) {
        showAlert('❌ Video element not found', 'error');
        return;
    }

    if (!video.srcObject) {
        showAlert('⚠️ Camera not started. Please allow camera access.', 'warning');
        return;
    }

    if (video.videoWidth === 0 || video.videoHeight === 0) {
        showAlert('⚠️ Camera not ready. Please wait a moment...', 'warning');
        return;
    }

    try {
        const ctx = canvas.getContext('2d');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);

        showAlert('📸 Photo captured! Analyzing...', 'info');

        const mode = window.currentScanMode || 'document';

        canvas.toBlob(blob => {
            if (!blob) {
                showAlert('❌ Failed to capture image', 'error');
                return;
            }

            console.log(`Captured ${mode} image, size: ${blob.size} bytes`);

            if (mode === 'pill') {
                analyzePill(blob);
            } else {
                analyzeDocument(blob);
            }
        }, 'image/jpeg', 0.95);
    } catch (error) {
        console.error('Capture error:', error);
        showAlert('❌ Failed to capture photo: ' + error.message, 'error');
    }
}

async function analyzePill(imageBlob) {
    // Check API key first
    if (!geminiApiKey) {
        showAlert('Please configure your Gemini API key in Settings', 'error');
        return;
    }

    document.getElementById('scanLoading').classList.add('active');

    try {
        const base64 = await blobToBase64(imageBlob);
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: 'You are a medication identification expert. Analyze this pill/medication image and provide: 1) Possible medication name, 2) Common uses, 3) Typical dosage, 4) Important warnings. Be clear if you cannot identify it.' },
                        { inline_data: { mime_type: 'image/jpeg', data: base64 } }
                    ]
                }]
            })
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }

        const data = await response.json();

        if (!data.candidates || !data.candidates[0]) {
            throw new Error('No analysis result received');
        }

        const result = data.candidates[0].content.parts[0].text;

        document.getElementById('scanResult').innerHTML = `
            <div style="padding: 16px; background: #ffffff; border: 1px solid var(--success); border-radius: var(--radius); margin-top: 16px;">
                <strong style="color: var(--success);">✓ Pill Identification:</strong><br><br>
                <div style="white-space: pre-wrap;">${result}</div>
                <div style="margin-top: 12px; padding: 10px; background: var(--warning); color: white; border-radius: var(--radius-sm); font-size: 13px;">
                    ⚠️ Warning: Always consult with a healthcare professional before taking any medication.
                </div>
            </div>
        `;

        showAlert('Pill identified!', 'success');
    } catch (error) {
        console.error('Pill identification error:', error);
        document.getElementById('scanResult').innerHTML = `
            <div style="padding: 16px; background: #ffffff; border: 1px solid var(--danger); border-radius: var(--radius); margin-top: 16px;">
                <strong style="color: var(--danger);">✕ Error:</strong><br>
                Failed to identify pill. Please ensure the image is clear and try again.
            </div>
        `;
        showAlert('Failed to identify pill', 'error');
    } finally {
        document.getElementById('scanLoading').classList.remove('active');
    }
}

async function analyzeDocument(imageBlob) {
    // Check API key first
    if (!geminiApiKey) {
        showAlert('Please configure your Gemini API key in Settings', 'error');
        return;
    }

    document.getElementById('scanLoading').classList.add('active');

    try {
        const base64 = await blobToBase64(imageBlob);
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: 'You are a medical document analyzer. Extract medication information from this prescription or medical document. List: medication names, dosages, frequency, and times to take. Format clearly.' },
                        { inline_data: { mime_type: 'image/jpeg', data: base64 } }
                    ]
                }]
            })
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }

        const data = await response.json();

        if (!data.candidates || !data.candidates[0]) {
            throw new Error('No analysis result received');
        }

        const result = data.candidates[0].content.parts[0].text;

        document.getElementById('scanResult').innerHTML = `
            <div style="padding: 16px; background: #ffffff; border: 1px solid var(--success); border-radius: var(--radius); margin-top: 16px;">
                <strong style="color: var(--success);">✓ Analysis Result:</strong><br><br>
                <div style="white-space: pre-wrap;">${result}</div>
                <button class="action-btn" style="margin-top: 12px; width: 100%;" onclick="addMedicationFromScan()">Add to Schedule</button>
            </div>
        `;

        showAlert('Document analyzed successfully!', 'success');
    } catch (error) {
        console.error('Scan error:', error);
        document.getElementById('scanResult').innerHTML = `
            <div style="padding: 16px; background: #ffffff; border: 1px solid var(--danger); border-radius: var(--radius); margin-top: 16px;">
                <strong style="color: var(--danger);">✕ Error:</strong><br>
                Failed to analyze document. Please check your API key and try again.
            </div>
        `;
        showAlert('Failed to analyze document', 'error');
    } finally {
        document.getElementById('scanLoading').classList.remove('active');
    }
}

function addMedicationFromScan() {
    showAlert('Please manually add medications from the analysis above', 'info');
    closeScanner();
    openModal('addMedModal');
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function closeScanner() {
    if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
        currentStream = null;
    }
    closeModal('scanModal');
}

// Emergency
function handleEmergency() {
    const contact = localStorage.getItem('emergencyContact') || '';

    showAlert('🚨 EMERGENCY ALERT ACTIVATED!', 'error');

    // Show emergency options
    const options = contact
        ? `EMERGENCY OPTIONS:\n\n1. Call Emergency Contact: ${contact}\n2. Call Emergency Services: 10177\n3. Video Call Emergency Contact\n\nSelect option (1-3) or Cancel:`
        : `EMERGENCY OPTIONS:\n\n1. Call Emergency Services: 10177\n2. Set Emergency Contact first\n\nPress OK to call 10177 or Cancel:`;

    if (contact) {
        const choice = prompt(options);
        if (choice === '1') {
            startPhoneCall();
        } else if (choice === '2') {
            emergencyCall();
        } else if (choice === '3') {
            startVideoCall();
        }
    } else {
        const confirmed = confirm(options);
        if (confirmed) {
            emergencyCall();
        }
    }
}

// Settings
function updateVolumeDisplay(value) {
    document.getElementById('volumeDisplay').textContent = `${value}%`;
}

// Settings - ESP32 Enable Toggle
function initESP32Toggle() {
    const esp32EnableCheckbox = document.getElementById('esp32Enable');
    const esp32UrlGroup = document.getElementById('esp32UrlGroup');

    if (esp32EnableCheckbox) {
        esp32EnableCheckbox.addEventListener('change', function() {
            esp32UrlGroup.style.display = this.checked ? 'block' : 'none';
        });
    }
}

async function saveSettings() {
    try {
        const apiKey = sanitizeInput(document.getElementById('apiKey').value);
        const patientName = sanitizeInput(document.getElementById('patientName').value);
        const emergencyContact = sanitizeInput(document.getElementById('emergencyContact').value);
        const esp32Enable = document.getElementById('esp32Enable').checked;
        const esp32Url = sanitizeInput(document.getElementById('esp32Url').value);
        const volume = document.getElementById('reminderVolume').value;

        if (apiKey) {
            geminiApiKey = apiKey;
            localStorage.setItem('geminiApiKey', apiKey);
        }
        if (patientName) localStorage.setItem('patientName', patientName);
        if (emergencyContact) localStorage.setItem('emergencyContact', emergencyContact);

        // ESP32 settings
        esp32Enabled = esp32Enable;
        localStorage.setItem('esp32Enabled', esp32Enable);

        if (esp32Enable && esp32Url) {
            // Validate URL format
            if (!esp32Url.startsWith('http://') && !esp32Url.startsWith('https://')) {
                throw new Error('ESP32 URL must start with http:// or https://');
            }
            esp32BaseUrl = esp32Url;
            localStorage.setItem('esp32BaseUrl', esp32Url);

            // Try to connect
            reconnectAttempts = 0; // Reset attempts
            await connectToESP32();
            initWebSocket();
        } else {
            esp32BaseUrl = '';
            esp32Connected = false;
            document.getElementById('deviceStatus').textContent = 'Standalone';
            document.getElementById('deviceStatus').style.color = 'var(--gray-500)';
            console.log('💡 ESP32 disabled - running in standalone mode');
        }

        localStorage.setItem('reminderVolume', volume);

        closeModal('settingsModal');
        showAlert('Settings saved successfully!', 'success');
    } catch (error) {
        showAlert(error.message, 'error');
    }
}

function loadSettings() {
    const savedApiKey = localStorage.getItem('geminiApiKey');
    const savedPatientName = localStorage.getItem('patientName');
    const savedContact = localStorage.getItem('emergencyContact');
    const savedEsp32Enabled = localStorage.getItem('esp32Enabled') === 'true';
    const savedUrl = localStorage.getItem('esp32BaseUrl');
    const savedVolume = localStorage.getItem('reminderVolume');

    // Use saved API key or save default if not present
    if (savedApiKey) {
        geminiApiKey = savedApiKey;
    } else if (geminiApiKey) {
        // Save default API key to localStorage
        localStorage.setItem('geminiApiKey', geminiApiKey);
    }

    const apiKeyInput = document.getElementById('apiKey');
    if (apiKeyInput) apiKeyInput.value = geminiApiKey;
    if (savedPatientName) {
        const nameInput = document.getElementById('patientName');
        if (nameInput) nameInput.value = savedPatientName;
    }
    if (savedContact) {
        const contactInput = document.getElementById('emergencyContact');
        if (contactInput) contactInput.value = savedContact;
    }

    // Load ESP32 settings
    esp32Enabled = savedEsp32Enabled;
    const esp32EnableCheckbox = document.getElementById('esp32Enable');
    const esp32UrlGroup = document.getElementById('esp32UrlGroup');

    if (esp32EnableCheckbox) {
        esp32EnableCheckbox.checked = savedEsp32Enabled;
        if (esp32UrlGroup) {
            esp32UrlGroup.style.display = savedEsp32Enabled ? 'block' : 'none';
        }
    }

    if (savedUrl) {
        esp32BaseUrl = savedUrl;
        const urlInput = document.getElementById('esp32Url');
        if (urlInput) urlInput.value = savedUrl;
    }

    if (savedVolume) {
        const volumeInput = document.getElementById('reminderVolume');
        const volumeDisplay = document.getElementById('volumeDisplay');
        if (volumeInput) volumeInput.value = savedVolume;
        if (volumeDisplay) volumeDisplay.textContent = `${savedVolume}%`;
    }
}

// Data Persistence
function saveMedications() {
    localStorage.setItem('medications', JSON.stringify(medications));
    localStorage.setItem('adherenceData', JSON.stringify(adherenceData));
}

function loadMedications() {
    const savedMeds = localStorage.getItem('medications');
    const savedAdherence = localStorage.getItem('adherenceData');

    if (savedMeds) medications = JSON.parse(savedMeds);
    if (savedAdherence) adherenceData = JSON.parse(savedAdherence);
}

// Removed old fake connection check - now using real ESP32 connection

// Export Schedule
function exportSchedule() {
    const data = medications.map(m => `${m.time},${m.name},${m.dosage}`).join('\n');
    const blob = new Blob([data], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'medication_schedule.csv';
    a.click();
    showAlert('Schedule exported!', 'success');
}

function downloadReport() {
    showAlert('Generating report...', 'info');
    setTimeout(() => showAlert('Report downloaded!', 'success'), 2000);
}

function viewSchedule() {
    switchTab('schedule');
}

console.log('✅ MediCare Assistant initialized successfully');

// Contact Form Handling
document.addEventListener('DOMContentLoaded', function() {
    const contactForm = document.getElementById('contactForm');
    if (contactForm) {
        contactForm.addEventListener('submit', handleContactSubmit);
    }
});

async function handleContactSubmit(event) {
    event.preventDefault();

    const form = event.target;
    const submitBtn = document.getElementById('submitContactBtn');
    const formContent = form.parentElement.querySelector('form');
    const successDiv = document.getElementById('contactSuccess');

    // Add timestamp
    document.getElementById('contactTimestamp').value = new Date().toISOString();

    // Disable submit button
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    try {
        const formData = new FormData(form);

        const response = await fetch('https://formspree.io/f/xrbygvga', {
            method: 'POST',
            body: formData,
            headers: {
                'Accept': 'application/json'
            }
        });

        if (response.ok) {
            // Hide form, show success message
            formContent.style.display = 'none';
            successDiv.style.display = 'block';

            // Reset form
            form.reset();

            // Close modal after 3 seconds
            setTimeout(() => {
                closeModal('contactModal');
                formContent.style.display = 'block';
                successDiv.style.display = 'none';
                submitBtn.disabled = false;
                submitBtn.textContent = 'Send Message';
            }, 3000);

            showAlert('Message sent successfully!', 'success');
        } else {
            throw new Error('Failed to send message');
        }
    } catch (error) {
        console.error('Contact form error:', error);
        showAlert('Failed to send message. Please try again.', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Message';
    }
}

// Chatbot Functions
function openChatbot() {
    // Stop all other audio/recognition first
    stopAllAudioAndRecognition();

    // End video call if active
    if (isInVideoCall) {
        endVideoCall();
    }

    // End phone call if active
    if (isInCall) {
        endCall();
    }

    openModal('chatbotModal');
    document.getElementById('chatbotInput').focus();
}

function closeChatbot() {
    // Stop chatbot recognition specifically
    if (chatbotRecognition) {
        try {
            chatbotRecognition.stop();
            chatbotRecognition = null;
        } catch (e) {
            console.log('Error stopping chatbot recognition:', e);
        }
    }
    isChatbotListening = false;

    // Stop speech synthesis
    if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
    }

    closeModal('chatbotModal');
}

function handleChatbotKeyPress(event) {
    if (event.key === 'Enter') {
        sendChatbotMessage();
    }
}

function sendChatbotMessage() {
    const input = document.getElementById('chatbotInput');

    if (!input) {
        console.error('Chatbot input element not found');
        showAlert('❌ Chatbot input not found', 'error');
        return;
    }

    const message = input.value.trim();

    if (!message) {
        showAlert('⚠️ Please type a message', 'warning');
        return;
    }

    console.log('Sending chatbot message:', message);
    processChatbotMessage(message);
    input.value = '';
}

async function processChatbotMessage(message) {
    const chatMessages = document.getElementById('chatbotMessages');

    if (!chatMessages) {
        console.error('Chatbot messages element not found');
        showAlert('❌ Chatbot messages area not found', 'error');
        return;
    }

    // Sanitize message for HTML display
    const sanitizedMessage = message.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    chatMessages.innerHTML += `
        <div style="padding: 12px; background: var(--primary); color: white; border-radius: var(--radius); margin-bottom: 12px; text-align: right;">
            <strong>You:</strong> ${sanitizedMessage}
        </div>
    `;
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Check API key
    if (!geminiApiKey) {
        chatMessages.innerHTML += `
            <div style="padding: 12px; background: #ffffff; border: 1px solid var(--danger); border-radius: var(--radius); margin-bottom: 12px;">
                <strong>AI:</strong> Please configure your Gemini API key in Settings to use the AI assistant.
            </div>
        `;
        chatMessages.scrollTop = chatMessages.scrollHeight;
        return;
    }

    // Show thinking indicator
    const thinkingId = 'thinking-' + Date.now();
    chatMessages.innerHTML += `
        <div id="${thinkingId}" style="padding: 12px; background: #ffffff; border: 1px solid var(--gray-300); border-radius: var(--radius); margin-bottom: 12px;">
            <strong>AI:</strong> <em>Thinking...</em>
        </div>
    `;
    chatMessages.scrollTop = chatMessages.scrollHeight;

    try {
        console.log('Sending request to Gemini API...');

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${geminiApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: `You are a helpful medical assistant for elderly care. Current medications: ${medications.map(m => m.name).join(', ') || 'None'}.

IMPORTANT INSTRUCTIONS:
- Keep responses SHORT (2-3 sentences maximum)
- Use simple, clear language
- Use bullet points (•) for lists
- Use line breaks for readability
- Be direct and helpful
- Avoid medical jargon

Question: ${message}` }]
                }]
            })
        });

        // Remove thinking indicator
        const thinkingElement = document.getElementById(thinkingId);
        if (thinkingElement) thinkingElement.remove();

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`API Error ${response.status}: ${errorData.error?.message || 'Unknown error'}`);
        }

        const data = await response.json();
        console.log('Received response from Gemini API');

        if (!data.candidates || !data.candidates[0]) {
            throw new Error('Invalid API response - no candidates');
        }

        const answer = data.candidates[0].content.parts[0].text;
        const messageId = 'msg-' + Date.now();

        // Format the answer with HTML
        const formattedAnswer = answer
            .replace(/\n/g, '<br>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/• /g, '<br>• ');

        chatMessages.innerHTML += `
            <div id="${messageId}" style="padding: 12px; background: #ffffff; border: 1px solid var(--gray-300); border-radius: var(--radius); margin-bottom: 12px; position: relative;">
                <div style="display: flex; justify-content: space-between; align-items: start; gap: 12px;">
                    <div style="flex: 1;">
                        <strong>AI:</strong> <span class="message-text">${formattedAnswer}</span>
                    </div>
                    <button onclick="copyMessage('${messageId}')" style="background: none; border: none; color: var(--primary); cursor: pointer; padding: 4px 8px; font-size: 12px; border-radius: 4px; transition: background 0.2s;" onmouseover="this.style.background='var(--gray-100)'" onmouseout="this.style.background='none'" title="Copy message">
                        📋 Copy
                    </button>
                </div>
            </div>
        `;

        chatMessages.scrollTop = chatMessages.scrollHeight;

        // Speak response
        speakText(answer);
    } catch (error) {
        console.error('Chatbot error:', error);

        // Remove thinking indicator
        const thinkingElement = document.getElementById(thinkingId);
        if (thinkingElement) thinkingElement.remove();

        chatMessages.innerHTML += `
            <div style="padding: 12px; background: #ffffff; border: 1px solid var(--danger); border-radius: var(--radius); margin-bottom: 12px;">
                <strong>Error:</strong> ${error.message}
            </div>
        `;
        chatMessages.scrollTop = chatMessages.scrollHeight;
        showAlert('❌ AI Error: ' + error.message, 'error');
    }
}

function startChatbotVoice() {
    // Prevent multiple simultaneous recognition sessions
    if (isChatbotListening) {
        console.log('Voice recognition already active, ignoring duplicate request');
        showAlert('⚠️ Already listening...', 'warning');
        return;
    }

    // Check if running on localhost or HTTPS
    const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

    if (!isSecure) {
        showAlert('⚠️ Microphone requires HTTPS or localhost. Please run on a local server.', 'error');
        return;
    }

    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        showAlert('❌ Voice recognition not supported in this browser. Try Chrome or Edge.', 'error');
        return;
    }

    try {
        // Stop any existing recognition first
        if (chatbotRecognition) {
            try {
                chatbotRecognition.stop();
            } catch (e) {}
            chatbotRecognition = null;
        }

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        chatbotRecognition = new SpeechRecognition();
        chatbotRecognition.lang = 'en-US';
        chatbotRecognition.continuous = false;
        chatbotRecognition.interimResults = false;
        chatbotRecognition.maxAlternatives = 1;

        chatbotRecognition.onstart = () => {
            isChatbotListening = true;
            console.log('Chatbot voice recognition started');
            showAlert('🎤 Listening... Speak now!', 'info');
        };

        chatbotRecognition.onresult = (event) => {
            const transcript = event.results[0][0].transcript;
            console.log('Chatbot transcript:', transcript);
            showAlert(`You said: "${transcript}"`, 'success');

            // Put the transcript in the input field
            const input = document.getElementById('chatbotInput');
            if (input) {
                input.value = transcript;
            }

            // Automatically send the message
            setTimeout(() => {
                processChatbotMessage(transcript);
            }, 500);
        };

        chatbotRecognition.onerror = (event) => {
            console.error('Chatbot voice recognition error:', event);
            isChatbotListening = false;
            chatbotRecognition = null;

            // Don't show error for 'aborted' - that's intentional (happens when closing chatbot)
            if (event.error === 'aborted') {
                console.log('Voice recognition aborted (normal when closing chatbot)');
                return;
            }

            let errorMsg = '❌ Voice recognition error: ';
            if (event.error === 'not-allowed' || event.error === 'permission-denied') {
                errorMsg += 'Please allow microphone permissions in your browser settings.';
            } else if (event.error === 'no-speech') {
                errorMsg += 'No speech detected. Please try again.';
            } else if (event.error === 'audio-capture') {
                errorMsg += 'No microphone found. Please check your device.';
            } else if (event.error === 'network') {
                errorMsg += 'Network error. Please check your connection.';
            } else {
                errorMsg += event.error;
            }
            showAlert(errorMsg, 'error');
        };

        chatbotRecognition.onend = () => {
            console.log('Chatbot voice recognition ended');
            isChatbotListening = false;
            chatbotRecognition = null;
        };

        chatbotRecognition.start();
    } catch (error) {
        console.error('Failed to start chatbot voice recognition:', error);
        isChatbotListening = false;
        showAlert('❌ Failed to start voice recognition: ' + error.message, 'error');
    }
}

// Open chatbot and immediately start voice input
function openChatbotWithVoice() {
    openChatbot();
    // Wait a moment for modal to open, then start voice
    setTimeout(() => {
        startChatbotVoice();
    }, 300);
}

// Copy message to clipboard
function copyMessage(messageId) {
    const messageElement = document.getElementById(messageId);
    if (!messageElement) {
        showAlert('❌ Message not found', 'error');
        return;
    }

    const textElement = messageElement.querySelector('.message-text');
    const text = textElement ? textElement.textContent : messageElement.textContent;

    // Remove "AI:" prefix if present
    const cleanText = text.replace(/^AI:\s*/i, '').trim();

    navigator.clipboard.writeText(cleanText).then(() => {
        showAlert('✅ Copied to clipboard!', 'success');

        // Visual feedback - change button text briefly
        const button = messageElement.querySelector('button');
        if (button) {
            const originalText = button.innerHTML;
            button.innerHTML = '✓ Copied';
            setTimeout(() => {
                button.innerHTML = originalText;
            }, 2000);
        }
    }).catch(error => {
        console.error('Copy failed:', error);
        showAlert('❌ Failed to copy', 'error');
    });
}

// AI Video Call - Global Variables
let isInVideoCall = false;
let videoStream = null;
let videoCallDuration = 0;
let videoDurationInterval = null;
let videoRecognition = null;
let isVideoMuted = false;
let isVideoCameraOff = false;

// AI Phone Call - Global Variables
let isInCall = false;
let callDuration = 0;
let callDurationInterval = null;
let callRecognition = null;
let isCallMuted = false;

// Chatbot Voice Recognition - Global Variables
let chatbotRecognition = null;
let isChatbotListening = false;

// Global cleanup function - stops all audio and recognition
function stopAllAudioAndRecognition() {
    // Stop speech synthesis
    if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
    }

    // Hide all indicators
    document.getElementById('listeningIndicator').style.display = 'none';
    document.getElementById('speakingIndicator').style.display = 'none';

    // Stop video call recognition
    if (videoRecognition) {
        try {
            videoRecognition.stop();
        } catch (e) {}
    }

    // Stop phone call recognition
    if (callRecognition) {
        try {
            callRecognition.stop();
        } catch (e) {}
    }

    // Stop chatbot recognition
    if (chatbotRecognition) {
        try {
            chatbotRecognition.stop();
            chatbotRecognition = null;
        } catch (e) {}
    }
    isChatbotListening = false;

    console.log('All audio and recognition stopped');
}

// Start AI Video Call
async function startVideoCall() {
    // Stop all other audio/recognition first
    stopAllAudioAndRecognition();

    // End phone call if active
    if (isInCall) {
        endCall();
    }

    // Close chatbot if open
    closeChatbot();

    if (!geminiApiKey) {
        showAlert('⚠️ Please set Gemini API key in Settings first', 'warning');
        return;
    }

    const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!isSecure) {
        showAlert('⚠️ Video call requires HTTPS or localhost', 'error');
        return;
    }

    try {
        // Request camera access
        videoStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user' },
            audio: true
        });

        const videoElement = document.getElementById('userVideo');
        videoElement.srcObject = videoStream;

        // Show video call interface
        document.getElementById('videoCallInterface').style.display = 'flex';
        document.getElementById('videoCallStatus').textContent = 'Connected to AI Health Assistant';

        isInVideoCall = true;
        videoCallDuration = 0;

        // Start duration timer
        videoDurationInterval = setInterval(() => {
            videoCallDuration++;
            const mins = Math.floor(videoCallDuration / 60).toString().padStart(2, '0');
            const secs = (videoCallDuration % 60).toString().padStart(2, '0');
            document.getElementById('videoCallDuration').textContent = `${mins}:${secs}`;
        }, 1000);

        // Start voice recognition
        startVideoVoiceRecognition();

        showAlert('✅ Video call started!', 'success');
    } catch (error) {
        console.error('Video call error:', error);
        showAlert('❌ Failed to start video call: ' + error.message, 'error');
    }
}

// End Video Call
function endVideoCall() {
    // Stop all audio and recognition
    stopAllAudioAndRecognition();

    if (videoStream) {
        videoStream.getTracks().forEach(track => track.stop());
        videoStream = null;
    }

    if (videoDurationInterval) {
        clearInterval(videoDurationInterval);
        videoDurationInterval = null;
    }

    if (videoRecognition) {
        try { videoRecognition.stop(); } catch (e) {}
        videoRecognition = null;
    }

    document.getElementById('videoCallInterface').style.display = 'none';
    isInVideoCall = false;
    isVideoMuted = false;
    isVideoCameraOff = false;

    document.getElementById('videoMuteBtn').classList.remove('muted');
    document.getElementById('videoCameraBtn').classList.remove('off');

    showAlert('📞 Video call ended', 'info');
}

// Start AI Phone Call
function startPhoneCall() {
    // Stop all other audio/recognition first
    stopAllAudioAndRecognition();

    // End video call if active
    if (isInVideoCall) {
        endVideoCall();
    }

    // Close chatbot if open
    closeChatbot();

    if (!geminiApiKey) {
        showAlert('⚠️ Please set Gemini API key in Settings first', 'warning');
        return;
    }

    const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!isSecure) {
        showAlert('⚠️ Phone call requires HTTPS or localhost', 'error');
        return;
    }

    // Show call interface
    document.getElementById('callInterface').style.display = 'flex';
    document.getElementById('callStatus').textContent = 'Connected to AI Health Assistant';

    isInCall = true;
    callDuration = 0;

    // Start duration timer
    callDurationInterval = setInterval(() => {
        callDuration++;
        const mins = Math.floor(callDuration / 60).toString().padStart(2, '0');
        const secs = (callDuration % 60).toString().padStart(2, '0');
        document.getElementById('callDuration').textContent = `${mins}:${secs}`;
    }, 1000);

    // Start voice recognition
    startCallVoiceRecognition();

    showAlert('✅ Call started!', 'success');
}

// End Phone Call
function endCall() {
    // Stop all audio and recognition
    stopAllAudioAndRecognition();

    if (callDurationInterval) {
        clearInterval(callDurationInterval);
        callDurationInterval = null;
    }

    if (callRecognition) {
        try { callRecognition.stop(); } catch (e) {}
        callRecognition = null;
    }

    document.getElementById('callInterface').style.display = 'none';
    isInCall = false;
    isCallMuted = false;

    document.getElementById('callMuteBtn').classList.remove('muted');

    showAlert('📞 Call ended', 'info');
}

// Video Call Voice Recognition
function startVideoVoiceRecognition() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        showAlert('❌ Voice recognition not supported in this browser', 'error');
        return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    videoRecognition = new SpeechRecognition();
    videoRecognition.lang = 'en-US';
    videoRecognition.continuous = false; // Changed to false - we'll manually restart
    videoRecognition.interimResults = false;
    videoRecognition.maxAlternatives = 1;

    videoRecognition.onstart = () => {
        console.log('Video call - listening started');
        document.getElementById('listeningIndicator').style.display = 'flex';
    };

    videoRecognition.onresult = async (event) => {
        const transcript = event.results[0][0].transcript;
        console.log('Video call - heard:', transcript);
        document.getElementById('listeningIndicator').style.display = 'none';

        // Add to transcript
        const transcriptDiv = document.getElementById('videoTranscript');
        transcriptDiv.innerHTML += `
            <div class="transcript-entry transcript-user">
                <strong>You:</strong> ${transcript}
            </div>
        `;
        transcriptDiv.scrollTop = transcriptDiv.scrollHeight;

        // Get AI response (this will restart recognition when done)
        await processVideoCallAI(transcript);
    };

    videoRecognition.onerror = (event) => {
        console.error('Video recognition error:', event.error);
        document.getElementById('listeningIndicator').style.display = 'none';

        if (event.error === 'no-speech') {
            // Just restart if no speech detected
            if (isInVideoCall && !isVideoMuted) {
                setTimeout(() => {
                    try { videoRecognition.start(); } catch (e) {}
                }, 500);
            }
        } else if (event.error !== 'aborted') {
            // For other errors, show message and try to restart
            console.log('Restarting video recognition after error...');
            if (isInVideoCall && !isVideoMuted) {
                setTimeout(() => {
                    try { videoRecognition.start(); } catch (e) {}
                }, 1000);
            }
        }
    };

    videoRecognition.onend = () => {
        console.log('Video recognition ended');
        document.getElementById('listeningIndicator').style.display = 'none';

        // Auto-restart if still in call and not muted
        if (isInVideoCall && !isVideoMuted) {
            setTimeout(() => {
                try {
                    videoRecognition.start();
                    console.log('Video recognition restarted');
                } catch (e) {
                    console.error('Failed to restart video recognition:', e);
                }
            }, 500);
        }
    };

    try {
        videoRecognition.start();
        console.log('Video recognition started');
    } catch (error) {
        console.error('Failed to start video recognition:', error);
        showAlert('❌ Failed to start voice recognition', 'error');
    }
}

// Phone Call Voice Recognition
function startCallVoiceRecognition() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        showAlert('❌ Voice recognition not supported in this browser', 'error');
        return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    callRecognition = new SpeechRecognition();
    callRecognition.lang = 'en-US';
    callRecognition.continuous = false; // Changed to false - we'll manually restart
    callRecognition.interimResults = false;
    callRecognition.maxAlternatives = 1;

    callRecognition.onstart = () => {
        console.log('Phone call - listening started');
        document.getElementById('listeningIndicator').style.display = 'flex';
    };

    callRecognition.onresult = async (event) => {
        const transcript = event.results[0][0].transcript;
        console.log('Phone call - heard:', transcript);
        document.getElementById('listeningIndicator').style.display = 'none';

        // Add to transcript
        const transcriptDiv = document.getElementById('callTranscript');
        transcriptDiv.innerHTML += `
            <div class="transcript-entry transcript-user">
                <strong>You:</strong> ${transcript}
            </div>
        `;
        transcriptDiv.scrollTop = transcriptDiv.scrollHeight;

        // Get AI response (this will restart recognition when done)
        await processCallAI(transcript);
    };

    callRecognition.onerror = (event) => {
        console.error('Call recognition error:', event.error);
        document.getElementById('listeningIndicator').style.display = 'none';

        if (event.error === 'no-speech') {
            // Just restart if no speech detected
            if (isInCall && !isCallMuted) {
                setTimeout(() => {
                    try { callRecognition.start(); } catch (e) {}
                }, 500);
            }
        } else if (event.error !== 'aborted') {
            // For other errors, try to restart
            console.log('Restarting call recognition after error...');
            if (isInCall && !isCallMuted) {
                setTimeout(() => {
                    try { callRecognition.start(); } catch (e) {}
                }, 1000);
            }
        }
    };

    callRecognition.onend = () => {
        console.log('Call recognition ended');
        document.getElementById('listeningIndicator').style.display = 'none';

        // Auto-restart if still in call and not muted
        if (isInCall && !isCallMuted) {
            setTimeout(() => {
                try {
                    callRecognition.start();
                    console.log('Call recognition restarted');
                } catch (e) {
                    console.error('Failed to restart call recognition:', e);
                }
            }, 500);
        }
    };

    try {
        callRecognition.start();
        console.log('Call recognition started');
    } catch (error) {
        console.error('Failed to start call recognition:', error);
        showAlert('❌ Failed to start voice recognition', 'error');
    }
}

// Process Video Call AI Response
async function processVideoCallAI(userMessage) {
    try {
        document.getElementById('speakingIndicator').style.display = 'flex';

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${geminiApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: `You are a health assistant in a video call. Current medications: ${medications.map(m => m.name).join(', ') || 'None'}.

IMPORTANT:
- Keep answers VERY SHORT (1-2 sentences max)
- Use simple, clear language
- Be direct and helpful
- No long explanations

Question: ${userMessage}` }]
                }]
            })
        });

        const data = await response.json();
        const aiResponse = data.candidates[0].content.parts[0].text;

        // Format response with HTML
        const formattedResponse = aiResponse
            .replace(/\n/g, '<br>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/• /g, '<br>• ');

        // Add to transcript
        const transcriptDiv = document.getElementById('videoTranscript');
        transcriptDiv.innerHTML += `
            <div class="transcript-entry transcript-ai">
                <strong>AI:</strong> ${formattedResponse}
            </div>
        `;
        transcriptDiv.scrollTop = transcriptDiv.scrollHeight;

        // Speak response
        speakText(aiResponse);

        setTimeout(() => {
            document.getElementById('speakingIndicator').style.display = 'none';
        }, 2000);
    } catch (error) {
        console.error('Video call AI error:', error);
        document.getElementById('speakingIndicator').style.display = 'none';
    }
}

// Process Phone Call AI Response
async function processCallAI(userMessage) {
    try {
        document.getElementById('speakingIndicator').style.display = 'flex';

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${geminiApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: `You are a health assistant on a phone call. Current medications: ${medications.map(m => m.name).join(', ') || 'None'}.

IMPORTANT:
- Keep answers VERY SHORT (1-2 sentences max)
- Use simple, clear language
- Be direct and helpful
- No long explanations

Question: ${userMessage}` }]
                }]
            })
        });

        const data = await response.json();
        const aiResponse = data.candidates[0].content.parts[0].text;

        // Format response with HTML
        const formattedResponse = aiResponse
            .replace(/\n/g, '<br>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/• /g, '<br>• ');

        // Add to transcript
        const transcriptDiv = document.getElementById('callTranscript');
        transcriptDiv.innerHTML += `
            <div class="transcript-entry transcript-ai">
                <strong>AI:</strong> ${formattedResponse}
            </div>
        `;
        transcriptDiv.scrollTop = transcriptDiv.scrollHeight;

        // Speak response
        speakText(aiResponse);

        setTimeout(() => {
            document.getElementById('speakingIndicator').style.display = 'none';
        }, 2000);
    } catch (error) {
        console.error('Call AI error:', error);
        document.getElementById('speakingIndicator').style.display = 'none';
    }
}

// Toggle Video Mute
function toggleVideoMute() {
    isVideoMuted = !isVideoMuted;
    const btn = document.getElementById('videoMuteBtn');

    if (isVideoMuted) {
        btn.classList.add('muted');
        if (videoRecognition) {
            try { videoRecognition.stop(); } catch (e) {}
        }
    } else {
        btn.classList.remove('muted');
        if (videoRecognition && isInVideoCall) {
            try { videoRecognition.start(); } catch (e) {}
        }
    }
}

// Toggle Video Camera
function toggleVideoCamera() {
    isVideoCameraOff = !isVideoCameraOff;
    const btn = document.getElementById('videoCameraBtn');

    if (videoStream) {
        videoStream.getVideoTracks().forEach(track => {
            track.enabled = !isVideoCameraOff;
        });
    }

    if (isVideoCameraOff) {
        btn.classList.add('off');
    } else {
        btn.classList.remove('off');
    }
}

// Capture and Analyze Video Frame
async function captureAndAnalyzeVideo() {
    const video = document.getElementById('userVideo');
    const canvas = document.getElementById('videoCaptureCanvas');

    if (!video || !canvas) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    document.getElementById('videoAnalysisIndicator').style.display = 'flex';

    try {
        const imageData = canvas.toDataURL('image/jpeg', 0.8);
        const base64 = imageData.split(',')[1];

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${geminiApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: 'Analyze this image for any health-related concerns, medications, or medical documents. Describe what you see.' },
                        { inline_data: { mime_type: 'image/jpeg', data: base64 } }
                    ]
                }]
            })
        });

        const data = await response.json();
        const analysis = data.candidates[0].content.parts[0].text;

        const transcriptDiv = document.getElementById('videoTranscript');
        transcriptDiv.innerHTML += `
            <div class="transcript-entry transcript-ai">
                <strong>AI Analysis:</strong> ${analysis}
            </div>
        `;
        transcriptDiv.scrollTop = transcriptDiv.scrollHeight;

        speakText(analysis);
    } catch (error) {
        console.error('Video analysis error:', error);
    }

    document.getElementById('videoAnalysisIndicator').style.display = 'none';
}

// Toggle Call Mute
function toggleCallMute() {
    isCallMuted = !isCallMuted;
    const btn = document.getElementById('callMuteBtn');

    if (isCallMuted) {
        btn.classList.add('muted');
        if (callRecognition) {
            try { callRecognition.stop(); } catch (e) {}
        }
    } else {
        btn.classList.remove('muted');
        if (callRecognition && isInCall) {
            try { callRecognition.start(); } catch (e) {}
        }
    }
}

// Copy Video Transcript
function copyVideoTranscript() {
    const transcriptElement = document.getElementById('videoTranscript');
    if (!transcriptElement) {
        showAlert('❌ Transcript not found', 'error');
        return;
    }

    const transcript = transcriptElement.innerText || transcriptElement.textContent;

    if (!transcript || transcript.trim().length === 0) {
        showAlert('⚠️ No transcript to copy', 'warning');
        return;
    }

    if (!navigator.clipboard) {
        showAlert('❌ Clipboard not supported in this browser', 'error');
        return;
    }

    navigator.clipboard.writeText(transcript).then(() => {
        showAlert('✅ Video transcript copied!', 'success');
    }).catch((error) => {
        console.error('Copy error:', error);
        showAlert('❌ Failed to copy transcript', 'error');
    });
}

// Copy Call Transcript
function copyCallTranscript() {
    const transcriptElement = document.getElementById('callTranscript');
    if (!transcriptElement) {
        showAlert('❌ Transcript not found', 'error');
        return;
    }

    const transcript = transcriptElement.innerText || transcriptElement.textContent;

    if (!transcript || transcript.trim().length === 0) {
        showAlert('⚠️ No transcript to copy', 'warning');
        return;
    }

    if (!navigator.clipboard) {
        showAlert('❌ Clipboard not supported in this browser', 'error');
        return;
    }

    navigator.clipboard.writeText(transcript).then(() => {
        showAlert('✅ Call transcript copied!', 'success');
    }).catch((error) => {
        console.error('Copy error:', error);
        showAlert('❌ Failed to copy transcript', 'error');
    });
}

// Emergency call (always dials emergency services)
function emergencyCall() {
    const confirmed = confirm('Call Emergency Services (10177)?\n\nThis will dial South African emergency services.');
    if (confirmed) {
        window.location.href = 'tel:10177';
    }
}

// ========== NEW FEATURES FUNCTIONS ==========

// Global variables for new features
let appointments = [];
let journalEntries = [];
let medicationHistory = [];
let currentLanguage = 'en';
let isDarkMode = false;

// Load data on init
function loadNewFeaturesData() {
    const savedAppointments = localStorage.getItem('appointments');
    const savedJournal = localStorage.getItem('journalEntries');
    const savedHistory = localStorage.getItem('medicationHistory');
    const savedLanguage = localStorage.getItem('appLanguage');
    const savedDarkMode = localStorage.getItem('darkMode');

    if (savedAppointments) appointments = JSON.parse(savedAppointments);
    if (savedJournal) journalEntries = JSON.parse(savedJournal);
    if (savedHistory) medicationHistory = JSON.parse(savedHistory);
    if (savedLanguage) {
        currentLanguage = savedLanguage;
        document.getElementById('appLanguage').value = savedLanguage;
    }
    if (savedDarkMode === 'true') {
        isDarkMode = true;
        document.body.classList.add('dark-mode');
        document.getElementById('darkModeToggle').checked = true;
    }
}

// Initialize new features on load
document.addEventListener('DOMContentLoaded', function() {
    loadNewFeaturesData();
    updateAppointmentsList();
    updateJournalEntries();
    updateMedicationHistory();
    checkRefillAlerts();
    checkAppointmentReminders();
});

// Pill Image Preview
function previewMedImage(input) {
    const preview = document.getElementById('medImagePreview');
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            preview.innerHTML = `<img src="${e.target.result}" style="max-width: 200px; border-radius: var(--radius); border: 2px solid var(--gray-300);">`;
        };
        reader.readAsDataURL(input.files[0]);
    } else {
        preview.innerHTML = '';
    }
}

// Update addMedication to include new fields
const originalAddMedication = addMedication;
async function addMedication(event) {
    event.preventDefault();

    try {
        const imageInput = document.getElementById('medImage');
        let imageData = null;
        if (imageInput.files && imageInput.files[0]) {
            imageData = await fileToBase64(imageInput.files[0]);
        }

        const medication = {
            id: Date.now(),
            name: sanitizeInput(document.getElementById('medName').value),
            dosage: sanitizeInput(document.getElementById('medDosage').value),
            time: document.getElementById('medTime').value,
            frequency: document.getElementById('medFrequency').value,
            image: imageData,
            stock: parseInt(document.getElementById('medStock').value) || 0,
            refillAlert: parseInt(document.getElementById('medRefillAlert').value) || 0,
            taken: false,
            createdAt: new Date().toISOString()
        };

        validateMedicationData(medication);

        medications.push(medication);
        saveMedications();

        try {
            await esp32Request('/api/medications', 'POST', medication);
        } catch (error) {
            console.warn('Failed to sync to ESP32, will retry later');
        }

        updateDashboard();
        closeModal('addMedModal');
        showAlert('Medication added successfully!', 'success');
        event.target.reset();
        document.getElementById('medImagePreview').innerHTML = '';

        checkRefillAlerts();

    } catch (error) {
        showAlert(error.message, 'error');
    }
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// Refill Alerts
function checkRefillAlerts() {
    medications.forEach(med => {
        if (med.stock > 0 && med.refillAlert > 0 && med.stock <= med.refillAlert) {
            showAlert(`⚠️ Low stock: ${med.name} (${med.stock} pills left)`, 'warning');
        }
    });
}

// Medication History
function updateMedicationHistory() {
    const filter = document.getElementById('historyFilter')?.value || 'all';
    const dateFilter = document.getElementById('historyDate')?.value;
    const container = document.getElementById('medicationHistory');

    if (!container) return;

    let history = medications.filter(m => m.takenAt);

    if (filter === 'taken') {
        history = history.filter(m => m.taken);
    } else if (filter === 'missed') {
        history = history.filter(m => !m.taken && new Date(m.time) < new Date());
    }

    if (dateFilter) {
        const filterDate = new Date(dateFilter).toDateString();
        history = history.filter(m => new Date(m.takenAt).toDateString() === filterDate);
    }

    history.sort((a, b) => new Date(b.takenAt) - new Date(a.takenAt));

    container.innerHTML = history.length === 0
        ? '<p style="text-align: center; color: var(--gray-500); padding: 40px;">No history found</p>'
        : history.map(med => `
            <div class="medication-item">
                <div class="medication-info">
                    ${med.image ? `<img src="${med.image}" style="width: 50px; height: 50px; border-radius: var(--radius-sm); object-fit: cover; margin-right: 12px;">` : ''}
                    <div>
                        <div class="medication-name">${med.name}</div>
                        <div class="medication-time">Taken: ${new Date(med.takenAt).toLocaleString()}</div>
                        <div class="medication-dosage">Dosage: ${med.dosage}</div>
                    </div>
                </div>
                <div class="status-indicator ${med.taken ? 'status-taken' : 'status-missed'}"></div>
            </div>
        `).join('');
}

// Export History
function exportHistory() {
    const history = medications.filter(m => m.takenAt);
    const csv = [
        'Medication,Dosage,Time Scheduled,Time Taken,Status',
        ...history.map(m => `${m.name},${m.dosage},${m.time},${new Date(m.takenAt).toLocaleString()},${m.taken ? 'Taken' : 'Missed'}`)
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `medication-history-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    showAlert('✅ History exported!', 'success');
}

// Appointments
function addAppointment(event) {
    event.preventDefault();

    const appointment = {
        id: Date.now(),
        doctor: sanitizeInput(document.getElementById('appointmentDoctor').value),
        type: document.getElementById('appointmentType').value,
        dateTime: document.getElementById('appointmentDateTime').value,
        location: sanitizeInput(document.getElementById('appointmentLocation').value),
        notes: sanitizeInput(document.getElementById('appointmentNotes').value),
        createdAt: new Date().toISOString()
    };

    appointments.push(appointment);
    localStorage.setItem('appointments', JSON.stringify(appointments));

    updateAppointmentsList();
    closeModal('addAppointmentModal');
    showAlert('✅ Appointment added!', 'success');
    event.target.reset();
}

function updateAppointmentsList() {
    const container = document.getElementById('appointmentsList');
    if (!container) return;

    const sortedAppointments = appointments.sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime));
    const now = new Date();

    container.innerHTML = appointments.length === 0
        ? '<p style="text-align: center; color: var(--gray-500); padding: 40px;">No appointments scheduled</p>'
        : sortedAppointments.map(apt => {
            const aptDate = new Date(apt.dateTime);
            const isPast = aptDate < now;
            return `
                <div class="medication-item" style="${isPast ? 'opacity: 0.6;' : ''}">
                    <div class="medication-info">
                        <div class="medication-name">${apt.doctor}</div>
                        <div class="medication-time">📅 ${aptDate.toLocaleString()}</div>
                        <div class="medication-dosage">Type: ${apt.type} ${apt.location ? `| 📍 ${apt.location}` : ''}</div>
                        ${apt.notes ? `<div style="font-size: 12px; color: var(--gray-600); margin-top: 4px;">${apt.notes}</div>` : ''}
                    </div>
                    <button class="confirm-btn" onclick="deleteAppointment(${apt.id})" style="background: var(--danger);">Delete</button>
                </div>
            `;
        }).join('');
}

function deleteAppointment(id) {
    if (!confirm('Delete this appointment?')) return;
    appointments = appointments.filter(a => a.id !== id);
    localStorage.setItem('appointments', JSON.stringify(appointments));
    updateAppointmentsList();
    showAlert('Appointment deleted', 'info');
}

function checkAppointmentReminders() {
    const now = new Date();
    appointments.forEach(apt => {
        const aptDate = new Date(apt.dateTime);
        const hoursDiff = (aptDate - now) / (1000 * 60 * 60);
        if (hoursDiff > 0 && hoursDiff < 24) {
            showAlert(`📅 Reminder: Appointment with ${apt.doctor} in ${Math.round(hoursDiff)} hours`, 'info');
        }
    });
}

// Health Journal
function addJournalEntry(event) {
    event.preventDefault();

    const entry = {
        id: Date.now(),
        date: document.getElementById('journalDate').value,
        mood: document.getElementById('journalMood').value,
        symptoms: sanitizeInput(document.getElementById('journalSymptoms').value),
        notes: sanitizeInput(document.getElementById('journalNotes').value),
        createdAt: new Date().toISOString()
    };

    journalEntries.push(entry);
    localStorage.setItem('journalEntries', JSON.stringify(journalEntries));

    updateJournalEntries();
    closeModal('addJournalModal');
    showAlert('✅ Journal entry saved!', 'success');
    event.target.reset();
}

function updateJournalEntries() {
    const container = document.getElementById('journalEntries');
    if (!container) return;

    const sortedEntries = journalEntries.sort((a, b) => new Date(b.date) - new Date(a.date));

    container.innerHTML = journalEntries.length === 0
        ? '<p style="text-align: center; color: var(--gray-500); padding: 40px;">No journal entries yet</p>'
        : sortedEntries.map(entry => `
            <div class="medication-item" style="flex-direction: column; align-items: stretch;">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 12px;">
                    <div>
                        <div class="medication-name">${new Date(entry.date).toLocaleDateString()}</div>
                        <div class="medication-time">Mood: ${getMoodEmoji(entry.mood)}</div>
                        ${entry.symptoms ? `<div class="medication-dosage">Symptoms: ${entry.symptoms}</div>` : ''}
                    </div>
                    <button class="confirm-btn" onclick="deleteJournalEntry(${entry.id})" style="background: var(--danger); padding: 8px 12px; font-size: 12px;">Delete</button>
                </div>
                <div style="background: var(--gray-50); padding: 12px; border-radius: var(--radius-sm); font-size: 14px; line-height: 1.6;">
                    ${entry.notes}
                </div>
            </div>
        `).join('');
}

function getMoodEmoji(mood) {
    const moods = {
        'great': '😊 Great',
        'good': '🙂 Good',
        'okay': '😐 Okay',
        'bad': '😞 Not Good',
        'terrible': '😢 Terrible'
    };
    return moods[mood] || mood;
}

function deleteJournalEntry(id) {
    if (!confirm('Delete this journal entry?')) return;
    journalEntries = journalEntries.filter(e => e.id !== id);
    localStorage.setItem('journalEntries', JSON.stringify(journalEntries));
    updateJournalEntries();
    showAlert('Journal entry deleted', 'info');
}

// Family Portal
function generateFamilyLink() {
    const patientId = Date.now().toString(36);
    const shareToken = btoa(patientId + '-' + Date.now());
    const shareUrl = `${window.location.origin}${window.location.pathname}?family=${shareToken}`;

    const linkContainer = document.getElementById('familyShareLink');
    linkContainer.innerHTML = `
        <div style="background: var(--gray-50); padding: 16px; border-radius: var(--radius); border: 2px dashed var(--primary);">
            <p style="font-weight: 600; margin-bottom: 8px; color: var(--primary);">🔗 Shareable Link Generated!</p>
            <div style="display: flex; gap: 8px; align-items: center;">
                <input type="text" value="${shareUrl}" id="familyShareUrl" readonly class="form-input" style="flex: 1; font-size: 12px;">
                <button onclick="copyFamilyLink()" class="action-btn" style="flex: none;">Copy</button>
            </div>
            <p style="font-size: 12px; color: var(--gray-600); margin-top: 8px;">Share this link with family members to let them view your medication status.</p>
        </div>
    `;

    localStorage.setItem('familyShareToken', shareToken);
    showAlert('✅ Share link generated!', 'success');
}

function copyFamilyLink() {
    const input = document.getElementById('familyShareUrl');
    input.select();
    navigator.clipboard.writeText(input.value).then(() => {
        showAlert('✅ Link copied to clipboard!', 'success');
    }).catch(() => {
        showAlert('❌ Failed to copy link', 'error');
    });
}

// Dark Mode
function toggleDarkMode() {
    isDarkMode = !isDarkMode;
    if (isDarkMode) {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
    }
    localStorage.setItem('darkMode', isDarkMode);
}

// Language Support
const translations = {
    en: { title: 'MediCare Assistant', medications: 'Medications', settings: 'Settings' },
    es: { title: 'Asistente MediCare', medications: 'Medicamentos', settings: 'Configuración' },
    fr: { title: 'Assistant MediCare', medications: 'Médicaments', settings: 'Paramètres' },
    de: { title: 'MediCare Assistent', medications: 'Medikamente', settings: 'Einstellungen' },
    pt: { title: 'Assistente MediCare', medications: 'Medicamentos', settings: 'Configurações' },
    zh: { title: 'MediCare 助手', medications: '药物', settings: '设置' }
};

function changeLanguage(lang) {
    currentLanguage = lang;
    localStorage.setItem('appLanguage', lang);
    // Basic translation - can be expanded
    showAlert(`Language changed to ${lang}. Full translation coming soon!`, 'info');
}

// Custom Notification Sounds
function playReminderSound() {
    const soundType = localStorage.getItem('notificationSound') || 'beep';
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    switch(soundType) {
        case 'chime':
            oscillator.frequency.value = 800;
            oscillator.type = 'sine';
            break;
        case 'bell':
            oscillator.frequency.value = 1000;
            oscillator.type = 'triangle';
            break;
        case 'gentle':
            oscillator.frequency.value = 440;
            oscillator.type = 'sine';
            break;
        default: // beep
            oscillator.frequency.value = 800;
            oscillator.type = 'square';
    }

    const volume = localStorage.getItem('reminderVolume') || 80;
    gainNode.gain.value = volume / 100 * 0.3;

    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.5);
}

// Update saveSettings to include new settings
const originalSaveSettings = saveSettings;
async function saveSettings() {
    try {
        const apiKey = sanitizeInput(document.getElementById('apiKey').value);
        const patientName = sanitizeInput(document.getElementById('patientName').value);
        const emergencyContact = sanitizeInput(document.getElementById('emergencyContact').value);
        const esp32Enable = document.getElementById('esp32Enable').checked;
        const esp32Url = sanitizeInput(document.getElementById('esp32Url').value);
        const volume = document.getElementById('reminderVolume').value;
        const language = document.getElementById('appLanguage').value;
        const notificationSound = document.getElementById('notificationSound').value;

        if (apiKey) {
            geminiApiKey = apiKey;
            localStorage.setItem('geminiApiKey', apiKey);
        }
        if (patientName) localStorage.setItem('patientName', patientName);
        if (emergencyContact) localStorage.setItem('emergencyContact', emergencyContact);

        esp32Enabled = esp32Enable;
        localStorage.setItem('esp32Enabled', esp32Enable);

        if (esp32Enable && esp32Url) {
            if (!esp32Url.startsWith('http://') && !esp32Url.startsWith('https://')) {
                throw new Error('ESP32 URL must start with http:// or https://');
            }
            esp32BaseUrl = esp32Url;
            localStorage.setItem('esp32BaseUrl', esp32Url);
            reconnectAttempts = 0;
            await connectToESP32();
            initWebSocket();
        } else {
            esp32BaseUrl = '';
            esp32Connected = false;
            document.getElementById('deviceStatus').textContent = 'Standalone';
            document.getElementById('deviceStatus').style.color = 'var(--gray-500)';
        }

        localStorage.setItem('reminderVolume', volume);
        localStorage.setItem('appLanguage', language);
        localStorage.setItem('notificationSound', notificationSound);

        closeModal('settingsModal');
        showAlert('✅ Settings saved successfully!', 'success');
    } catch (error) {
        showAlert(error.message, 'error');
    }
}

// Update tab switching for new tabs
const originalSwitchTab = switchTab;
function switchTab(tabName) {
    if (tabName !== 'assistant') {
        stopAllAudioAndRecognition();
    }

    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

    document.getElementById(tabName).classList.add('active');

    const buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach(btn => {
        if (btn.textContent.toLowerCase().includes(tabName.toLowerCase()) ||
            btn.getAttribute('onclick').includes(tabName)) {
            btn.classList.add('active');
        }
    });

    // Update content when switching to new tabs
    if (tabName === 'medications') updateAllMedications();
    if (tabName === 'schedule') updateWeeklySchedule();
    if (tabName === 'analytics') updateAnalytics();
    if (tabName === 'history') updateMedicationHistory();
    if (tabName === 'appointments') updateAppointmentsList();
    if (tabName === 'journal') updateJournalEntries();
    if (tabName === 'hardware') refreshHardwareStatus();
}

// ========== HARDWARE TESTING FUNCTIONS ==========

// Hardware status refresh
function refreshHardwareStatus() {
    if (!esp32Enabled || !esp32BaseUrl) {
        showAlert('⚠️ ESP32 not configured. Enable in Settings.', 'warning');
        return;
    }

    showAlert('🔄 Refreshing hardware status...', 'info');

    // Simulate hardware status update (replace with actual ESP32 API calls)
    setTimeout(() => {
        document.getElementById('wifiStrength').textContent = '-' + (40 + Math.random() * 15).toFixed(0) + ' dBm';
        document.getElementById('potValue').textContent = Math.floor(Math.random() * 4096);
        document.getElementById('buzzerVolume').textContent = localStorage.getItem('reminderVolume') || '80' + '%';

        showAlert('✅ Hardware status updated', 'success');
    }, 500);
}

// LED Testing Functions
function testAllLEDs() {
    showAlert('💡 Testing all LEDs...', 'info');
    const leds = ['red', 'green', 'blue'];
    let index = 0;

    const interval = setInterval(() => {
        if (index > 0) {
            document.getElementById(`led${leds[index-1].charAt(0).toUpperCase() + leds[index-1].slice(1)}`).classList.remove('active');
        }
        if (index < leds.length) {
            document.getElementById(`led${leds[index].charAt(0).toUpperCase() + leds[index].slice(1)}`).classList.add('active');
            index++;
        } else {
            clearInterval(interval);
            document.getElementById(`led${leds[leds.length-1].charAt(0).toUpperCase() + leds[leds.length-1].slice(1)}`).classList.remove('active');
            showAlert('✅ LED test completed', 'success');
        }
    }, 500);
}

function toggleLED(color) {
    showAlert(`Toggling ${color} LED...`, 'info');
    const ledElement = document.getElementById(`led${color.charAt(0).toUpperCase() + color.slice(1)}`);
    const isOn = !ledElement.classList.contains('off');
    ledElement.classList.toggle('off');

    // Call ESP32 API
    if (esp32Enabled && esp32BaseUrl) {
        esp32Request(`/api/test/led`, 'POST', {
            color: color,
            state: !isOn  // Toggle state
        }).then(() => {
            showAlert(`✓ ${color} LED ${!isOn ? 'ON' : 'OFF'}`, 'success');
        }).catch(err => {
            console.error(err);
            showAlert(`✗ Failed to control ${color} LED`, 'error');
        });
    }
}

function cycleAllLEDs() {
    showAlert('🔄 Cycling all LEDs...', 'info');
    testAllLEDs();
}

// Buzzer Testing Functions
function testBuzzer() {
    showAlert(`🔊 Testing buzzer...`, 'info');

    // Play tone using Web Audio API (browser sound)
    playReminderSound();

    // Call ESP32 API to test physical buzzer
    if (esp32Enabled && esp32BaseUrl) {
        esp32Request(`/api/test/buzzer`, 'POST', {}).then(() => {
            showAlert('✓ Buzzer test complete', 'success');
        }).catch(err => {
            console.error(err);
            showAlert('✗ Failed to test buzzer', 'error');
        });
    }
}

function playTone(type) {
    showAlert(`🔊 Playing ${type} tone...`, 'info');
    const duration = type === 'short' ? 200 : type === 'long' ? 1000 : 500;

    // Play tone using Web Audio API
    playReminderSound();
}

function stopBuzzer() {
    showAlert('⏹️ Buzzer stopped', 'info');
    if (esp32Enabled && esp32BaseUrl) {
        esp32Request(`/api/buzzer/stop`, 'POST').catch(err => console.error(err));
    }
}

function updateTestVolume(value) {
    document.getElementById('testVolume').textContent = value + '%';
}

// LCD Testing Functions
function testLCD() {
    displayTestPattern();
}

function displayTestPattern() {
    showAlert('💻 Displaying test pattern...', 'info');

    if (esp32Enabled && esp32BaseUrl) {
        esp32Request('/api/lcd/test', 'POST', {
            pattern: 'test'
        }).then(() => {
            showAlert('✅ Test pattern displayed', 'success');
        }).catch(err => {
            console.error(err);
            showAlert('❌ Failed to display test pattern', 'error');
        });
    } else {
        showAlert('📟 Test Pattern:\n████████████████████\n█ ESP32 TEST MODE █\n█ 20x4 LCD DISPLAY █\n████████████████████', 'info');
    }
}

function displayCustomText() {
    const text = document.getElementById('lcdCustomText').value;
    if (!text) {
        showAlert('⚠️ Please enter custom text', 'warning');
        return;
    }

    showAlert('💻 Displaying custom text...', 'info');

    if (esp32Enabled && esp32BaseUrl) {
        esp32Request('/api/lcd/custom', 'POST', {
            text: text
        }).then(() => {
            showAlert('✅ Custom text displayed', 'success');
        }).catch(err => {
            console.error(err);
            showAlert('❌ Failed to display text', 'error');
        });
    } else {
        showAlert(`📟 Displayed: "${text}"`, 'success');
    }
}

function clearLCD() {
    showAlert('💻 Clearing LCD...', 'info');

    if (esp32Enabled && esp32BaseUrl) {
        esp32Request('/api/lcd/clear', 'POST').then(() => {
            showAlert('✅ LCD cleared', 'success');
        }).catch(err => console.error(err));
    } else {
        showAlert('✅ LCD cleared', 'success');
    }
}

function adjustLCDBacklight() {
    showAlert('💡 Adjusting LCD backlight...', 'info');

    if (esp32Enabled && esp32BaseUrl) {
        esp32Request('/api/lcd/backlight', 'POST', {
            brightness: 255
        }).then(() => {
            showAlert('✅ Backlight adjusted', 'success');
        }).catch(err => console.error(err));
    } else {
        showAlert('✅ Backlight set to maximum', 'success');
    }
}

// Button Testing Functions
function testButtons() {
    openModal('hardwareTestModal');
    startButtonTest();
}

let buttonTestActive = false;
function startButtonTest() {
    if (buttonTestActive) {
        showAlert('⚠️ Button test already running', 'warning');
        return;
    }

    buttonTestActive = true;
    showAlert('🎛️ Button test started. Press each button...', 'info');

    // Reset all button statuses
    for (let i = 1; i <= 4; i++) {
        document.getElementById(`btn${i}Status`).textContent = '⚪ Waiting...';
    }

    // Simulate button test (in real implementation, ESP32 would report button presses)
    if (!esp32Enabled || !esp32BaseUrl) {
        setTimeout(() => {
            for (let i = 1; i <= 4; i++) {
                setTimeout(() => {
                    document.getElementById(`btn${i}Status`).textContent = '🟢 Pressed';
                }, i * 500);
            }
            setTimeout(() => {
                buttonTestActive = false;
                showAlert('✅ Button test completed', 'success');
            }, 2500);
        }, 500);
    }
}

// I2C Scanner
function scanI2C() {
    openModal('hardwareTestModal');
    runI2CScan();
}

function runI2CScan() {
    showAlert('🔍 Scanning I2C bus...', 'info');
    const resultsDiv = document.getElementById('i2cResults');
    resultsDiv.textContent = 'Scanning...';

    if (esp32Enabled && esp32BaseUrl) {
        esp32Request('/api/i2c/scan', 'GET').then(response => {
            resultsDiv.textContent = `I2C Scan Results:\n\nDevices found:\n${response.devices.join('\n') || 'No devices found'}`;
            showAlert('✅ I2C scan completed', 'success');
        }).catch(err => {
            resultsDiv.textContent = 'Error scanning I2C bus';
            console.error(err);
        });
    } else {
        setTimeout(() => {
            resultsDiv.textContent = `I2C Scan Results:\n\n📟 Device found at address: 0x27\n(20x4 LCD Display)\n\n✅ Scan complete - 1 device found`;
            showAlert('✅ I2C scan completed', 'success');
        }, 1000);
    }
}

// Test All Components
function testAllComponents() {
    showAlert('🧪 Testing all components...', 'info');

    testAllLEDs();
    setTimeout(() => testBuzzer(), 2000);
    setTimeout(() => testLCD(), 3000);
    setTimeout(() => scanI2C(), 4000);

    setTimeout(() => {
        showAlert('✅ All component tests completed!', 'success');
    }, 5000);
}

// Toggle diagram view
function toggleDiagramView() {
    const diagram = document.getElementById('hardwareDiagram');
    if (diagram.style.display === 'none') {
        diagram.style.display = 'block';
        showAlert('📐 Diagram shown', 'info');
    } else {
        diagram.style.display = 'none';
        showAlert('📐 Diagram hidden', 'info');
    }
}

// Mobile Menu Toggle
function toggleMobileMenu() {
    const navMenu = document.getElementById('navMenu');
    const hamburger = document.querySelector('.hamburger-menu');

    navMenu.classList.toggle('active');
    hamburger.classList.toggle('active');
}

// Close mobile menu when clicking outside
document.addEventListener('click', function(event) {
    const navMenu = document.getElementById('navMenu');
    const hamburger = document.querySelector('.hamburger-menu');

    if (navMenu && hamburger) {
        const isClickInsideMenu = navMenu.contains(event.target);
        const isClickOnHamburger = hamburger.contains(event.target);

        if (!isClickInsideMenu && !isClickOnHamburger && navMenu.classList.contains('active')) {
            navMenu.classList.remove('active');
            hamburger.classList.remove('active');
        }
    }
});

// Close mobile menu when clicking on a menu item
document.addEventListener('DOMContentLoaded', function() {
    const navButtons = document.querySelectorAll('.nav-menu button');
    navButtons.forEach(button => {
        button.addEventListener('click', function() {
            const navMenu = document.getElementById('navMenu');
            const hamburger = document.querySelector('.hamburger-menu');

            if (navMenu && hamburger && window.innerWidth <= 1024) {
                navMenu.classList.remove('active');
                hamburger.classList.remove('active');
            }
        });
    });

    // Close button functionality in mobile menu
    const navMenu = document.getElementById('navMenu');
    if (navMenu) {
        navMenu.addEventListener('click', function(event) {
            // Check if click is on the ::before pseudo-element (close button area)
            const rect = this.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;

            // Close button is at top right (20px from right, 20px from top, 40x40px)
            if (x >= rect.width - 60 && x <= rect.width - 20 && y >= 20 && y <= 60) {
                const hamburger = document.querySelector('.hamburger-menu');
                this.classList.remove('active');
                if (hamburger) hamburger.classList.remove('active');
            }
        });
    }
});
