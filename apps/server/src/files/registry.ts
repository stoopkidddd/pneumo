export interface PendingFile {
  size: number;
  createdAt: number;
  attached: boolean;
}

/** Tracks file ids issued by this process until their object or push is removed. */
export class FileRegistry {
  readonly pending = new Map<string, PendingFile>();

  markAttached(id: string): void {
    const file = this.pending.get(id);
    if (file) file.attached = true;
  }

  forget(id: string): void {
    this.pending.delete(id);
  }
}
