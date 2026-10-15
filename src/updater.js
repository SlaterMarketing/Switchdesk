// Auto-updates from the GitHub repo's Releases page (see "publish" in package.json).
// Checks at start-up and every few hours, downloads in the background, and installs
// when you click "Restart to update" or next time you quit.

const { app, dialog } = require('electron');

let updater = null;
let notify = () => {};
let manualCheck = false;

function load() {
  if (updater || !app.isPackaged) return updater;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch {
    return null;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-available', (info) => notify({ state: 'downloading', version: info.version }));
  updater.on('download-progress', (p) => notify({ state: 'downloading', percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (info) => notify({ state: 'ready', version: info.version }));
  updater.on('update-not-available', () => {
    notify({ state: 'current' });
    if (manualCheck) dialog.showMessageBox({ message: `You're on the latest version (${app.getVersion()}).` });
    manualCheck = false;
  });
  updater.on('error', (err) => {
    notify({ state: 'error', message: String(err && err.message ? err.message : err).split('\n')[0] });
    const text = String(err && err.message ? err.message : err);
    // A release whose files are still uploading: not worth a scary error.
    if (manualCheck && /latest\.yml/.test(text) && /404/.test(text)) dialog.showMessageBox({ message: 'A new version is being published right now.', detail: 'Try again in a few minutes. It also installs by itself once it is ready.' });
    else if (manualCheck) dialog.showMessageBox({ type: 'warning', message: "Couldn't check for updates.", detail: text.split('\n')[0].slice(0, 300) });
    manualCheck = false;
  });
  return updater;
}

function start(onStatus) {
  notify = onStatus;
  if (!load()) return;
  const check = () => updater.checkForUpdates().catch(() => {});
  setTimeout(check, 10_000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

function checkNow() {
  if (!load()) {
    dialog.showMessageBox({ message: 'Updates only work in the installed app, not when running from source.' });
    return;
  }
  manualCheck = true;
  updater.checkForUpdates().catch(() => {});
}

function installNow() {
  if (updater) updater.quitAndInstall(false, true);
}

module.exports = { start, checkNow, installNow };
