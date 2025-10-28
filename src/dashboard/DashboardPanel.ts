import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectStore } from '../storage/ProjectStore';
import { Project, ProjectGroup } from '../types';
import { ChromeScreenshotter } from '../screenshot/ChromeScreenshotter';

export class DashboardPanel {
  public static current: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, store: ProjectStore): void {
    const column = vscode.ViewColumn.Active;
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(column);
      DashboardPanel.current.postState();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'cursorDashboard',
      'Dashboard',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, 'media')),
          vscode.Uri.file(context.globalStorageUri.fsPath),
          vscode.Uri.file(path.join(context.globalStorageUri.fsPath, 'thumbnails'))
        ]
      }
    );
    DashboardPanel.current = new DashboardPanel(panel, context, store);
  }

  private constructor(panel: vscode.WebviewPanel, private readonly context: vscode.ExtensionContext, private readonly store: ProjectStore) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg), null, this.disposables);
    this.panel.iconPath = vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'assets', 'icon.png'));
    this.panel.webview.html = this.getHtml();
    this.postState();
  }

  dispose(): void {
    DashboardPanel.current = undefined;
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const mediaRoot = vscode.Uri.file(path.join(this.context.extensionPath, 'media'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'dashboard.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'dashboard.css'));
    const cspSource = webview.cspSource;
    // no inline scripts/styles; CSP blocks them in modern webviews
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: https: blob: vscode-resource: vscode-webview-resource:; style-src ${cspSource}; script-src ${cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Dashboard</title>
</head>
<body>
  <div id="app"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  private postState(): void {
    const { projects, groups } = this.store.getAll();
    // map thumbnails to webview URIs and include config like tile size
    const thumbsDir = vscode.Uri.joinPath(this.context.globalStorageUri, 'thumbnails');
    const mapped = projects.map(p => {
      if (!p.thumbnailUri) return p;
      try {
        let fileUri: vscode.Uri | undefined;
        const raw = p.thumbnailUri;
        if (raw.startsWith('file:')) {
          fileUri = vscode.Uri.parse(raw);
        } else if (/^[A-Za-z]:\\/.test(raw) || raw.startsWith('/') ) {
          fileUri = vscode.Uri.file(raw);
        } else {
          // fallback to standard location by project id
          fileUri = vscode.Uri.joinPath(thumbsDir, `${p.id}.png`);
        }
        const webUri = this.panel.webview.asWebviewUri(fileUri);
        let versioned = webUri;
        try {
          const stat = fs.statSync(fileUri.fsPath);
          versioned = webUri.with({ query: `v=${Math.floor(stat.mtimeMs)}` });
        } catch {}
        return { ...p, thumbnailUri: versioned.toString() };
      } catch {
        return p;
      }
    });
    const storedPx = this.context.globalState.get<number>('dashboardUi.tilePx');
    const tilePx = storedPx ?? 320; // default larger tiles
    const placeholder = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(vscode.Uri.file(path.join(this.context.extensionPath, 'media')), 'assets', 'project-placeholder.svg')).toString();
    this.panel.webview.postMessage({ type: 'state', payload: { projects: mapped, groups, tilePx, placeholder } });
    // Auto-screenshot missing thumbnails if enabled
    void this.autoScreenshotMissing();
  }

  private async autoScreenshotMissing(): Promise<void> {
    try {
      const cfg = vscode.workspace.getConfiguration();
      const enabled = !!cfg.get('dashboard.autoScreenshotOnMissing');
      if (!enabled) return;
      const maxPerLoad = Number(cfg.get('dashboard.autoScreenshotMaxPerLoad') ?? 3);
      if (maxPerLoad <= 0) return;
      const { projects } = this.store.getAll();
      const thumbDir = path.join(this.context.globalStorageUri.fsPath, 'thumbnails');
      if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });
      let count = 0;
      for (const p of projects) {
        if (!p.url) continue;
        const dest = path.join(thumbDir, `${p.id}.png`);
        const exists = fs.existsSync(dest);
        if (!exists) {
          try {
            const windowSize = String(vscode.workspace.getConfiguration().get('dashboard.screenshot.windowSize') ?? '1280x800');
            const customPaths = vscode.workspace.getConfiguration().get('dashboard.screenshot.browserPaths') as Record<string, string> | undefined;
            await ChromeScreenshotter.takeScreenshot({ url: p.url, outPath: dest, windowSize, customPaths });
            p.thumbnailUri = dest;
            this.store.upsertProject(p);
            count++;
            if (count >= maxPerLoad) break;
          } catch {
            // ignore errors silently during auto-mode
          }
        }
      }
      if (count > 0) this.postState();
    } catch {
      // ignore
    }
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'addProject': {
        const id = cryptoRandom();
        const project: Project = { id, name: msg.name ?? 'Project', folderPath: msg.folderPath, url: msg.url, groupIds: msg.groupId ? [msg.groupId] : [], order: Number.MAX_SAFE_INTEGER };
        this.store.upsertProject(project);
        this.postState();
        break;
      }
      case 'requestAddProject': {
        const groupId = msg.groupId ?? null;
        const folderPick = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: 'Select project folder' });
        if (!folderPick || folderPick.length === 0) return;
        const folderUri = folderPick[0];
        const defaultName = path.basename(folderUri.fsPath);
        const name = await vscode.window.showInputBox({ prompt: 'Project name', value: defaultName }) || defaultName;
        const url = await vscode.window.showInputBox({ prompt: 'Project URL (optional)', placeHolder: 'http://localhost:3000' }) || undefined;
        const id = cryptoRandom();
        const project: Project = { id, name, folderPath: folderUri.fsPath, url, groupIds: groupId ? [groupId] : [], order: Number.MAX_SAFE_INTEGER };
        this.store.upsertProject(project);
        this.postState();
        break;
      }
      case 'requestEditProject': {
        const proj = this.store.getAll().projects.find((p) => p.id === msg.projectId);
        if (!proj) return;
        const name = await vscode.window.showInputBox({ prompt: 'Project name', value: proj.name }) || proj.name;
        const changeFolder = await vscode.window.showQuickPick(['Keep current folder', 'Pick new folder'], { placeHolder: 'Folder' });
        let folderPathStr = proj.folderPath;
        if (changeFolder === 'Pick new folder') {
          const pick = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: 'Select project folder' });
          if (pick && pick[0]) folderPathStr = pick[0].fsPath;
        }
        const url = await vscode.window.showInputBox({ prompt: 'Project URL (optional)', value: proj.url || '' }) || undefined;
        const updated: Project = { ...proj, name, folderPath: folderPathStr, url };
        this.store.upsertProject(updated);
        this.postState();
        break;
      }
      case 'requestDeleteProject': {
        const yes = 'Delete';
        const pick = await vscode.window.showWarningMessage('Delete this project from dashboard?', { modal: true }, yes, 'Cancel');
        if (pick === yes) {
          this.store.deleteProject(msg.projectId);
          this.postState();
        }
        break;
      }
      case 'requestMoveProject': {
        const proj = this.store.getAll().projects.find(p => p.id === msg.projectId);
        if (!proj) return;
        const groups = this.store.getAll().groups.sort((a,b)=>a.order-b.order);
        const items: vscode.QuickPickItem[] = [
          { label: 'All Projects', description: 'No folder' }
        ].concat(groups.map(g => ({ label: g.name, description: g.id })));
        const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Move to folder…' });
        if (!pick) return;
        const ids = (pick.label === 'All Projects') ? [] : [pick.description!];
        const updated: Project = { ...proj, groupIds: ids };
        this.store.upsertProject(updated);
        this.postState();
        break;
      }
      case 'editProject': {
        const p: Project = msg.project;
        this.store.upsertProject(p);
        this.postState();
        break;
      }
      case 'deleteProject': {
        this.store.deleteProject(msg.projectId);
        this.postState();
        break;
      }
      case 'reorderProject': {
        this.store.reorderProject(msg.projectId, msg.toIndex, msg.toGroupId ?? null);
        this.postState();
        break;
      }
      case 'openProject': {
        const confirmOnOpen = vscode.workspace.getConfiguration().get<boolean>('dashboardUi.confirmOnOpen');
        if (confirmOnOpen) {
          const yes = 'Open';
          const choice = await vscode.window.showInformationMessage('Open project?', yes, 'Cancel');
          if (choice !== yes) return;
        }
        const uri = vscode.Uri.file(msg.folderPath);
        await vscode.commands.executeCommand('vscode.openFolder', uri, false);
        break;
      }
      case 'addGroup': {
        const group: ProjectGroup = { id: cryptoRandom(), name: msg.name ?? 'Group', order: Number.MAX_SAFE_INTEGER };
        this.store.upsertGroup(group);
        this.postState();
        break;
      }
      case 'requestAddGroup': {
        const name = await vscode.window.showInputBox({ prompt: 'Folder name' });
        if (!name) return;
        const group: ProjectGroup = { id: cryptoRandom(), name, order: Number.MAX_SAFE_INTEGER };
        this.store.upsertGroup(group);
        this.postState();
        break;
      }
      case 'editGroup': {
        const g: ProjectGroup = msg.group;
        this.store.upsertGroup(g);
        this.postState();
        break;
      }
      case 'deleteGroup': {
        this.store.deleteGroup(msg.groupId);
        this.postState();
        break;
      }
      case 'import': {
        if (msg.uri) {
          this.store.importFrom(vscode.Uri.parse(msg.uri));
          this.postState();
        }
        break;
      }
      case 'export': {
        if (msg.uri) {
          this.store.exportTo(vscode.Uri.parse(msg.uri));
        }
        break;
      }
      case 'uploadThumbnail': {
        const thumbDir = path.join(this.context.globalStorageUri.fsPath, 'thumbnails');
        if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });
        const dest = path.join(thumbDir, `${msg.projectId}.png`);
        const data = Buffer.from(msg.base64, 'base64');
        fs.writeFileSync(dest, data);
        const proj = (this.store.getAll().projects.find(p => p.id === msg.projectId));
        if (proj) {
          proj.thumbnailUri = dest; // store raw file path
          this.store.upsertProject(proj);
        }
        this.postState();
        break;
      }
      case 'generateScreenshot': {
        try {
          const thumbDir = path.join(this.context.globalStorageUri.fsPath, 'thumbnails');
          if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });
          const dest = path.join(thumbDir, `${msg.projectId}.png`);
          const windowSize = String(vscode.workspace.getConfiguration().get('dashboardUi.screenshot.windowSize') ?? '1280x800');
          const customPaths = vscode.workspace.getConfiguration().get('dashboardUi.screenshot.browserPaths') as Record<string, string> | undefined;
          await ChromeScreenshotter.takeScreenshot({ url: msg.url, outPath: dest, windowSize, customPaths });
          const proj = (this.store.getAll().projects.find(p => p.id === msg.projectId));
          if (proj) {
            proj.thumbnailUri = dest; // store raw file path
            this.store.upsertProject(proj);
          }
          this.panel.webview.postMessage({ type: 'screenshotComplete', projectId: msg.projectId });
        } catch (err: any) {
          vscode.window.showErrorMessage(`Screenshot failed: ${err?.message ?? err}`);
          this.panel.webview.postMessage({ type: 'screenshotFailed', projectId: msg.projectId });
        }
        this.postState();
        break;
      }
      case 'setTilePx': {
        const px = Math.max(120, Math.min(Number(msg.value) || 320, 600));
        await this.context.globalState.update('dashboardUi.tilePx', px);
        this.postState();
        break;
      }
      default:
        break;
    }
  }

  public refresh(): void { this.postState(); }
}

function cryptoRandom(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

