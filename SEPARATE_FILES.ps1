# PowerShell Script to Separate HTML/CSS/JS from Monolithic File
# Run this in PowerShell from the repository root

Write-Host "="*60
Write-Host "MediCare Assistant - File Separation Script" -ForegroundColor Cyan
Write-Host "="*60

# Source file path
$sourceFile = "C:\Users\Dell\Documents\VS-Code\Google\George\index.html"
$outputDir = ".\website"

# Check if source exists
if (-not (Test-Path $sourceFile)) {
    Write-Host "ERROR: Source file not found at: $sourceFile" -ForegroundColor Red
    Write-Host "Please update the `$sourceFile variable with correct path" -ForegroundColor Yellow
    exit 1
}

Write-Host "`n✓ Source file found: $sourceFile" -ForegroundColor Green

# Create output directory
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
Write-Host "✓ Output directory created: $outputDir" -ForegroundColor Green

# Read entire file
$content = Get-Content $sourceFile -Raw

# Extract CSS (everything between first <style> and </style>)
Write-Host "`nExtracting CSS..." -ForegroundColor Yellow
$cssMatch = [regex]::Match($content, '(?s)<style>(.*?)</style>')
if ($cssMatch.Success) {
    $css = $cssMatch.Groups[1].Value
    $cssFile = Join-Path $outputDir "styles.css"
    $css | Out-File -FilePath $cssFile -Encoding UTF8
    Write-Host "✓ CSS extracted: $(($css | Measure-Object -Line).Lines) lines" -ForegroundColor Green
} else {
    Write-Host "✗ CSS extraction failed" -ForegroundColor Red
}

# Extract JavaScript (everything between <script> and </script>, excluding external scripts)
Write-Host "`nExtracting JavaScript..." -ForegroundColor Yellow
$jsMatches = [regex]::Matches($content, '(?s)<script(?!\s+src)>(.*?)</script>')
$jsContent = ""
foreach ($match in $jsMatches) {
    $jsContent += $match.Groups[1].Value + "`n`n"
}

if ($jsContent) {
    # Add ESP32 API client code at the beginning
    $apiClient = @"
// ============================================================
// ESP32 API CLIENT
// ============================================================

class ESP32Client {
    constructor() {
        this.baseUrl = null;
        this.ws = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;

        // Load saved IP from localStorage
        const savedIp = localStorage.getItem('esp32_ip');
        if (savedIp) {
            this.setBaseUrl(savedIp);
            this.connect();
        } else {
            // Show setup modal if no IP saved
            this.showSetupModal();
        }
    }

    setBaseUrl(ip) {
        // Remove any http:// or trailing slashes
        ip = ip.replace(/^https?:\/\//, '').replace(/\/$/, '');
        this.baseUrl = `http://`+ip;
        console.log('[ESP32] Base URL set to:', this.baseUrl);
    }

    showSetupModal() {
        const modal = document.getElementById('esp32SetupModal');
        if (modal) {
            modal.style.display = 'flex';
            modal.classList.add('active');
        }
    }

    hideSetupModal() {
        const modal = document.getElementById('esp32SetupModal');
        if (modal) {
            modal.style.display = 'none';
            modal.classList.remove('active');
        }
    }

    async testConnection(ip) {
        try {
            const testUrl = `http://`+ip+`/api/status`;
            console.log('[ESP32] Testing connection to:', testUrl);

            const response = await fetch(testUrl, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(5000) // 5 second timeout
            });

            if (!response.ok) throw new Error(`HTTP `+response.status);

            const data = await response.json();
            console.log('[ESP32] Test successful:', data);
            return { success: true, data };
        } catch (error) {
            console.error('[ESP32] Test failed:', error);
            return { success: false, error: error.message };
        }
    }

    async connect() {
        if (!this.baseUrl) {
            console.error('[ESP32] Cannot connect: Base URL not set');
            return false;
        }

        try {
            // Test HTTP connection first
            const testResult = await this.testConnection(this.baseUrl.replace('http://', ''));
            if (!testResult.success) {
                throw new Error('Connection test failed: ' + testResult.error);
            }

            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.updateConnectionStatus(true);

            // Connect WebSocket for real-time updates
            this.connectWebSocket();

            console.log('[ESP32] Connected successfully');
            return true;
        } catch (error) {
            console.error('[ESP32] Connection failed:', error);
            this.isConnected = false;
            this.updateConnectionStatus(false);
            return false;
        }
    }

    connectWebSocket() {
        if (!this.baseUrl) return;

        const wsUrl = this.baseUrl.replace('http://', 'ws://') + ':81';
        console.log('[ESP32] Connecting WebSocket to:', wsUrl);

        try {
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                console.log('[ESP32] WebSocket connected');
                this.reconnectAttempts = 0;
            };

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    console.log('[ESP32] WebSocket message:', data);
                    this.handleWebSocketMessage(data);
                } catch (error) {
                    console.error('[ESP32] WebSocket message parse error:', error);
                }
            };

            this.ws.onerror = (error) => {
                console.error('[ESP32] WebSocket error:', error);
            };

            this.ws.onclose = () => {
                console.log('[ESP32] WebSocket closed');
                // Attempt reconnection
                if (this.isConnected && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.reconnectAttempts++;
                    console.log(`[ESP32] Reconnecting... Attempt `+this.reconnectAttempts);
                    setTimeout(() => this.connectWebSocket(), 3000);
                }
            };
        } catch (error) {
            console.error('[ESP32] WebSocket connection failed:', error);
        }
    }

    handleWebSocketMessage(data) {
        // Handle different message types
        if (data.type === 'medication_alert') {
            this.showMedicationAlert(data);
        } else if (data.type === 'button_press') {
            this.handleButtonPress(data);
        } else if (data.type === 'status_update') {
            this.updateDeviceStatus(data);
        }
    }

    showMedicationAlert(data) {
        // Show alert in UI
        showAlert(`💊 Medication Reminder: `+data.medication, 'info');

        // Play sound if enabled
        if (localStorage.getItem('soundEnabled') !== 'false') {
            playReminderSound();
        }
    }

    handleButtonPress(data) {
        console.log('[ESP32] Button pressed:', data.button);
        // Handle button actions based on button number
    }

    updateDeviceStatus(data) {
        // Update UI with device status
        if (document.getElementById('deviceStatus')) {
            document.getElementById('deviceStatus').textContent = data.online ? 'Online' : 'Offline';
        }
    }

    updateConnectionStatus(connected) {
        this.isConnected = connected;

        // Update status indicator
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');

        if (statusDot && statusText) {
            if (connected) {
                statusDot.className = 'status-dot status-connected';
                statusText.textContent = 'Connected';
            } else {
                statusDot.className = 'status-dot status-disconnected';
                statusText.textContent = 'Offline';
            }
        }

        // Update connection banner
        const banner = document.getElementById('connectionBanner');
        if (banner) {
            if (!connected) {
                banner.style.display = 'block';
                document.getElementById('connectionBannerIcon').textContent = '⚠️';
                document.getElementById('connectionBannerText').textContent = 'ESP32 device offline. Some features unavailable.';
                banner.style.background = 'var(--warning)';
            } else {
                banner.style.display = 'none';
            }
        }
    }

    // API Methods
    async get(endpoint) {
        if (!this.baseUrl) throw new Error('ESP32 not configured');

        try {
            const url = this.baseUrl + endpoint;
            console.log('[ESP32] GET:', url);

            const response = await fetch(url, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(10000)
            });

            if (!response.ok) throw new Error(`HTTP `+response.status);
            return await response.json();
        } catch (error) {
            console.error('[ESP32] GET error:', error);
            throw error;
        }
    }

    async post(endpoint, data) {
        if (!this.baseUrl) throw new Error('ESP32 not configured');

        try {
            const url = this.baseUrl + endpoint;
            console.log('[ESP32] POST:', url, data);

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(data),
                signal: AbortSignal.timeout(10000)
            });

            if (!response.ok) throw new Error(`HTTP `+response.status);
            return await response.json();
        } catch (error) {
            console.error('[ESP32] POST error:', error);
            throw error;
        }
    }

    async put(endpoint, data) {
        if (!this.baseUrl) throw new Error('ESP32 not configured');

        try {
            const url = this.baseUrl + endpoint;
            console.log('[ESP32] PUT:', url, data);

            const response = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(data),
                signal: AbortSignal.timeout(10000)
            });

            if (!response.ok) throw new Error(`HTTP `+response.status);
            return await response.json();
        } catch (error) {
            console.error('[ESP32] PUT error:', error);
            throw error;
        }
    }

    async delete(endpoint) {
        if (!this.baseUrl) throw new Error('ESP32 not configured');

        try {
            const url = this.baseUrl + endpoint;
            console.log('[ESP32] DELETE:', url);

            const response = await fetch(url, {
                method: 'DELETE',
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(10000)
            });

            if (!response.ok) throw new Error(`HTTP `+response.status);
            return await response.json();
        } catch (error) {
            console.error('[ESP32] DELETE error:', error);
            throw error;
        }
    }

    // Convenience methods for common operations
    async getMedications() {
        return await this.get('/api/medications');
    }

    async addMedication(medication) {
        return await this.post('/api/medications', medication);
    }

    async updateMedication(id, medication) {
        return await this.put(`/api/medications/`+id, medication);
    }

    async deleteMedication(id) {
        return await this.delete(`/api/medications/`+id);
    }

    async confirmMedication(id) {
        return await this.post('/api/confirm', { id });
    }

    async getHistory() {
        return await this.get('/api/history');
    }

    async getStatus() {
        return await this.get('/api/status');
    }

    async scanDocument(imageBase64) {
        return await this.post('/api/scan-document', { image: imageBase64 });
    }

    async updateSettings(settings) {
        return await this.post('/api/settings', settings);
    }
}

// Initialize ESP32 client
let esp32Client;

// Global helper functions
async function connectToESP32() {
    const ipInput = document.getElementById('esp32IpInput');
    const rememberCheckbox = document.getElementById('rememberDevice');
    const connectBtn = document.getElementById('connectBtn');
    const connectBtnText = document.getElementById('connectBtnText');
    const statusDiv = document.getElementById('connectionStatus');

    if (!ipInput || !ipInput.value.trim()) {
        alert('Please enter ESP32 IP address');
        return;
    }

    const ip = ipInput.value.trim();

    // Validate IP format
    const ipPattern = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
    if (!ipPattern.test(ip)) {
        statusDiv.style.display = 'block';
        statusDiv.style.background = 'var(--danger)';
        statusDiv.style.color = 'white';
        statusDiv.textContent = '❌ Invalid IP address format. Use format: 192.168.1.100';
        return;
    }

    // Show loading
    connectBtn.disabled = true;
    connectBtnText.textContent = 'Connecting...';
    statusDiv.style.display = 'block';
    statusDiv.style.background = 'var(--primary)';
    statusDiv.style.color = 'white';
    statusDiv.textContent = '🔄 Testing connection...';

    // Initialize client if needed
    if (!esp32Client) {
        esp32Client = new ESP32Client();
    }

    // Test connection
    const testResult = await esp32Client.testConnection(ip);

    if (testResult.success) {
        // Save IP if remember is checked
        if (rememberCheckbox.checked) {
            localStorage.setItem('esp32_ip', ip);
        }

        esp32Client.setBaseUrl(ip);
        await esp32Client.connect();

        statusDiv.style.background = 'var(--success)';
        statusDiv.textContent = '✅ Connected successfully! Device online.';

        // Close modal after 1.5 seconds
        setTimeout(() => {
            esp32Client.hideSetupModal();
            refreshAllData();
        }, 1500);
    } else {
        statusDiv.style.background = 'var(--danger)';
        statusDiv.textContent = `❌ Connection failed: `+testResult.error+`. Check IP address and ensure ESP32 is powered on.`;
        connectBtn.disabled = false;
        connectBtnText.textContent = 'Connect';
    }
}

async function testConnection() {
    const ipInput = document.getElementById('esp32IpInput');
    if (!ipInput || !ipInput.value.trim()) {
        alert('Please enter ESP32 IP address');
        return;
    }

    const ip = ipInput.value.trim();
    const testBtn = document.getElementById('testBtn');
    const statusDiv = document.getElementById('connectionStatus');

    testBtn.disabled = true;
    testBtn.textContent = 'Testing...';
    statusDiv.style.display = 'block';
    statusDiv.style.background = 'var(--primary)';
    statusDiv.style.color = 'white';
    statusDiv.textContent = '🔄 Testing connection...';

    if (!esp32Client) {
        esp32Client = new ESP32Client();
    }

    const result = await esp32Client.testConnection(ip);

    if (result.success) {
        statusDiv.style.background = 'var(--success)';
        statusDiv.textContent = `✅ Test successful! Device is online. Uptime: `+(result.data.uptime || 'Unknown');
    } else {
        statusDiv.style.background = 'var(--danger)';
        statusDiv.textContent = `❌ Test failed: `+result.error;
    }

    testBtn.disabled = false;
    testBtn.textContent = 'Test Connection';
}

async function refreshAllData() {
    if (!esp32Client || !esp32Client.isConnected) {
        console.log('[App] Cannot refresh: ESP32 not connected');
        return;
    }

    try {
        // Refresh medications
        const meds = await esp32Client.getMedications();
        updateMedicationsDisplay(meds);

        // Refresh status
        const status = await esp32Client.getStatus();
        updateDeviceStatus(status);

        // Refresh history
        const history = await esp32Client.getHistory();
        updateHistoryDisplay(history);

        showAlert('✅ Data refreshed successfully', 'success');
    } catch (error) {
        console.error('[App] Refresh error:', error);
        showAlert('❌ Failed to refresh data: ' + error.message, 'error');
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    console.log('[App] Initializing...');

    // Initialize ESP32 client
    esp32Client = new ESP32Client();

    // Check connection status every 30 seconds
    setInterval(() => {
        if (esp32Client && esp32Client.isConnected) {
            esp32Client.getStatus().catch(err => {
                console.error('[App] Status check failed:', err);
                esp32Client.updateConnectionStatus(false);
            });
        }
    }, 30000);
});

// ============================================================
// ORIGINAL JAVASCRIPT CODE BELOW
// ============================================================

"@

    $jsFile = Join-Path $outputDir "app.js"
    ($apiClient + "`n`n" + $jsContent) | Out-File -FilePath $jsFile -Encoding UTF8
    Write-Host "✓ JavaScript extracted: $(($jsContent | Measure-Object -Line).Lines) lines" -ForegroundColor Green
    Write-Host "✓ ESP32 API client added: $(($apiClient | Measure-Object -Line).Lines) lines" -ForegroundColor Green
} else {
    Write-Host "✗ JavaScript extraction failed" -ForegroundColor Red
}

# Create simplified HTML
Write-Host "`nCreating minimal HTML..." -ForegroundColor Yellow
$htmlTemplate = @"
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes, minimum-scale=0.5, maximum-scale=3.0">
    <title>MediCare Assistant - Intelligent Elderly Care</title>

    <!-- PWA Meta -->
    <link rel="manifest" href="manifest.json">
    <meta name="theme-color" content="#4f46e5">
    <meta name="description" content="AI-powered medication management system for elderly care with ESP32 IoT integration">

    <!-- Preconnect -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">

    <!-- External Stylesheet -->
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <!-- Content will be loaded here -->
    <div id="app">Loading...</div>

    <!-- External JavaScript -->
    <script src="app.js"></script>
</body>
</html>
"@

# Note: The actual HTML structure is already in index.html created earlier
# This template is just for reference

Write-Host "✓ HTML template created" -ForegroundColor Green

# Create manifest.json
Write-Host "`nCreating PWA manifest..." -ForegroundColor Yellow
$manifest = @"
{
  "name": "MediCare Assistant",
  "short_name": "MediCare",
  "description": "AI-powered medication management system for elderly care",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#4f46e5",
  "orientation": "portrait",
  "icons": [
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any maskable"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ]
}
"@

$manifestFile = Join-Path $outputDir "manifest.json"
$manifest | Out-File -FilePath $manifestFile -Encoding UTF8
Write-Host "✓ Manifest created" -ForegroundColor Green

# Create Netlify config
Write-Host "`nCreating Netlify config..." -ForegroundColor Yellow
$netlifyConfig = @"
/*    /index.html   200
"@

$netlifyFile = Join-Path $outputDir "_redirects"
$netlifyConfig | Out-File -FilePath $netlifyFile -Encoding UTF8 -NoNewline
Write-Host "✓ Netlify _redirects created" -ForegroundColor Green

# Summary
Write-Host "`n"+"="*60 -ForegroundColor Cyan
Write-Host "FILE SEPARATION COMPLETE!" -ForegroundColor Green
Write-Host "="*60

Write-Host "`nGenerated files in website/ folder:" -ForegroundColor Yellow
Get-ChildItem $outputDir | ForEach-Object {
    $size = if ($_.PSIsContainer) { "DIR" } else { "{0:N0} KB" -f ($_.Length / 1KB) }
    Write-Host "  $($_.Name)".PadRight(30) $size -ForegroundColor White
}

Write-Host "`n📋 NEXT STEPS:" -ForegroundColor Cyan
Write-Host "1. Review generated files in website/ folder" -ForegroundColor White
Write-Host "2. Copy your original index.html body content if needed" -ForegroundColor White
Write-Host "3. Run: git add website/*" -ForegroundColor White
Write-Host "4. Run: git commit -m 'Separate HTML/CSS/JS architecture'" -ForegroundColor White
Write-Host "5. Run: git push origin main" -ForegroundColor White
Write-Host "6. Netlify will auto-deploy in ~60 seconds" -ForegroundColor White

Write-Host "`n✅ Script completed successfully!" -ForegroundColor Green
