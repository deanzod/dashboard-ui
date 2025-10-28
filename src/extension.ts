import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DashboardPanel } from './dashboard/DashboardPanel';
import { ProjectStore } from './storage/ProjectStore';
import { ChromeScreenshotter } from './screenshot/ChromeScreenshotter';

let store: ProjectStore | undefined;
let shownThisWindow = false;

export function activate(context: vscode.ExtensionContext): void {
  store = new ProjectStore(context);
  try { context.globalState.setKeysForSync(['dashboardUi.state']); } catch {}

  context.subscriptions.push(
    vscode.commands.registerCommand('dashboardUi.open', () => {
      ensurePanel(context);
    }),
    vscode.commands.registerCommand('dashboardUi.screenshotSelected', async () => {
      ensurePanel(context);
      if (!store) return;
      const all = store.getAll().projects;
      if (all.length === 0) { vscode.window.showInformationMessage('No projects'); return; }
      const picked = await vscode.window.showQuickPick(
        all.map(p => ({ label: p.name, description: p.url || p.folderPath, p })),
        { placeHolder: 'Select a project to screenshot' }
      );
      if (!picked) return;
      const proj = picked.p;
      let url = proj.url;
      if (!url) {
        url = await vscode.window.showInputBox({ prompt: 'Enter URL to screenshot', value: 'http://localhost:3000' }) || undefined;
        if (!url) return;
        store.upsertProject({ ...proj, url });
      }
      const thumbDir = path.join(context.globalStorageUri.fsPath, 'thumbnails');
      if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });
      const dest = path.join(thumbDir, `${proj.id}.png`);
      const windowSize = String(vscode.workspace.getConfiguration().get('dashboardUi.screenshot.windowSize') ?? '1280x800');
      const customPaths = vscode.workspace.getConfiguration().get('dashboardUi.screenshot.browserPaths') as Record<string, string> | undefined;
      try {
        await ChromeScreenshotter.takeScreenshot({ url, outPath: dest, windowSize, customPaths });
        const updated = { ...proj, thumbnailUri: vscode.Uri.file(dest).toString() };
        store.upsertProject(updated);
        DashboardPanel.current?.refresh();
        vscode.window.showInformationMessage('Screenshot generated');
      } catch (err: any) {
        vscode.window.showErrorMessage(`Screenshot failed: ${err?.message ?? err}`);
      }
    }),
    vscode.commands.registerCommand('dashboardUi.import', async () => {
      ensurePanel(context);
      const uri = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, title: 'Import Dashboard JSON' });
      if (!uri || !uri[0] || !store) return;
      store.importFrom(uri[0]);
      DashboardPanel.current?.refresh();
    }),
    vscode.commands.registerCommand('dashboardUi.export', async () => {
      ensurePanel(context);
      const uri = await vscode.window.showSaveDialog({ filters: { 'JSON': ['json'] }, saveLabel: 'Export' });
      if (!uri || !store) return;
      store.exportTo(uri);
      vscode.window.showInformationMessage('Dashboard exported');
    }),
    vscode.commands.registerCommand('dashboardUi.renameFolder', async () => {
      ensurePanel(context);
      if (!store) return;
      const groups = store.getAll().groups.sort((a,b)=>a.order-b.order);
      if (groups.length === 0) { vscode.window.showInformationMessage('No folders to rename'); return; }
      const pick = await vscode.window.showQuickPick(groups.map(g => ({ label: g.name, description: g.id, g })), { placeHolder: 'Select folder to rename' });
      if (!pick) return;
      const name = await vscode.window.showInputBox({ prompt: 'New folder name', value: pick.g.name });
      if (!name) return;
      store.upsertGroup({ ...pick.g, name });
      DashboardPanel.current?.refresh();
    }),
    vscode.commands.registerCommand('dashboardUi.addCurrentFolder', async () => {
      ensurePanel(context);
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showInformationMessage('No folder is open.');
        return;
      }
      const folder = folders[0].uri.fsPath;
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      store?.upsertProject({ id, name: folders[0].name, folderPath: folder, order: Number.MAX_SAFE_INTEGER, groupIds: [] });
      DashboardPanel.current?.refresh();
    }),
    vscode.window.onDidChangeWindowState(e => {
      if (e.focused) maybeShowOnStartup(context);
    })
  );

  maybeShowOnStartup(context);
}

function ensurePanel(context: vscode.ExtensionContext): void {
  if (!store) store = new ProjectStore(context);
  DashboardPanel.show(context, store);
}

function maybeShowOnStartup(context: vscode.ExtensionContext): void {
  const show = vscode.workspace.getConfiguration().get<boolean>('dashboardUi.showOnStartup');
  const hasFolders = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
  if (show && !shownThisWindow && !hasFolders) {
    shownThisWindow = true;
    ensurePanel(context);
    // Hide the native welcome page by focusing our panel
    DashboardPanel.current?.['panel']?.reveal(vscode.ViewColumn.Active);
  }
}

export function deactivate(): void {
  // noop
}

