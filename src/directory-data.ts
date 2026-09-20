/** Serializable filesystem facts shared by native and remote directory walkers. */
export interface FileInfo { file: boolean; directory: boolean; executable: boolean }
export interface DirectoryEntry { name: string; directory: boolean; symlink: boolean }
export interface DirectorySnapshot { version: string; entries: DirectoryEntry[]; complete: boolean }
export interface DirectoryLookup { info?: FileInfo; listing?: DirectorySnapshot }
export interface DirectoryHost {
  stat(path: string, signal?: AbortSignal): Promise<FileInfo | undefined>;
  entries(path: string, limit: number, signal?: AbortSignal): Promise<DirectoryEntry[]>;
  lookup(path: string, signal?: AbortSignal): Promise<DirectoryLookup>;
}
