# ⚡ EE Connections

A daily electrical engineering trivia app inspired by Amazon's Connections. One question per day covering circuit analysis, semiconductors, digital logic, signals & systems, power electronics, electromagnetics, and control systems.

## Quick Start

```bash
npm install
npm start
```

## Auto-Start on Login (Windows)

The installed app (from the `.exe` installer) turns on start-at-login the first time it runs. Toggle it with **Start at login** in the tray icon's menu; uninstalling removes it. It also deletes any old dev shortcut created by `setup-autostart.ps1`.

The scripts below are only for running from source (`npm start`). To make a source checkout pop up at login, run the setup script once:

```powershell
powershell -ExecutionPolicy Bypass -File setup-autostart.ps1
```

This creates a Windows Task Scheduler task — no terminal window stays open, and the app launches cleanly on each login.

To remove auto-start later:

```powershell
powershell -ExecutionPolicy Bypass -File remove-autostart.ps1
```

## Build Distributable

```bash
# Windows installer (.exe)
npm run build

# macOS (.dmg)
npm run build:mac

# Linux (.AppImage)
npm run build:linux
```

The installer will appear in the `dist/` folder.

## Features

- 📅 One question per day (same question for everyone on the same date)
- 📊 Streak tracking and accuracy stats
- 💡 Detailed explanations after each answer
- 🎨 Clean, dark-themed UI
- 📦 Easily distributable as a standalone desktop app
- 🚀 Auto-start on login (optional, Windows)
- 🏆 Weekly and all-time leaderboards by Amazon alias (setup in `backend/deploy.md`)

## Adding Questions

Edit `data/questions.json` to add more questions. Each question follows this format:

```json
{
  "id": 51,
  "category": "circuit_analysis",
  "question": "Your question here?",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "answer": 0,
  "explanation": "Explanation of the correct answer."
}
```

### Categories
- `circuit_analysis`
- `semiconductor_physics`
- `digital_logic`
- `signals_and_systems`
- `power_electronics`
- `electromagnetics`
- `control_systems`
- `aerospace`
- `digital_signal_processing`
- `optical_communications`

## Distribution

After running `npm run build`, share the installer from the `dist/` folder:
- **Windows**: `dist/EE Connections Setup X.X.X.exe`
- **macOS**: `dist/EE Connections-X.X.X.dmg`
- **Linux**: `dist/EE Connections-X.X.X.AppImage`

Recipients don't need Node.js or any development tools — just run the installer.
