const { BrowserWindow, app, ipcMain } = require('electron');
const path = require('path');
const { saveConfigAsProfile, setActiveProfile, listProfiles, validateProfileName } = require('./configManager');

const profileWindow = {
  _saveWindow: null,

  register(ipcMain, AppContext) {
    AppContext.callbacks['menu:save-as-profile'] = () => this.openSaveDialog(AppContext);

    AppContext.callbacks['menu:switch-profile'] = (name) => {
      const trimmed = typeof name === 'string' ? name.trim() : '';
      setActiveProfile(trimmed);
      AppContext.log(`Switching to profile "${trimmed || 'Default'}", relaunching...`);
      app.relaunch();
      app.exit(0);
    };

    ipcMain.handle('profile-dialog:confirm', async (event, name) => {
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!validateProfileName(trimmed)) {
        return { error: `Invalid profile name: "${trimmed}"` };
      }
      try {
        saveConfigAsProfile(trimmed, AppContext.config);
        setActiveProfile(trimmed);
        AppContext.log(`Saved profile "${trimmed}", relaunching...`);
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) win.close();
        app.relaunch();
        app.exit(0);
        return { success: true };
      } catch (err) {
        AppContext.error(`Failed to save profile: ${err.message}`);
        return { error: err.message };
      }
    });

    ipcMain.handle('profile-dialog:cancel', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) win.close();
      return { success: true };
    });

    ipcMain.handle('get-profiles', () => listProfiles());

    ipcMain.handle('switch-profile', (_event, name) => {
      const trimmed = typeof name === 'string' ? name.trim() : '';
      setActiveProfile(trimmed);
      app.relaunch();
      app.exit(0);
      return { success: true };
    });
  },

  openSaveDialog(AppContext) {
    if (this._saveWindow && !this._saveWindow.isDestroyed()) {
      this._saveWindow.focus();
      return;
    }

    const htmlPath = app.isPackaged
      ? path.join(process.resourcesPath, 'http_admin', 'profile-dialog.html')
      : path.join(app.getAppPath(), 'http_admin', 'profile-dialog.html');

    const isWin   = process.platform === 'win32';
    const isLinux = process.platform === 'linux';
    const iconPath = path.join(app.getAppPath(), 'assets', isWin ? 'icon.ico' : isLinux ? 'icon.png' : 'icon.png');

    this._saveWindow = new BrowserWindow({
      width: 520,
      height: 408,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      backgroundColor: '#0c162a',
      icon: iconPath,
      parent: AppContext.win || undefined,
      modal: false,
      webPreferences: {
        preload: path.join(app.getAppPath(), 'preload_profile_dialog.js')
      }
    });

    this._saveWindow.on('closed', () => { this._saveWindow = null; });
    this._saveWindow.loadFile(htmlPath);
  }
};

module.exports = { profileWindow };
