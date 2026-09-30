import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';

// The launcher needs a BMP before Electron exists. Keep the generated asset in
// git so ordinary builds need neither a desktop nor an image conversion tool.
const folder = await mkdtemp(join(tmpdir(), 'comms-splash-'));
let app;
try {
  await writeFile(join(folder, 'main.cjs'), `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => { const window = new BrowserWindow({ show: false }); window.loadURL('about:blank'); });`);
  app = await electron.launch({ executablePath, args: [join(folder, 'main.cjs'), `--user-data-dir=${join(folder, 'profile')}`, ...(process.env.COMMS_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])] });
  const page = await app.firstWindow();
  const { width, height, rgba } = await page.evaluate(async svg => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return { width: canvas.width, height: canvas.height, rgba: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data) };
  }, await readFile('build/splash.svg', 'utf8'));
  // Windows BITMAPINFOHEADER, uncompressed 24-bit BGR with bottom-up rows.
  const stride = Math.ceil(width * 3 / 4) * 4;
  const bmp = Buffer.alloc(54 + stride * height);
  bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(width, 18); bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (y * width + x) * 4, target = 54 + (height - y - 1) * stride + x * 3;
    bmp[target] = rgba[source + 2]; bmp[target + 1] = rgba[source + 1]; bmp[target + 2] = rgba[source];
  }
  await writeFile('build/splash.bmp', bmp);
  console.log(`Created build/splash.bmp (${width} × ${height}, ${bmp.length} bytes).`);
} finally { await app?.close(); await rm(folder, { recursive: true, force: true }); }
