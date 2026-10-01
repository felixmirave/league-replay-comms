import { app, BrowserWindow } from 'electron';

void app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 780, height: 820, show: process.env.COMMS_FIXTURE_HIDDEN !== '1' });
  void window.loadURL('about:blank');
});
