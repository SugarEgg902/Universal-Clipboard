const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 760, height: 500 });
  win.loadURL('data:text/html;charset=utf-8,<h1 style="font-family:sans-serif">Clipboard Drawer</h1>');
});
