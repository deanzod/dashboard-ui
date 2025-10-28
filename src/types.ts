/* eslint-disable @typescript-eslint/naming-convention */
export interface Project {
  id: string;
  name: string;
  folderPath: string;
  url?: string;
  // Multi-folder support: projects can belong to multiple groups
  groupIds?: string[]; // if undefined, treat as []
  order: number;
  thumbnailUri?: string; // vscode-resource URI for webview, or file path stored then mapped
}

export interface ProjectGroup {
  id: string;
  name: string;
  order: number;
}

export interface StoredState {
  version: number;
  projects: Project[];
  groups: ProjectGroup[];
}

export interface ReorderPayload {
  projectId: string;
  toIndex: number;
  toGroupId?: string | null;
}

