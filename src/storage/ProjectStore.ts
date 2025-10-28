import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Project, ProjectGroup, StoredState } from '../types';

export class ProjectStore {
  private readonly storageFile: string;
  private state: StoredState;
  private readonly gs: vscode.Memento;
  private static readonly SYNC_KEY = 'dashboardUi.state';

  constructor(context: vscode.ExtensionContext) {
    const storageDir = context.globalStorageUri.fsPath;
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }
    this.storageFile = path.join(storageDir, 'projects.json');
    this.gs = context.globalState;
    this.state = this.load();
  }

  private load(): StoredState {
    try {
      // Try settings-sync backed state first
      const synced = this.gs.get<StoredState>(ProjectStore.SYNC_KEY);
      if (synced && typeof synced === 'object' && Array.isArray(synced.projects)) {
        this.migrateInPlace(synced);
        // mirror to file for local backup
        this.saveToFile(synced);
        return synced;
      }
      if (fs.existsSync(this.storageFile)) {
        const raw = fs.readFileSync(this.storageFile, 'utf8');
        const parsed = JSON.parse(raw) as StoredState;
        this.migrateInPlace(parsed);
        // mirror to settings-sync storage for portability
        void this.gs.update(ProjectStore.SYNC_KEY, parsed);
        return parsed;
      }
    } catch (err) {
      console.error('Failed to load project store', err);
    }
    const initial: StoredState = { version: 1, projects: [], groups: [] };
    this.save(initial);
    return initial;
  }

  private save(next: StoredState = this.state): void {
    try {
      this.saveToFile(next);
      void this.gs.update(ProjectStore.SYNC_KEY, next);
      this.state = next;
    } catch (err) {
      console.error('Failed to save project store', err);
    }
  }

  private saveToFile(data: StoredState): void {
    try { fs.writeFileSync(this.storageFile, JSON.stringify(data, null, 2), 'utf8'); } catch {}
  }

  private migrateInPlace(st: StoredState): void {
    if (st?.projects?.length) {
      for (const p of st.projects as any[]) {
        if ((p as any).groupId !== undefined && (p as any).groupIds === undefined) {
          const gid = (p as any).groupId;
          if (gid === null || gid === undefined) (p as any).groupIds = [];
          else (p as any).groupIds = [gid];
          delete (p as any).groupId;
        }
        if ((p as any).groupIds === undefined) (p as any).groupIds = [];
      }
    }
  }

  getAll(): StoredState { return this.state; }

  upsertProject(project: Project): void {
    const idx = this.state.projects.findIndex(p => p.id === project.id);
    if (!project.groupIds) project.groupIds = [];
    if (idx >= 0) {
      this.state.projects[idx] = project;
    } else {
      this.state.projects.push(project);
    }
    this.reindexAll();
    this.save();
  }

  deleteProject(projectId: string): void {
    this.state.projects = this.state.projects.filter(p => p.id !== projectId);
    this.reindexAll();
    this.save();
  }

  reorderProject(projectId: string, toIndex: number, contextGroupId: string | null = null): void {
    // Reorder within the current view; membership is not changed here
    const proj = this.state.projects.find(p => p.id === projectId);
    if (!proj) return;
    const allOrdered = [...this.state.projects].sort((a,b)=> a.order - b.order);
    const subset = allOrdered.filter(p => contextGroupId ? (p.groupIds ?? []).includes(contextGroupId) : true);
    const currentIdx = subset.findIndex(p => p.id === projectId);
    if (currentIdx < 0) return;
    // remove from subset and insert at new index
    subset.splice(currentIdx, 1);
    const clamped = Math.max(0, Math.min(toIndex, subset.length));
    subset.splice(clamped, 0, proj);
    // Now reassign global order following the sequence: iterate allOrdered and replace subset items in order
    const subsetIds = new Set(subset.map(p => p.id));
    const newGlobal: Project[] = [];
    let subsetPtr = 0;
    for (const p of allOrdered) {
      if (subsetIds.has(p.id)) {
        // place next from subset in this slot
        newGlobal.push(subset[subsetPtr++]);
      } else {
        newGlobal.push(p);
      }
    }
    newGlobal.forEach((p, i) => p.order = i);
    this.state.projects = newGlobal;
    this.save();
  }

  upsertGroup(group: ProjectGroup): void {
    const idx = this.state.groups.findIndex(g => g.id === group.id);
    if (idx >= 0) this.state.groups[idx] = group; else this.state.groups.push(group);
    this.reindexGroups();
    this.save();
  }

  deleteGroup(groupId: string): void {
    this.state.projects = this.state.projects.map(p => {
      const next: Project = { ...p, groupIds: [...(p.groupIds ?? [])] };
      next.groupIds = (next.groupIds ?? []).filter(id => id !== groupId);
      return next;
    });
    this.state.groups = this.state.groups.filter(g => g.id !== groupId);
    this.reindexGroups();
    this.reindexAll();
    this.save();
  }

  exportTo(uri: vscode.Uri): void {
    const data = { version: this.state.version, projects: this.state.projects, groups: this.state.groups };
    fs.writeFileSync(uri.fsPath, JSON.stringify(data, null, 2), 'utf8');
  }

  importFrom(uri: vscode.Uri): void {
    const raw = fs.readFileSync(uri.fsPath, 'utf8');
    const data = JSON.parse(raw) as StoredState;
    this.state = { version: data.version ?? 1, projects: data.projects ?? [], groups: data.groups ?? [] };
    this.reindexGroups();
    this.reindexAll();
    this.save();
  }

  private reindexGroups(): void {
    this.state.groups.sort((a, b) => a.order - b.order);
    this.state.groups.forEach((g, i) => g.order = i);
  }

  private reindexAll(): void {
    this.state.projects.sort((a,b)=> a.order - b.order);
    this.state.projects.forEach((p,i)=> p.order = i);
  }
}

