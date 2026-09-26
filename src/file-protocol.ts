export interface FileEntry { name: string; directory: boolean; symlink: boolean; size: number; modified: number; mode: number }
export interface FileListing { path: string; parent: string; entries: FileEntry[]; truncated: boolean }
