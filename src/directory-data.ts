/** Serializable filesystem facts shared by native and remote directory walkers. */
export interface FileInfo { file: boolean; directory: boolean; executable: boolean }
export interface DirectoryEntry { name: string; directory: boolean; symlink: boolean }
export interface DirectorySnapshot { version: string; entries: DirectoryEntry[]; complete: boolean }
