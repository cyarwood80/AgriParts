/**
 * Where licensed files (source PDFs, page images) live. Nothing here is ever
 * public: the API streams blobs only after a licence check (ADR-0005 §6).
 *
 *  - dev / tests: a local folder (`.data/blobs`) or memory
 *  - production:  Cloudflare R2 via its S3 API (to do: ADR-0005 action 6)
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface BlobStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;
function checkKey(key: string) {
  if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error(`Unsafe blob key: ${key}`);
}

export class LocalBlobStore implements BlobStore {
  constructor(private readonly root: string) {}
  private file(key: string) {
    checkKey(key);
    return path.join(this.root, ...key.split('/'));
  }
  async put(key: string, data: Uint8Array) {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, data);
  }
  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.file(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }
}

export class MemoryBlobStore implements BlobStore {
  readonly items = new Map<string, { data: Uint8Array; contentType: string }>();
  async put(key: string, data: Uint8Array, contentType: string) {
    checkKey(key);
    this.items.set(key, { data, contentType });
  }
  async get(key: string) {
    return this.items.get(key)?.data ?? null;
  }
  async delete(key: string) {
    this.items.delete(key);
  }
}

let defaultStore: BlobStore | undefined;
/** Process-wide store: BLOB_DIR (default .data/blobs). Tests swap in MemoryBlobStore. */
export function blobStore(): BlobStore {
  defaultStore ??= new LocalBlobStore(path.resolve(process.env.BLOB_DIR ?? '.data/blobs'));
  return defaultStore;
}
export function setBlobStore(store: BlobStore) {
  defaultStore = store;
}

export const docKey = (tenantId: string, documentId: string, file = 'source.pdf') => `tenant/${tenantId}/docs/${documentId}/${file}`;
