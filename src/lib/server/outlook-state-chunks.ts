import "server-only";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

export const cleanupInlineBytes = 512 * 1024;
export const cleanupChunkBytes = 256 * 1024;
export const cleanupChunkReadPage = 128;
export const cleanupChunkReadBytes = 2 * 1024 * 1024;
const segmentCharacters = 32 * 1024;
const itemsPerPage = 100;
const format = "outlook-chunks-v1";
type Envelope = { userId: string; version: number; view: { id: string } };
type Codec<T> = { encode(value: T): string; decode(value: string): T };
type Reference = { slot: string; digest: string; bytes: number };
type ArrayPart = { path: string[]; length: number; pages: Reference[][] };
type Manifest = Envelope & { outlookStorage: { format: typeof format; arrays: ArrayPart[] } };
export type ChunkCache = Map<string, { digest: string; segment: string; bytes: number }>;
export type ChunkWrite = {
  rows: Array<{ slot: string; encryptedPayload: string }>;
  slots: string[];
  removedSlots: string[];
  newSlots: string[];
  cache: ChunkCache;
};
export type StorageWrite = { encryptedPayload: string; chunkWrite?: ChunkWrite };
type ChunkReader = { cleanupJobStateChunk: { findMany(args: {
  where: { jobId: string; slot: { in: string[] } };
  select: { slot: true; encryptedPayload: true };
}): Promise<Array<{ slot: string; encryptedPayload: string }>> } };

const digest = (value: string) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invalid = () => new Error("Cleanup state could not be authenticated.");
export function isChunkedCleanupState(value: unknown): value is Manifest {
  return typeof value === "object" && value !== null && "outlookStorage" in value;
}

// References/digests are inside the authenticated root; DB slots contain no mailbox keys.
export function encodeOutlookStorage<T extends Envelope>(job: T, codec: Codec<T>, cache: ChunkCache = new Map()): StorageWrite {
  if (!("provider" in job && job.provider === "microsoft")) return { encryptedPayload: codec.encode(job) };
  const json = JSON.stringify(job);
  if (!cache.size && Buffer.byteLength(json) <= cleanupInlineBytes) {
    const encryptedPayload = codec.encode(job);
    if (Buffer.byteLength(encryptedPayload) <= cleanupInlineBytes) return { encryptedPayload };
  }
  const arrays: ArrayPart[] = [], rows: ChunkWrite["rows"] = [], nextCache: ChunkCache = new Map();
  const visit = (value: unknown, path: string[]): unknown => {
    if (Array.isArray(value) && (value.length > itemsPerPage || Buffer.byteLength(JSON.stringify(value)) > 16 * 1024)) {
      const pages: Reference[][] = [];
      for (let index = 0; index < value.length; index += itemsPerPage) {
        const serialized = JSON.stringify(value.slice(index, index + itemsPerPage));
        const refs: Reference[] = [];
        for (let offset = 0; offset < serialized.length; offset += segmentCharacters) {
          const segment = serialized.slice(offset, offset + segmentCharacters);
          const slot = `${createHash("sha256").update(JSON.stringify(path)).digest("hex").slice(0, 24)}:${index / itemsPerPage}:${offset / segmentCharacters}`;
          const hash = digest(segment);
          let bytes = cache.get(slot)?.digest === hash ? cache.get(slot)!.bytes : 0;
          if (!bytes) {
            const compressed = gzipSync(JSON.stringify(segment)).toString("base64");
            const encryptedPayload = codec.encode({ kind: format, jobId: job.view.id, userId: job.userId, slot, digest: hash, compressed } as unknown as T);
            bytes = Buffer.byteLength(encryptedPayload);
            if (bytes > cleanupChunkBytes) throw invalid();
            rows.push({ slot, encryptedPayload });
          }
          refs.push({ slot, digest: hash, bytes }); nextCache.set(slot, { digest: hash, segment, bytes });
        }
        pages.push(refs);
      }
      arrays.push({ path, length: value.length, pages }); return [];
    }
    if (Array.isArray(value)) return value.map((entry, index) => visit(entry, [...path, String(index)]));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry, [...path, key])]));
    return value;
  };
  // Match the legacy JSON codec's Date/toJSON/undefined semantics before partitioning.
  const root = visit(JSON.parse(json), []) as T & Manifest;
  root.outlookStorage = { format, arrays };
  const encryptedPayload = codec.encode(root);
  if (Buffer.byteLength(encryptedPayload) > cleanupInlineBytes) throw invalid();
  return { encryptedPayload, chunkWrite: { rows, slots: [...nextCache.keys()], removedSlots: [...cache.keys()].filter(slot => !nextCache.has(slot)),
    newSlots: rows.filter(row => !cache.has(row.slot)).map(row => row.slot), cache: nextCache } };
}

export async function hydrateOutlookStorage<T extends Envelope>(
  job: T, codec: Codec<T>, db: ChunkReader, cache: ChunkCache = new Map()
): Promise<T> {
  if (!isChunkedCleanupState(job)) return job;
  try {
    const manifest = job.outlookStorage;
    if (manifest.format !== format || !Array.isArray(manifest.arrays)) throw invalid();
    const refs = manifest.arrays.flatMap(array => array.pages.flat());
    if (new Set(refs.map(ref => ref.slot)).size !== refs.length) throw invalid();
    const needed = refs.filter(ref => cache.get(ref.slot)?.digest !== ref.digest);
    for (let index = 0; index < needed.length;) {
      const page: Reference[] = [];
      let bytes = 0;
      while (index < needed.length && page.length < cleanupChunkReadPage) {
        const ref = needed[index];
        if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > cleanupChunkBytes) throw invalid();
        if (page.length && bytes + ref.bytes > cleanupChunkReadBytes) break;
        page.push(ref); bytes += ref.bytes; index++;
      }
      const rows = await db.cleanupJobStateChunk.findMany({ where: { jobId: job.view.id, slot: { in: page.map(ref => ref.slot) } }, select: { slot: true, encryptedPayload: true } });
      if (rows.length !== page.length) throw invalid();
      for (const ref of page) {
        const row = rows.find(row => row.slot === ref.slot);
        if (!row || Buffer.byteLength(row.encryptedPayload) !== ref.bytes) throw invalid();
        const chunk = codec.decode(row.encryptedPayload) as unknown as { kind: string; jobId: string; userId: string; slot: string; digest: string; compressed: string };
        if (chunk.kind !== format || chunk.jobId !== job.view.id || chunk.userId !== job.userId || chunk.slot !== ref.slot || chunk.digest !== ref.digest) throw invalid();
        const segment: unknown = JSON.parse(gunzipSync(Buffer.from(chunk.compressed, "base64"), { maxOutputLength: 256 * 1024 }).toString("utf8"));
        if (typeof segment !== "string" || segment.length > segmentCharacters || digest(segment) !== ref.digest) throw invalid();
        cache.set(ref.slot, { digest: ref.digest, segment, bytes: ref.bytes });
      }
    }
    const result = structuredClone(job) as T & Partial<Manifest>;
    delete result.outlookStorage;
    for (const array of manifest.arrays) {
      if (!array.path.length || array.path.some(key => ["__proto__", "prototype", "constructor"].includes(key))) throw invalid();
      let parent: Record<string, unknown> = result as unknown as Record<string, unknown>;
      for (const key of array.path.slice(0, -1)) {
        if (!Object.hasOwn(parent, key) || !parent[key] || typeof parent[key] !== "object") throw invalid();
        parent = parent[key] as Record<string, unknown>;
      }
      const key = array.path.at(-1)!;
      if (!Object.hasOwn(parent, key) || !Array.isArray(parent[key]) || parent[key].length !== 0) throw invalid();
      const items: unknown[] = [];
      for (const page of array.pages) {
        const decoded: unknown = JSON.parse(page.map(ref => {
          const cached = cache.get(ref.slot);
          if (!cached || cached.digest !== ref.digest) throw invalid();
          return cached.segment;
        }).join(""));
        if (!Array.isArray(decoded) || decoded.length > itemsPerPage) throw invalid();
        items.push(...decoded);
      }
      if (items.length !== array.length) throw invalid();
      parent[key] = items;
    }
    return result;
  } catch { throw invalid(); }
}
