// misc ipcMain handlers

const { shell, dialog, BrowserWindow, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { saveConfig } = require('./configManager');
const { app } = require('electron');
const { generateDocumentationPresentations } = require('./docsPresentationBuilder');
const { pairWithPeer, unpairPeer } = require('./peerPairing');
const { sendPeerCommand, peerCommandClient } = require('./peerCommandClient');
const { presentationWindow } = require('./presentationWindow');
const { generateThemeThumbnails } = require('./themeThumbnailer');
const { checkForUpdates } = require('./updateChecker');
const { installMarkdownTestPresentation } = require('./testPresentationInstaller');

// Hidden BrowserWindow used to render the next slide for thumbnail capture.
// Initialized eagerly when the presentation starts so it's warm by the time
// the user advances to a new slide. Never shown to the user.
let _captureWin = null;
let _captureWinBaseUrl = null;
let _captureWinReadyPromise = null;

async function _getReadyCaptureWindow(AppContext, presUrl) {
  let baseUrl;
  try {
    const u = new URL(presUrl);
    u.searchParams.delete('_cap');
    u.hash = '';
    baseUrl = u.toString();
  } catch {
    return null;
  }

  if (_captureWin && !_captureWin.isDestroyed() && _captureWinBaseUrl === baseUrl) {
    try { await _captureWinReadyPromise; } catch { return null; }
    return _captureWin && !_captureWin.isDestroyed() ? _captureWin : null;
  }

  if (_captureWin && !_captureWin.isDestroyed()) _captureWin.destroy();

  _captureWinBaseUrl = baseUrl;
  _captureWin = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 1280,
    height: 720,
    webPreferences: { nodeIntegration: false, contextIsolation: true, offscreen: true }
  });
  _captureWin.on('closed', () => {
    if (_captureWinBaseUrl === baseUrl) {
      _captureWin = null;
      _captureWinBaseUrl = null;
      _captureWinReadyPromise = null;
    }
  });

  const loadUrl = new URL(presUrl);
  loadUrl.searchParams.set('_cap', '1');
  loadUrl.hash = '';

  _captureWinReadyPromise = (async () => {
    await _captureWin.loadURL(loadUrl.toString());
    await _captureWin.webContents.insertCSS(
      '*, *::before, *::after { transition: none !important; animation: none !important; animation-duration: 0s !important; }'
    );
    await _captureWin.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        let n = 0;
        const check = () => {
          if (window.deck && typeof window.deck.isReady === 'function' && window.deck.isReady()) {
            window.deck.configure({ transition: 'none', backgroundTransition: 'none', autoAnimate: false, transitionSpeed: 'default' });
            document.querySelectorAll('.reveal .slides section[data-auto-animate]').forEach(el => {
              el.removeAttribute('data-auto-animate');
            });
            window.deck.slide(0, 0);
            resolve();
          } else if (++n > 100) {
            reject(new Error('deck not ready'));
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      })
    `);
  })();

  try {
    await _captureWinReadyPromise;
  } catch (e) {
    AppContext.log('[remote] capture window init failed:', e?.message);
    if (_captureWin && !_captureWin.isDestroyed()) _captureWin.destroy();
    return null;
  }
  return _captureWin && !_captureWin.isDestroyed() ? _captureWin : null;
}

function normalizeAttribution(item) {
  const candidates = [
    item?.attribution,
    item?.attrib,
    item?.credit,
    item?.creator,
    item?.author,
    item?.copyright
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeAiFlag(item) {
  const raw = item?.ai ?? item?.ai_generated ?? item?.aigenerated ?? item?.aiGenerated;
  if (raw === true) return true;
  if (typeof raw === 'number') return raw > 0;
  if (typeof raw === 'string') {
    const val = raw.trim().toLowerCase();
    if (!val) return false;
    if (['yes', 'y', 'true', '1', 'ai', 'ai-generated', 'aigenerated', 'generated', 'gen'].includes(val)) {
      return true;
    }
    if (['no', 'n', 'false', '0'].includes(val)) return false;
  }
  return false;
}

function readSidecarMetadata(presDir, filename) {
  const exactMetaPath = path.join(presDir, `${filename}.json`);
  const baseMetaPath = path.join(
    presDir,
    `${path.basename(filename, path.extname(filename))}.json`
  );
  const candidates = [exactMetaPath, baseMetaPath];
  for (const metaPath of candidates) {
    if (!fs.existsSync(metaPath)) continue;
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch (err) {
      return null;
    }
  }
  return null;
}

function normalizeZoomFactor(value, fallback = 1) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(3, Math.max(0.5, parsed));
}

const otherEventHandlers = {
    register(ipcMain, AppContext) {

        // Handle opening external URLs
        ipcMain.on('open-external-url', (_event, href) => {
            AppContext.log('[main] Opening external URL:', href);
            shell.openExternal(href);
        });

        ipcMain.handle('read-clipboard-text', () => {
          try {
            return clipboard.readText() || '';
          } catch (err) {
            AppContext.error('Failed to read clipboard text:', err.message);
            return '';
          }
        });

        ipcMain.handle('read-clipboard-html', () => {
          try {
            return clipboard.readHTML() || '';
          } catch (err) {
            AppContext.error('Failed to read clipboard HTML:', err.message);
            return '';
          }
        });

        // Show the folder containing the presentation files
        ipcMain.handle('show-presentation-folder', async (_event, slug) => {
          const folder = path.join(AppContext.config.presentationsDir, slug);
          if (fs.existsSync(folder)) {
            shell.openPath(folder); // Opens the folder in file browser
            return { success: true };
          } else {
            return { success: false, error: 'Folder not found' };
          }
        });

        ipcMain.handle('delete-presentation', async (_event, slug, mdFile = 'presentation.md') => {
          const presentationsRoot = path.resolve(AppContext.config.presentationsDir);
          const presDir = path.resolve(presentationsRoot, slug || '');
          if (!presDir.startsWith(presentationsRoot + path.sep)) {
            return { success: false, error: 'Invalid presentation path' };
          }
          if (presDir === presentationsRoot) {
            return { success: false, error: 'Invalid presentation folder' };
          }

          const mdPath = path.resolve(presDir, mdFile || 'presentation.md');
          if (!mdPath.startsWith(presDir + path.sep)) {
            return { success: false, error: 'Invalid presentation file' };
          }

          if (!fs.existsSync(mdPath)) {
            return { success: false, error: 'Presentation file not found' };
          }

          const confirmationMessage = `Are you sure you want to delete this entire presentation (${slug}/${mdFile})? This process is irreversable.`;
          const { response } = await dialog.showMessageBox({
            type: 'warning',
            title: 'Delete Presentation',
            message: confirmationMessage,
            buttons: ['Delete', 'Cancel'],
            defaultId: 1,
            cancelId: 1
          });

          if (response !== 0) {
            return { success: false, canceled: true };
          }

          try {
            fs.unlinkSync(mdPath);
            const remainingMarkdown = fs.readdirSync(presDir)
              .filter((entry) => entry.toLowerCase().endsWith('.md'))
              .filter((entry) => fs.statSync(path.join(presDir, entry)).isFile());

            if (!remainingMarkdown.length) {
              fs.rmSync(presDir, { recursive: true, force: true });
              return { success: true, folderDeleted: true };
            }

            return { success: true, folderDeleted: false };
          } catch (err) {
            AppContext.error('Delete presentation failed:', err);
            return { success: false, error: err.message };
          }
        });

        // Handle opening the presentation in the default editor
        ipcMain.handle('edit-presentation', async (_event, slug, mdFile = 'presentation.md') => {
          const filePath = path.join(AppContext.config.presentationsDir, slug, mdFile);
          if (fs.existsSync(filePath)) {
            return shell.openPath(filePath); // Opens in system default editor
          } else {
            throw new Error(`File not found: ${filePath}`);
          }
        });

        ipcMain.handle('get-app-config', () => {
          const safeConfig = { ...AppContext.config };
          delete safeConfig.rsaPrivateKey;
          delete safeConfig.mdnsAuthToken;
          return {
            ...safeConfig,
            allPluginFolders: AppContext.allPluginFolders || [],
            hostURL: AppContext.hostURL,
            hostLANURL: AppContext.hostLANURL
          };
        });

        ipcMain.handle('list-presentation-images', async (_event, slug) => {
          if (!slug) return [];
          const safeSlug = path.basename(String(slug));
          const presDir = path.join(AppContext.config.presentationsDir, safeSlug);
          if (!fs.existsSync(presDir)) return [];
          const allowedExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);
          const entries = fs.readdirSync(presDir, { withFileTypes: true });
          const images = [];
          for (const entry of entries) {
            if (!entry.isFile()) continue;
            const filename = entry.name;
            if (filename.toLowerCase() === 'thumbnail.jpg') continue;
            const ext = path.extname(filename).toLowerCase();
            if (!allowedExts.has(ext)) continue;
            const meta = readSidecarMetadata(presDir, filename);
            images.push({
              filename,
              attribution: meta ? normalizeAttribution(meta) : '',
              ai: meta ? normalizeAiFlag(meta) : false
            });
          }
          images.sort((a, b) => a.filename.localeCompare(b.filename));
          return images;
        });

        ipcMain.handle('check-for-updates', async (_event, options = {}) => {
          return checkForUpdates(AppContext, { force: !!options.force });
        });

        ipcMain.handle('save-app-config', (_event, updates) => {
          if (updates?.mdnsPairingPin && typeof updates.mdnsPairingPin === 'string') {
            updates.mdnsPairingPin = updates.mdnsPairingPin.trim();
          }
          const enablingMdns = updates?.mdnsPublish === true;
          const existingPin = AppContext.config.mdnsPairingPin;
          const providedPin = updates?.mdnsPairingPin;
          if (enablingMdns && !providedPin && !existingPin) {
            const length = 6;
            const min = 10 ** (length - 1);
            const max = 10 ** length - 1;
            updates.mdnsPairingPin = String(Math.floor(Math.random() * (max - min + 1)) + min);
          }
          if (Object.prototype.hasOwnProperty.call(updates || {}, 'zoomFactor')) {
            updates.zoomFactor = normalizeZoomFactor(updates.zoomFactor, normalizeZoomFactor(AppContext.config.zoomFactor, 1));
          }
          Object.assign(AppContext.config, updates);
          AppContext.config.zoomFactor = normalizeZoomFactor(AppContext.config.zoomFactor, 1);
          saveConfig(AppContext.config);
          if (typeof AppContext.applyZoomFactorToAllWindows === 'function') {
            AppContext.applyZoomFactorToAllWindows(AppContext.config.zoomFactor);
          } else {
            BrowserWindow.getAllWindows().forEach((window) => {
              if (window && !window.isDestroyed()) {
                window.webContents.setZoomFactor(AppContext.config.zoomFactor);
              }
            });
          }
          presentationWindow.refreshGlobalHotkeys?.(AppContext);
          presentationWindow.syncUrlPublishForConfig?.(AppContext);
          if (!presentationWindow.canActivatePersistentScreens?.(AppContext.config)) {
            presentationWindow.deactivateAlwaysOpenScreens?.();
          } else if (presentationWindow.isAlwaysOpenModeActive?.()) {
            presentationWindow.refreshAlwaysOpenPresentationWindowsForConfig?.(AppContext).catch((err) => {
              AppContext.error(`Failed to refresh always-open presentation windows after config save: ${err.message}`);
            });
          }
          return { success: true };
        });

        ipcMain.handle('reset-key', () => {
          const newKey = [...Array(10)].map(() => Math.random().toString(36)[2]).join('');
          AppContext.config.key = newKey;
          saveConfig(AppContext.config);
          return newKey;
        });

        ipcMain.handle('open-screens', async () => {
          const result = await presentationWindow.activateAlwaysOpenScreens(AppContext);
          return result;
        });

        ipcMain.handle('close-screens', async () => {
          presentationWindow.deactivateAlwaysOpenScreens();
          await presentationWindow.forceCloseMainPresentationWindow(AppContext);
          await sendPeerCommand(AppContext, { type: 'close-presentation', payload: {} });
          return { success: true };
        });

        ipcMain.handle('select-presentations-dir', async () => {
          const { dialog } = require('electron');
          const { canceled, filePaths } = await dialog.showOpenDialog({
            title: 'Select Presentations Folder',
            properties: ['openDirectory']
          });

          if (canceled || !filePaths.length) return null;
          return filePaths[0];
        });

        ipcMain.handle('save-current-presentation', async (_event, data) => {
          try {
            const storeFile = path.join(app.getPath('userData'), 'currentPresentation.json');
            fs.writeFileSync(storeFile, JSON.stringify(data, null, 2));
            AppContext.log(`💾 Saved current presentation: ${data.slug}`);
            return { success: true };
          } catch (err) {
            AppContext.error('Failed to save current presentation:', err);
            return { success: false, error: err.message };
          }
        });

        ipcMain.handle('get-current-presentation', async () => {
          try {
            const storeFile = path.join(app.getPath('userData'), 'currentPresentation.json');
            if (fs.existsSync(storeFile)) {
              const data = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
              return data;
            }
            return null;
          } catch (err) {
            AppContext.error('Failed to load current presentation:', err);
            return null;
          }
        });

        ipcMain.handle('clear-current-presentation', async () => {
          try {
            const storeFile = path.join(app.getPath('userData'), 'currentPresentation.json');
            if (fs.existsSync(storeFile)) fs.unlinkSync(storeFile);
            AppContext.log('🗑️ Cleared current presentation');
            return { success: true };
          } catch (err) {
            AppContext.error('Failed to clear current presentation:', err);
            return { success: false, error: err.message };
          }
        });

        ipcMain.handle('get-display-list', () => {
          const { screen } = require('electron');
          return screen.getAllDisplays();
        });

        // Capture the current slide from the live presentation window
        ipcMain.handle('capture-presentation-slide', async (event) => {
          const image = await event.sender.capturePage();
          const resized = image.resize({ width: 640 });
          return resized.toJPEG(75).toString('base64');
        });

        // Pre-warm the hidden capture window as soon as the presentation starts.
        ipcMain.handle('init-capture-window', (_event, presUrl) => {
          if (!presUrl) return;
          _getReadyCaptureWindow(AppContext, presUrl).catch(() => {});
        });

        // Capture a slide thumbnail by navigating the hidden window to the target slide.
        ipcMain.handle('capture-next-slide', async (_event, presUrl, h, v, f) => {
          if (!presUrl) return null;
          const nextH = parseInt(h, 10);
          const nextV = parseInt(v, 10);
          if (isNaN(nextH) || isNaN(nextV)) return null;
          const nextF = (f !== null && f !== undefined && !isNaN(parseInt(String(f), 10)))
            ? parseInt(String(f), 10) : null;
          try {
            const win = await _getReadyCaptureWindow(AppContext, presUrl);
            if (!win) return null;

            await win.webContents.executeJavaScript(`
              new Promise((resolve) => {
                const tH = ${nextH}, tV = ${nextV}, tF = ${nextF !== null ? nextF : 'null'};

                window.deck.configure({
                  transition: 'none',
                  backgroundTransition: 'none',
                  autoAnimate: false,
                  transitionSpeed: 'default'
                });

                const finish = (() => {
                  let done = false;
                  return () => {
                    if (done) return;
                    done = true;

                    document.getAnimations().forEach(a => a.cancel());

                    document.querySelectorAll(
                      '.reveal .slides section.present, .reveal .slide-background.present'
                    ).forEach(el => {
                      el.style.setProperty('display', 'block', 'important');
                      el.style.removeProperty('opacity');
                      el.style.removeProperty('visibility');
                    });

                    document.querySelectorAll(
                      '.reveal .slides section:not(.present), .reveal .slide-background:not(.present)'
                    ).forEach(el => {
                      el.style.setProperty('display', 'none', 'important');
                      el.style.setProperty('opacity', '0', 'important');
                      el.style.setProperty('visibility', 'hidden', 'important');
                    });

                    document.querySelectorAll('style').forEach(s => {
                      if (s.textContent && s.textContent.includes('data-auto-animate-target')) s.remove();
                    });
                    document.querySelectorAll('[data-auto-animate-target]').forEach(el => {
                      el.removeAttribute('data-auto-animate-target');
                    });
                    document.querySelectorAll('[data-auto-animate]:not([data-auto-animate=""])').forEach(el => {
                      el.dataset.autoAnimate = '';
                    });
                    document.querySelectorAll('.reveal .slides section.present *').forEach(el => {
                      el.style.removeProperty('transform');
                      el.style.removeProperty('transition');
                    });

                    // Disable CSS fragment transitions permanently in this capture-only window
                    // so fragment state changes are instant (no fade-in/out mid-screenshot).
                    if (!document.getElementById('__cap-no-transition')) {
                      const s = document.createElement('style');
                      s.id = '__cap-no-transition';
                      s.textContent = '.fragment,.fragment.visible,.fragment.current-fragment{transition:none!important;animation:none!important;}';
                      document.head.appendChild(s);
                    }

                    // Apply fragment state: null = leave as-is (all visible), number = navigate to that fragment
                    if (tF !== null) {
                      window.deck.slide(tH, tV, tF);
                    }

                    // Force a synchronous reflow so fragment class changes are fully applied
                    // before the GPU compositor paints the next frame.
                    void document.body.offsetHeight;

                    setTimeout(resolve, 150);
                  };
                })();

                const cur = window.deck.getIndices();
                if (cur.h === tH && (cur.v || 0) === tV) {
                  finish();
                } else {
                  window.deck.addEventListener('slidetransitionend', function onEnd() {
                    window.deck.removeEventListener('slidetransitionend', onEnd);
                    finish();
                  });
                  window.deck.slide(tH, tV);
                  setTimeout(finish, 500);
                }
              })
            `);

            const image = await new Promise((res, rej) => {
              const t = setTimeout(() => rej(new Error('paint timeout')), 5000);
              win.webContents.once('paint', (_e, _dirty, img) => { clearTimeout(t); res(img); });
              win.webContents.invalidate();
            });
            if (!image || image.isEmpty()) return null;
            return image.resize({ width: 640 }).toJPEG(75).toString('base64');
          } catch (e) {
            AppContext.log('[remote] capture-next-slide failed:', e?.message);
            return null;
          }
        });

        ipcMain.handle('get-runtime-info', () => {
          const argv = Array.isArray(process.argv) ? process.argv : [];
          const hasOzoneX11 = argv.some((arg, i) =>
            arg === '--ozone-platform=x11' ||
            (arg === '--ozone-platform' && argv[i + 1] === 'x11')
          );
          return {
            sessionType: process.env.XDG_SESSION_TYPE || '',
            hasOzoneX11
          };
        });

        ipcMain.handle('get-mdns-peers', () => {
          return AppContext.mdnsPeers || [];
        });

        ipcMain.handle('get-paired-masters', () => {
          const masters = AppContext.config.pairedMasters || [];
          const cache = AppContext.pairedPeerCache;
          if (!cache || !cache.size) return masters;
          return masters.map((master) => {
            const cached = cache.get(master.instanceId);
            if (!cached) return master;
            return {
              ...master,
              host: cached.host,
              pairingPort: cached.port,
              addresses: cached.addresses,
              hostname: cached.hostname,
              lastSeen: cached.lastSeen
            };
          });
        });

        ipcMain.handle('get-peer-master-statuses', () => {
          return peerCommandClient.getMasterStatuses(AppContext);
        });

        ipcMain.handle('pair-with-peer', async (_event, peer) => {
          const result = await pairWithPeer(AppContext, peer);
          return { success: true, master: result };
        });

        ipcMain.handle('pair-with-peer-ip', async (_event, data) => {
          const host = data?.host?.trim();
          const port = Number.parseInt(data?.port, 10);
          const pairingPin = data?.pairingPin?.toString().trim();
          const natCompatibility = data?.natCompatibility === true;
          if (!host) {
            throw new Error('IP address is required.');
          }
          if (!Number.isFinite(port) || port <= 0) {
            throw new Error('Pairing port is required.');
          }
          const peer = {
            host,
            port,
            hostHint: host,
            pairingPortHint: port,
            pairingPin,
            natCompatibility
          };
          const result = await pairWithPeer(AppContext, peer);
          return { success: true, master: result };
        });

        ipcMain.handle('unpair-peer', async (_event, master) => {
          const result = await unpairPeer(AppContext, master);
          return { success: true, ...result };
        });

        ipcMain.handle('send-peer-command', async (_event, command) => {
          if (command?.type === 'open-presentation' && command?.payload?.url) {
            await presentationWindow.openAdditionalScreensForPeerUrl(AppContext, command.payload.url);
          } else if (command?.type === 'close-presentation') {
            presentationWindow.syncPublishedScreenDefault?.(AppContext);
            if (presentationWindow.shouldUseAlwaysOpenBehavior?.(AppContext.config)) {
              await presentationWindow.showDefaultOnMainPresentation(AppContext);
              await presentationWindow.showDefaultOnAdditionalScreens(AppContext);
            } else {
              presentationWindow.closeAdditionalScreens();
            }
          }
          const result = await sendPeerCommand(AppContext, command);
          return { success: true, result };
        });

        ipcMain.handle('getAvailableThemes', async () => {
          const themeDirCandidates = [
            path.join(AppContext.config.revelationDir, 'dist', 'css'),
            path.join(app.getPath('userData'), 'resources', 'revelation', 'dist', 'css'),
            path.join(process.resourcesPath, 'revelation', 'dist', 'css'),
            path.resolve(__dirname, '../revelation/dist/css')
          ];
          const themeDir = themeDirCandidates.find((candidate) => fs.existsSync(candidate));
          if (!themeDir) {
            throw new Error(`Theme directory not found. Checked: ${themeDirCandidates.join(', ')}`);
          }
          const exclude = ['handout.css', 'presentations.css',  'mediaLibrary.css', 'lowerthirds.css', 'confidencemonitor.css', 'notes-teleprompter.css'];
          const themes = fs.readdirSync(themeDir)
            .filter(file => file.endsWith('.css') && !exclude.includes(file));
          return themes;
        });

        AppContext.callbacks['menu:open-debug-log'] = () => {
          return shell.openPath(AppContext.config.logFile);
        }
        AppContext.callbacks['menu:clear-debug-log'] = () => {
          return AppContext.resetLog();
        }

        AppContext.callbacks['menu:show-library'] = () => {
          const key = AppContext.config.key;
          const url = `http://${AppContext.hostURL}:${AppContext.config.viteServerPort}/media-library.html?key=${key}`
          AppContext.win.loadURL(url);
        }

        AppContext.callbacks['menu:show-presentation-list'] = () => {
          const key = AppContext.config.key;
          const url = `http://${AppContext.hostURL}:${AppContext.config.viteServerPort}/presentations.html?key=${key}`
          AppContext.win.loadURL(url);
        }

        AppContext.callbacks['menu:open-screens'] = async () => {
          const result = await presentationWindow.activateAlwaysOpenScreens(AppContext);
          if (!result?.success) {
            AppContext.win?.webContents?.send('show-toast', result?.error || 'Unable to open screens.');
          }
        }

        AppContext.callbacks['menu:end-remote-presentation'] = async () => {
          await sendPeerCommand(AppContext, { type: 'close-presentation', payload: {} });
        }

        AppContext.callbacks['menu:close-screens'] = async () => {
          presentationWindow.deactivateAlwaysOpenScreens();
          await presentationWindow.forceCloseMainPresentationWindow(AppContext);
          await sendPeerCommand(AppContext, { type: 'close-presentation', payload: {} });
        }

        AppContext.callbacks['menu:regenerate-readme'] = async () => {
          try {
            const result = generateDocumentationPresentations({
              presentationsDir: AppContext.config.presentationsDir,
              revelationDir: AppContext.config.revelationDir,
              wrapperRoot: path.resolve(__dirname, '..'),
              appVersion: app.getVersion()
            });
            AppContext.log(`📝 Regenerated docs presentation at ${result.readmePresDir} (${result.generatedCount} files)`);

            await dialog.showMessageBox({
              type: 'info',
              title: 'Documentation',
              message: 'Documentation presentation regenerated.',
              detail: result.landingFile
            });
          } catch (err) {
            AppContext.error(`Documentation regeneration failed: ${err.message}`);
            await dialog.showMessageBox({
              type: 'error',
              title: 'Documentation',
              message: 'Failed to regenerate documentation presentation.',
              detail: err.message
            });
          }
        }

        AppContext.callbacks['menu:generate-theme-thumbnails'] = async () => {
          const start = Date.now();
          try {
            AppContext.log('🎨 Generating theme thumbnails...');
            const result = await generateThemeThumbnails(AppContext);
            const elapsed = Math.round((Date.now() - start) / 1000);
            const failures = result.failures || [];
            const summary = failures.length
              ? `Finished with ${failures.length} failure(s) in ${elapsed}s.`
              : `Done in ${elapsed}s.`;
            const details = failures.map((f) => `• ${f.theme}: ${f.error}`).join('\n');

            await dialog.showMessageBox({
              type: failures.length ? 'warning' : 'info',
              title: 'Theme Thumbnails',
              message: `Generated ${result.total} theme thumbnail(s). ${summary}`,
              detail: details ? `\n${details}\n\nOutput: ${result.outputDir}` : `Output: ${result.outputDir}`
            });
          } catch (err) {
            AppContext.error(`Theme thumbnail generation failed: ${err.message}`);
            await dialog.showMessageBox({
              type: 'error',
              title: 'Theme Thumbnails',
              message: 'Theme thumbnail generation failed.',
              detail: err.message
            });
          }
        }

        AppContext.callbacks['menu:install-markdown-test-presentation'] = async () => {
          try {
            const result = installMarkdownTestPresentation({
              presentationsDir: AppContext.config.presentationsDir,
              revelationDir: AppContext.config.revelationDir,
              appVersion: app.getVersion()
            });
            AppContext.log(`🧪 Installed markdown test presentation at ${result.presentationDir} (${result.fixtureCount} fixtures)`);
            await dialog.showMessageBox({
              type: 'info',
              title: 'Markdown Test Presentation',
              message: `Installed ${result.fixtureCount} markdown test fixtures.`,
              detail: result.presentationDir
            });
          } catch (err) {
            AppContext.error(`Markdown test presentation install failed: ${err.message}`);
            await dialog.showMessageBox({
              type: 'error',
              title: 'Markdown Test Presentation',
              message: 'Failed to install markdown test presentation.',
              detail: err.message
            });
          }
        }
    }

}

module.exports = {
    otherEventHandlers
};
