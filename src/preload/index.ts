import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopInterface, ProbeSnapshot } from '../shared/protocol';
import type { PreviewView } from '../shared/analysis';

const desktop: DesktopInterface = {
  openDropped: file => ipcRenderer.invoke('review:command', { type: 'open-path', path: webUtils.getPathForFile(file) }),
  command: command => ipcRenderer.invoke('review:command', command),
  snapshot: () => ipcRenderer.invoke('review:snapshot'),
  preview: () => ipcRenderer.invoke('review:preview'),
  subscribePreview: listener => {
    const callback = (_event: Electron.IpcRendererEvent, preview: PreviewView) => listener(preview);
    ipcRenderer.on('review:preview', callback);
    return () => ipcRenderer.removeListener('review:preview', callback);
  },
  subscribe: listener => {
    const callback = (_event: Electron.IpcRendererEvent, snapshot: ProbeSnapshot) => listener(snapshot);
    ipcRenderer.on('review:snapshot', callback);
    return () => ipcRenderer.removeListener('review:snapshot', callback);
  },
};
contextBridge.exposeInMainWorld('review', desktop);
