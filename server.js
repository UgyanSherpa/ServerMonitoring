// ============================================================
//  server.js — Personal Server Monitoring Dashboard
// ============================================================

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const http    = require('http');
const https   = require('https');
const multer  = require('multer');

const app  = express();
const PORT = process.env.PORT || 3000;

// ---------- Middleware (order matters!) ----------
app.use(express.urlencoded({ extended: true }));          // parse HTML form bodies
app.use(express.json());                                  // parse JSON bodies
app.use(express.static(path.join(__dirname, 'public')));  // serve static files

// ---------- Upload directory ----------
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ---------- Multer setup (for icon uploads) ----------
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// ============================================================
//  IN-MEMORY STATE
// ============================================================
const history = [];          // rolling window of metric snapshots
const MAX_HISTORY = 300;     // 300 * 2s = ~10 minutes
const services = [];         // list of monitored URLs
let nextServiceId = 1;

// ============================================================
//  METRIC COLLECTION (uses Node's built-in os module)
// ============================================================

// Grab raw CPU tick counts
function getCpuTicks() {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const cpu of cpus) {
        for (const t of Object.values(cpu.times)) total += t;
        idle += cpu.times.idle;
    }
    return { idle, total };
}

// CPU % is the delta between two reads
let prevCpu = getCpuTicks();
function cpuPercent() {
    const now = getCpuTicks();
    const idleDiff  = now.idle  - prevCpu.idle;
    const totalDiff = now.total - prevCpu.total;
    prevCpu = now;
    if (totalDiff === 0) return 0;
    return Math.max(0, Math.min(100, Math.round((1 - idleDiff / totalDiff) * 100)));
}

// Recursively compute a directory's size (proxy for "disk usage")
function getDirSize(dir) {
    let size = 0;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) size += getDirSize(full);
            else size += fs.statSync(full).size;
        }
    } catch (_) { /* ignore */ }
    return size;
}

// Build one snapshot of the system
function collectMetrics() {
    const totalMem = os.totalmem();
    const freeMem  = os.freemem();
    const usedMem  = totalMem - freeMem;
    const procMem  = process.memoryUsage();
    const diskBytes = getDirSize(__dirname);

    return {
        timestamp:     Date.now(),
        cpu:           cpuPercent(),
        memPercent:    Math.round((usedMem / totalMem) * 100),
        memUsedMB:     Math.round(usedMem / 1024 / 1024),
        memTotalMB:    Math.round(totalMem / 1024 / 1024),
        processMemMB:  Math.round(procMem.rss / 1024 / 1024),
        diskMB:        Math.round(diskBytes / 1024 / 1024),
        uptime:        Math.round(process.uptime()),   // this app's uptime
        systemUptime:  Math.round(os.uptime()),        // OS uptime
        loadavg:       Number(os.loadavg()[0].toFixed(2)),
        hostname:      os.hostname(),
        platform:      os.platform()
    };
}

// ============================================================
//  BACKGROUND TASKS
// ============================================================
setInterval(() => {
    history.push(collectMetrics());
    if (history.length > MAX_HISTORY) history.shift();
}, 2000);

// ============================================================
//  SERVICE PINGING (uses http/https module)
// ============================================================
function pingService(service) {
    return new Promise((resolve) => {
        const start = Date.now();
        const lib = service.url.startsWith('https') ? https : http;

        const req = lib.get(service.url, { timeout: 5000 }, (res) => {
            service.status       = (res.statusCode >= 200 && res.statusCode < 400) ? 'up' : 'down';
            service.statusCode   = res.statusCode;
            service.responseTime = Date.now() - start;
            service.lastChecked  = Date.now();
            res.resume();   // discard body
            resolve();
        });

        req.on('error', () => {
            service.status = 'down';
            service.responseTime = null;
            service.lastChecked = Date.now();
            resolve();
        });
        req.on('timeout', () => {
            req.destroy();
            service.status = 'down';
            service.responseTime = null;
            service.lastChecked = Date.now();
            resolve();
        });
    });
}

// Ping all services every 10 s
setInterval(async () => {
    for (const svc of services) await pingService(svc);
}, 10000);

// ============================================================
//  ROUTES
// ============================================================

// ---- Query string parameter example ----
// GET /api/metrics?limit=60
app.get('/api/metrics', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 30, MAX_HISTORY);
    res.json({
        current: history[history.length - 1] || collectMetrics(),
        history: history.slice(-limit)
    });
});

// ---- Route parameter example ----
// GET /api/metric/cpu   →  { "cpu": 12 }
app.get('/api/metric/:type', (req, res) => {
    const type = req.params.type;
    const latest = history[history.length - 1] || collectMetrics();
    if (!(type in latest)) {
        return res.status(400).json({ error: `Unknown metric: ${type}` });
    }
    res.json({ [type]: latest[type] });
});

// ---- Server-Sent Events: live metric stream ----
app.get('/api/metrics/stream', (req, res) => {
    res.set({
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    // Send current snapshot immediately
    send(history[history.length - 1] || collectMetrics());

    // Then every 2 s
    const interval = setInterval(() => {
        send(history[history.length - 1] || collectMetrics());
    }, 2000);

    req.on('close', () => clearInterval(interval));
});

// ---- Service list (AJAX) ----
app.get('/api/services', (req, res) => res.json(services));

// ---- Add service (POST with url-encoded body) ----
app.post('/api/services', (req, res) => {
    const { name, url } = req.body;
    if (!name || !url) return res.status(400).send('Name and URL required.');

    const service = {
        id: nextServiceId++, name, url,
        status: 'unknown', statusCode: null,
        responseTime: null, lastChecked: null
    };
    services.push(service);
    pingService(service);            // ping immediately, don't wait
    res.redirect('/');
});

// ---- Remove service (route parameter) ----
app.get('/api/services/:id/delete', (req, res) => {
    const id = parseInt(req.params.id);
    const i = services.findIndex(s => s.id === id);
    if (i >= 0) services.splice(i, 1);
    res.redirect('/');
});

// ---- Upload a dashboard icon (multipart/form-data) ----
app.post('/upload', upload.single('icon'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    res.redirect('/');
});

// ---- Download CSV of metrics history ----
app.get('/download/history.csv', (req, res) => {
    const header = 'timestamp,cpu,memPercent,memUsedMB,memTotalMB,processMemMB,diskMB,uptime\n';
    const rows = history.map(m =>
        `${new Date(m.timestamp).toISOString()},${m.cpu},${m.memPercent},${m.memUsedMB},${m.memTotalMB},${m.processMemMB},${m.diskMB},${m.uptime}`
    ).join('\n');

    const filePath = path.join(__dirname, 'history.csv');
    fs.writeFileSync(filePath, header + rows);
    res.download(filePath, 'server-history.csv');
});

// ============================================================
//  API ENDPOINTS FOR THE CLASS HUB  (Week 3_2 PDF)
// ============================================================

// The hub asks: "What is your project called?"
app.get('/api/getName', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.json({ name: 'Personal Server Monitoring Dashboard' });  // ← change if you like
});

// The hub asks: "Give me your project's image"
app.get('/api/getImage', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.sendFile(path.join(__dirname, 'public', 'thumbnail.png'));
});

// ============================================================
//  CUSTOM 404 & 500 HANDLERS  (MUST be last!)
// ============================================================

// 404 — no route matched
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// 500 — 4 parameters marks this as an error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).sendFile(path.join(__dirname, 'public', '500.html'));
});

// ============================================================
//  START
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Dashboard running on http://localhost:${PORT}`);
});