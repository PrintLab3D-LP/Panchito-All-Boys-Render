const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || '3000';
process.env.PORT = PORT;
process.env.ELECTRON_DESKTOP = '1';

function ensureWritableDatabase() {
  const userData = app.getPath('userData');
  const targetDir = path.join(userData, 'data');
  const targetDb = path.join(targetDir, 'db.json');
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  if (!fs.existsSync(targetDb)) {
    const candidates = [
      path.join(process.resourcesPath || '', 'data', 'db.json'),
      path.join(__dirname, '..', 'data', 'db.json')
    ];
    const sourceDb = candidates.find(p => p && fs.existsSync(p));
    if (sourceDb) fs.copyFileSync(sourceDb, targetDb);
    else fs.writeFileSync(targetDb, '{}');
  }
  process.env.DB_PATH = targetDb;
}

function startServer() {
  ensureWritableDatabase();
  require(path.join(__dirname, '..', 'server.js'));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1100,
    minHeight: 680,
    title: 'Panchito Enterprise',
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#0b0b49',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  win.setMenuBarVisibility(false);
  win.loadURL(`http://localhost:${PORT}`);

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  startServer();
  setTimeout(createWindow, 700);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
