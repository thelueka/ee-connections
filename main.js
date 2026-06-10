const { app, BrowserWindow, ipcMain, net, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let tray;
let reminderInterval;

// Reminder interval: check every 2 hours (in milliseconds)
const REMINDER_INTERVAL_MS = 2 * 60 * 60 * 1000;

// Remote questions URL — raw GitHub file
// Update this after creating your repo (format: https://raw.githubusercontent.com/USERNAME/REPO/main/data/questions.json)
const REMOTE_QUESTIONS_URL = process.env.QUESTIONS_URL || "https://raw.githubusercontent.com/thelueka/ee-connections/main/data/questions.json";

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
  const today = new Date().toISOString().split('T')[0];
  return progress.lastAnsweredDate === today;
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 520,
    height: 680,
    resizable: false,
    frame: true,
    backgroundColor: '#1a1a2e',
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

function createTray() {
  // Create a simple tray icon (16x16 colored square)
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOklEQVQ4T2P8z8DwHwMNACMDAwMjNQwy/GdgYGCkhoF4DaCKIYPeACZqhAI1DABppsYoGPQGUCMfAABmVxAR5mluHAAAAABJRU5ErkJggg=='
  );
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open EE Connections', click: () => createWindow() },
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
  createTray();
  startReminderLoop();
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
  const questionsPath = path.join(__dirname, 'data', 'questions.json');
  const bundled = JSON.parse(fs.readFileSync(questionsPath, 'utf-8'));

  try {
    const remote = await fetchRemoteQuestions();
    if (remote && remote.length > bundled.length) {
      fs.writeFileSync(questionsPath, JSON.stringify(remote, null, 2));
      return remote;
    }
  } catch (err) {
    console.log('Remote fetch failed, using bundled questions:', err.message);
  }

  return bundled;
});

async function fetchRemoteQuestions() {
  return new Promise((resolve, reject) => {
    const request = net.request(REMOTE_QUESTIONS_URL);
    let data = '';

    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.on('data', (chunk) => { data += chunk.toString(); });
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });

    request.on('error', reject);
    request.setTimeout(5000, () => {
      request.abort();
      reject(new Error('Timeout'));
    });

    request.end();
  });
}

ipcMain.handle('get-progress', () => {
  return loadProgress();
});

ipcMain.handle('save-answer', (event, { questionId, answer, correct }) => {
  const progress = loadProgress();
  const today = new Date().toISOString().split('T')[0];

  progress.answers[questionId] = { answer, correct, date: today };

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
  return progress;
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
