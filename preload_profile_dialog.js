// preload_profile_dialog.js — IPC bridge for the Save-as-Profile dialog window
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('profileDialogAPI', {
  confirm: (name) => ipcRenderer.invoke('profile-dialog:confirm', name),
  cancel:  ()     => ipcRenderer.invoke('profile-dialog:cancel')
});
