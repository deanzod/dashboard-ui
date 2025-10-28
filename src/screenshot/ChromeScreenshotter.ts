import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ScreenshotOptions {
  url: string;
  outPath: string;
  windowSize: string; // "1280x800"
  customPaths?: { [platform: string]: string };
  timeoutMs?: number;
}

export class ChromeScreenshotter {
  static async takeScreenshot(opts: ScreenshotOptions): Promise<void> {
    const browser = await this.findBrowserBinary(opts.customPaths);
    const [w, h] = (opts.windowSize || '1280x800').split('x');
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--window-size=${Number(w)},${Number(h)}`,
      `--screenshot=${opts.outPath}`,
      opts.url,
    ];
    await new Promise<void>((resolve, reject) => {
      const proc = child_process.spawn(browser, args, { stdio: 'ignore' });
      const to = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('Screenshot timed out'));
      }, opts.timeoutMs ?? 15000);
      proc.on('error', err => {
        clearTimeout(to);
        reject(err);
      });
      proc.on('exit', code => {
        clearTimeout(to);
        if (code === 0 && fs.existsSync(opts.outPath)) resolve(); else reject(new Error(`Screenshot failed: ${code}`));
      });
    });
  }

  static async findBrowserBinary(custom?: { [platform: string]: string }): Promise<string> {
    const plat = process.platform;
    const override = custom?.[plat];
    if (override && fs.existsSync(override)) return override;
    const candidates: string[] = [];
    if (plat === 'darwin') {
      candidates.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
      );
    } else if (plat === 'win32') {
      const local = process.env['LOCALAPPDATA'] ?? 'C:/Users/%USERNAME%/AppData/Local';
      candidates.push(
        path.join(local, 'Google/Chrome/Application/chrome.exe'),
        path.join(local, 'Microsoft/Edge/Application/msedge.exe'),
        'chrome.exe',
        'msedge.exe'
      );
    } else {
      candidates.push('google-chrome', 'chromium', 'chromium-browser');
    }
    for (const c of candidates) {
      if (await this.existsOnPathOrFs(c)) return c;
    }
    const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: 'Select Chrome/Edge executable for screenshots' });
    if (!picked || picked.length === 0) throw new Error('No browser selected for screenshots');
    return picked[0].fsPath;
  }

  private static async existsOnPathOrFs(bin: string): Promise<boolean> {
    if (fs.existsSync(bin)) return true;
    try {
      const which = process.platform === 'win32' ? 'where' : 'which';
      child_process.execSync(`${which} ${bin}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

