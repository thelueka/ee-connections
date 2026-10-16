const { app, BrowserWindow, ipcMain, net, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let mainWindow;
let tray;
let reminderInterval;

// Reminder interval: check every 30 minutes (in milliseconds)
const REMINDER_INTERVAL_MS = 30 * 60 * 1000;

// Remote questions URL — raw GitHub file
// Update this after creating your repo (format: https://raw.githubusercontent.com/USERNAME/REPO/main/data/questions.json)
const REMOTE_QUESTIONS_URL = process.env.QUESTIONS_URL || "https://raw.githubusercontent.com/thelueka/ee-connections/main/data/questions.json";

// Leaderboard Lambda Function URL (account lueka-dev, us-west-2; see
// backend/deploy.md). LEADERBOARD_URL overrides it, e.g. for the local test
// server in test-leaderboard.ps1. Set to '' to disable the leaderboard.
const LEADERBOARD_URL = (process.env.LEADERBOARD_URL ||
  'https://u33gtnkqhgvhiwpjmb26ke3lma0gieha.lambda-url.us-west-2.on.aws').replace(/\/+$/, '');
const ALIAS_RE = /^[a-z][a-z0-9]{1,19}$/;

// Local calendar date (YYYY-MM-DD). The day rolls over at local midnight, not UTC.
function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Amazon laptops log in with the employee alias, so the OS username is the
// alias. EE_ALIAS overrides it for machines where that isn't true.
function getAlias() {
  const raw = process.env.EE_ALIAS || os.userInfo().username || '';
  const alias = raw.split('\\').pop().trim().toLowerCase();
  return ALIAS_RE.test(alias) ? alias : null;
}

// Pin the data folder to %APPDATA%\ee-connections so the installed app and a
// dev run (`npm start`) share the same progress.json instead of the packaged
// build silently starting over under its product name.
// For testing, EE_USER_DATA_DIR points at a throwaway profile instead.
app.setPath('userData', process.env.EE_USER_DATA_DIR ||
  path.join(app.getPath('appData'), 'ee-connections'));

// One copy at a time per profile: two trays writing the same progress.json
// would race. A second launch just brings up the existing window.
if (!app.requestSingleInstanceLock()) {
  app.exit(0); // exit immediately, before whenReady creates a tray or window
} else {
  app.on('second-instance', () => createWindow());
}

function getStoragePath() {
  return path.join(app.getPath('userData'), 'progress.json');
}

function loadProgress() {
  const storagePath = getStoragePath();
  if (fs.existsSync(storagePath)) {
    const data = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
    if (!data.installSeed) {
      data.installSeed = Math.floor(Math.random() * 2147483647);
      fs.writeFileSync(storagePath, JSON.stringify(data, null, 2));
    }
    return data;
  }
  const initial = {
    answers: {},
    streak: 0,
    lastAnsweredDate: null,
    installSeed: Math.floor(Math.random() * 2147483647)
  };
  fs.writeFileSync(storagePath, JSON.stringify(initial, null, 2));
  return initial;
}

function saveProgress(progress) {
  const storagePath = getStoragePath();
  fs.writeFileSync(storagePath, JSON.stringify(progress, null, 2));
}

function hasAnsweredToday() {
  const progress = loadProgress();
  return progress.lastAnsweredDate === localDate();
}

// ---------------------------------------------------------------------------
// Leaderboard sync
// ---------------------------------------------------------------------------

async function apiRequest(method, route, body) {
  const res = await net.fetch(`${LEADERBOARD_URL}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000)
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  return { status: res.status, data };
}

let registerAttempted = false;

// Returns { alias, token } or null if the leaderboard can't be used right now.
async function ensureRegistered(progress) {
  if (!LEADERBOARD_URL) return null;
  // Credentials belong to one server. A token from the local test server (or an
  // old deployment) is meaningless elsewhere, so re-register when it changes.
  const lb = progress.leaderboard && progress.leaderboard.server === LEADERBOARD_URL
    ? progress.leaderboard : {};
  if (lb.token && lb.alias) return lb;
  // If the alias was already claimed by another install, retry once per app
  // launch so an admin reset (see backend/deploy.md) fixes it without user action.
  if (lb.error && registerAttempted) return null;
  registerAttempted = true;

  const alias = getAlias();
  const server = LEADERBOARD_URL;
  if (!alias) {
    progress.leaderboard = { server, error: 'no-alias' };
    saveProgress(progress);
    return null;
  }

  const { status, data } = await apiRequest('POST', '/register', { alias });
  if (status === 200 && data.token) {
    progress.leaderboard = { server, alias: data.alias, token: data.token };
  } else if (status === 409) {
    progress.leaderboard = { server, alias, error: 'alias-taken' };
  } else {
    throw new Error(`register failed: HTTP ${status}`);
  }
  saveProgress(progress);
  return progress.leaderboard.token ? progress.leaderboard : null;
}

let syncInFlight = null;

// Uploads queued answers. Safe to call any time; failures leave the queue
// intact for the next attempt (app start, next answer, or opening the board).
function syncPending() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    const progress = loadProgress();
    if (!progress.pendingSync || progress.pendingSync.length === 0) return;
    const creds = await ensureRegistered(progress);
    if (!creds) return;

    const remaining = [];
    for (const item of progress.pendingSync) {
      try {
        const { status } = await apiRequest('POST', '/answer', {
          alias: creds.alias, token: creds.token, ...item
        });
        // 200 = recorded. 409 = server already has it. 400 = permanently
        // invalid (e.g. a queued date that is now too old). Drop all three.
        if (status >= 500 || status === 403 || status === 429) remaining.push(item);
      } catch {
        remaining.push(item); // offline or timeout
      }
    }
    const latest = loadProgress();
    latest.pendingSync = remaining;
    saveProgress(latest);
  })().catch((err) => console.log('Leaderboard sync failed:', err.message))
    .finally(() => { syncInFlight = null; });
  return syncInFlight;
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.restore();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(false);
    return;
  }

  mainWindow = new BrowserWindow({
    width: 520,
    height: 720,
    resizable: false,
    frame: true,
    backgroundColor: '#1a1a2e',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  // When user closes the window, hide it instead of quitting (app stays in tray)
  mainWindow.on('close', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });
}

// ---------------------------------------------------------------------------
// Start at login (installed builds only)
// ---------------------------------------------------------------------------

// A dev run is node_modules\electron\dist\electron.exe; registering that would
// launch a source checkout at login, so only installed builds touch this.
// Test profiles (EE_USER_DATA_DIR) also leave it alone, so a test run of an
// unpacked build can't register dist\win-unpacked as the login item.
const canAutoStart = app.isPackaged && process.platform !== 'linux' && !process.env.EE_USER_DATA_DIR;

// Fixed Run-key value name, so build/installer.nsh can remove it on uninstall.
// (The default name comes from the AppUserModelID and differs between builds.)
const LOGIN_ITEM = { path: process.execPath, name: 'EE Connections' };

function isAutoStartEnabled() {
  if (!canAutoStart) return false;
  const s = app.getLoginItemSettings(LOGIN_ITEM);
  // With a custom name, Windows reports the entry via executableWillLaunchAtLogin.
  return Boolean(s.openAtLogin || s.executableWillLaunchAtLogin);
}

function setAutoStart(enabled) {
  if (!canAutoStart) return;
  app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: enabled });
}

// On first run of an installed build, turn on start-at-login. Afterwards the
// tray checkbox is the source of truth, so turning it off sticks.
function initAutoStart() {
  if (!canAutoStart) return;
  const progress = loadProgress();
  if (!progress.autoStartConfigured) {
    setAutoStart(true);
    progress.autoStartConfigured = true;
    saveProgress(progress);
  }
  removeLegacyStartupShortcut();
}

// setup-autostart.ps1 used to put a shortcut in the Startup folder that runs a
// source checkout. With the installed app registered, that would start a second
// copy at login, so remove it, but only if it really is that dev shortcut.
function removeLegacyStartupShortcut() {
  if (process.platform !== 'win32') return;
  const lnk = path.join(app.getPath('appData'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'EE Connections.lnk');
  if (!fs.existsSync(lnk)) return;
  try {
    const { shell } = require('electron');
    const target = shell.readShortcutLink(lnk).target || '';
    if (/[\\/]node_modules[\\/]electron[\\/]dist[\\/]electron\.exe$/i.test(target)) {
      fs.unlinkSync(lnk);
      console.log('Removed legacy dev Startup shortcut:', lnk);
    }
  } catch (err) {
    console.log('Could not inspect Startup shortcut:', err.message);
  }
}

function createTray() {
  // The old inline 16x16 PNG was corrupt, so Windows drew an empty slot.
  // Windows picks the right size out of the multi-size .ico for the current
  // DPI; other platforms use tray.png (+ tray@2x.png for HiDPI).
  const iconFile = process.platform === 'win32' ? 'icon.ico' : 'tray.png';
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', iconFile));
  if (icon.isEmpty()) console.log(`Tray icon failed to load: assets/${iconFile}`);
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open EE Connections', click: () => createWindow() },
    { type: 'separator' },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: isAutoStartEnabled(),
      enabled: canAutoStart,
      click: (item) => setAutoStart(item.checked)
    },
    { type: 'separator' },
    { label: 'Quit', click: () => {
      // Actually quit — remove the close handler
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.removeAllListeners('close');
        mainWindow.close();
      }
      app.quit();
    }}
  ]);

  tray.setToolTip('EE Connections');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => createWindow());
}

function startReminderLoop() {
  // Check immediately on startup
  if (!hasAnsweredToday()) {
    createWindow();
  }

  // Then check periodically
  reminderInterval = setInterval(() => {
    if (!hasAnsweredToday()) {
      createWindow();
    }
  }, REMINDER_INTERVAL_MS);
}

app.whenReady().then(() => {
  initAutoStart();
  createTray();
  startReminderLoop();
  syncPending();
});

// Prevent app from quitting when all windows are closed (stays in tray)
app.on('window-all-closed', (event) => {
  // Do nothing — keep running in tray
});

app.on('activate', () => {
  createWindow();
});

// IPC handlers
ipcMain.handle('get-questions', async () => {
  // The bundled copy lives inside app.asar, which is read-only in an installed
  // build, so newer questions are cached in the user data folder instead.
  const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'questions.json'), 'utf-8'));
  const cachePath = path.join(app.getPath('userData'), 'questions-cache.json');
  let best = bundled;
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (Array.isArray(cached) && cached.length > best.length) best = cached;
  } catch { /* no cache yet */ }

  try {
    const remote = await fetchRemoteQuestions();
    if (remote.length > best.length) {
      fs.writeFileSync(cachePath, JSON.stringify(remote));
      best = remote;
    }
  } catch (err) {
    console.log('Remote fetch failed, using local questions:', err.message);
  }

  return best;
});

// Electron's net.request has no setTimeout(), so the old version threw on every
// call and the app never picked up new questions. net.fetch supports an abort signal.
async function fetchRemoteQuestions() {
  const res = await net.fetch(REMOTE_QUESTIONS_URL, {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const questions = await res.json();
  if (!Array.isArray(questions)) throw new Error('questions.json is not an array');
  return questions;
}

ipcMain.handle('get-progress', () => {
  return loadProgress();
});

ipcMain.handle('save-answer', (event, { questionId, answer, correct }) => {
  const progress = loadProgress();
  const today = localDate();

  progress.answers[questionId] = { answer, correct, date: today };

  // Queue for the leaderboard. The server re-grades from its own answer key.
  progress.pendingSync = progress.pendingSync || [];
  progress.pendingSync.push({ questionId, selectedIndex: answer, date: today });

  if (progress.lastAnsweredDate) {
    const lastDate = new Date(progress.lastAnsweredDate);
    const todayDate = new Date(today);
    const diffDays = Math.floor((todayDate - lastDate) / (1000 * 60 * 60 * 24));

    if (diffDays === 1) {
      progress.streak += 1;
    } else if (diffDays > 1) {
      progress.streak = 1;
    }
  } else {
    progress.streak = 1;
  }

  progress.lastAnsweredDate = today;
  saveProgress(progress);
  syncPending(); // fire and forget; never blocks the answer UI
  return progress;
});

ipcMain.handle('get-leaderboard', async () => {
  if (!LEADERBOARD_URL) return { status: 'disabled' };
  try {
    await syncPending(); // so the board includes today's answer
    const progress = loadProgress();
    const creds = await ensureRegistered(progress);
    if (!creds) {
      const reason = progress.leaderboard && progress.leaderboard.error;
      return { status: reason || 'unavailable', alias: progress.leaderboard && progress.leaderboard.alias };
    }
    const query = `?alias=${encodeURIComponent(creds.alias)}&date=${localDate()}`;
    const { status, data } = await apiRequest('GET', `/leaderboard${query}`);
    if (status !== 200) return { status: 'unavailable' };
    return { status: 'ok', alias: creds.alias, ...data };
  } catch (err) {
    console.log('Leaderboard fetch failed:', err.message);
    return { status: 'offline' };
  }
});

ipcMain.handle('get-stats', () => {
  const progress = loadProgress();
  const total = Object.keys(progress.answers).length;
  const correct = Object.values(progress.answers).filter(a => a.correct).length;
  return {
    total,
    correct,
    streak: progress.streak,
    accuracy: total > 0 ? Math.round((correct / total) * 100) : 0
  };
});
