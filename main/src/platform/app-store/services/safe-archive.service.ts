import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import extractZip from 'extract-zip';
import * as yauzl from 'yauzl';
import { createHash } from 'crypto';
import { isFirstPartyAppId } from '../first-party';
import { SIGNATURE_FILE, verifySignedFileList } from './package-signature.service';

export const APP_ARCHIVE_LIMITS = {
  maxFiles: 5000,
  maxArchiveBytes: 200 * 1024 * 1024,
  maxEntryBytes: 100 * 1024 * 1024,
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxPathBytes: 1024,
  maxPathDepth: 32,
};

/**
 * 首方签名包的解包上限（MC17，Q25 选 b）：只放宽条目数与解包合计，其余与普通包相同。
 * 企业套件带 Temporal SDK（含五个平台的原生库），裁剪后约 8600 个条目、解包约 200MB。
 */
export const FIRST_PARTY_SIGNED_ARCHIVE_LIMITS = {
  ...APP_ARCHIVE_LIMITS,
  maxFiles: 20000,
  maxUncompressedBytes: 512 * 1024 * 1024,
};

export type ArchiveLimits = typeof APP_ARCHIVE_LIMITS;

/** 预检时读取的两个小文件的上限 */
const MAX_SIGNATURE_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

@Injectable()
export class SafeArchiveService {
  async extract(archivePath: string, destination: string): Promise<void> {
    const archiveSize = fs.statSync(archivePath).size;
    if (archiveSize > APP_ARCHIVE_LIMITS.maxArchiveBytes) {
      throw new Error('APP_ARCHIVE_TOO_LARGE');
    }

    const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jzapp-archive-'));
    const privateArchive = path.join(privateDir, 'package.jzapp');
    fs.copyFileSync(archivePath, privateArchive);
    fs.rmSync(destination, { recursive: true, force: true });

    try {
      const limits = await this.selectLimits(privateArchive);
      await this.validateArchive(privateArchive, limits);
      fs.mkdirSync(destination, { recursive: true });
      await extractZip(privateArchive, { dir: destination });
    } catch (error) {
      fs.rmSync(destination, { recursive: true, force: true });
      throw error;
    } finally {
      fs.rmSync(privateDir, { recursive: true, force: true });
    }
  }

  /**
   * 选择解包上限（MC17）：只有「官方签名有效、签名清单与压缩包中的文件条目完全一致、
   * manifest.json 与清单哈希一致且 appId 为首方」的包使用首方上限；预检中任何异常都回落到普通上限，
   * 随后按普通上限报原有错误码。签名不含文件大小，较高上限本身约束解包炸弹；
   * 解包后的逐文件哈希仍由调用方的 verifyDirectory 完成。
   */
  async selectLimits(archivePath: string): Promise<ArchiveLimits> {
    try {
      return (await this.isFirstPartySigned(archivePath)) ? FIRST_PARTY_SIGNED_ARCHIVE_LIMITS : APP_ARCHIVE_LIMITS;
    } catch {
      return APP_ARCHIVE_LIMITS;
    }
  }

  private isFirstPartySigned(archivePath: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      yauzl.open(archivePath, { lazyEntries: true }, (openError, zipFile) => {
        if (openError || !zipFile) {
          reject(openError ?? new Error('APP_ARCHIVE_INVALID'));
          return;
        }
        const names = new Set<string>();
        let entries = 0;
        let signature: Buffer | undefined;
        let manifest: Buffer | undefined;
        let settled = false;
        const finish = (value: boolean | Error) => {
          if (settled) return;
          settled = true;
          zipFile.close();
          if (value instanceof Error) reject(value);
          else resolve(value);
        };
        zipFile.on('error', err => finish(err));
        zipFile.on('end', () => {
          if (settled) return;
          if (!signature || !manifest) return finish(false);
          let envelope: { files?: Record<string, string>; signature?: string };
          try {
            envelope = JSON.parse(signature.toString('utf-8'));
          } catch {
            return finish(false);
          }
          if (verifySignedFileList(envelope).status !== 'valid') return finish(false);
          const files = envelope.files!;
          if (createHash('sha256').update(manifest).digest('hex') !== files['manifest.json']) return finish(false);
          let appId: unknown;
          try {
            appId = JSON.parse(manifest.toString('utf-8'))?.appId;
          } catch {
            return finish(false);
          }
          if (!isFirstPartyAppId(appId)) return finish(false);
          const listed = Object.keys(files);
          if (listed.length !== names.size) return finish(false);
          for (const name of listed) if (!names.has(name)) return finish(false);
          finish(true);
        });
        zipFile.on('entry', (entry: yauzl.Entry) => {
          entries += 1;
          if (entries > FIRST_PARTY_SIGNED_ARCHIVE_LIMITS.maxFiles) return finish(false);
          const name = entry.fileName.replace(/^\.\//, '');
          if (name.endsWith('/')) {
            zipFile.readEntry();
            return;
          }
          const cap = name === SIGNATURE_FILE ? MAX_SIGNATURE_BYTES : name === 'manifest.json' ? MAX_MANIFEST_BYTES : 0;
          if (name !== SIGNATURE_FILE) names.add(name);
          if (!cap) {
            zipFile.readEntry();
            return;
          }
          if (entry.uncompressedSize > cap) return finish(false);
          zipFile.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) return finish(false);
            const chunks: Buffer[] = [];
            let bytes = 0;
            stream.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > cap) {
                stream.destroy();
                finish(false);
                return;
              }
              chunks.push(chunk);
            });
            stream.on('error', () => finish(false));
            stream.on('end', () => {
              if (settled) return;
              const data = Buffer.concat(chunks);
              if (name === SIGNATURE_FILE) signature = data;
              else manifest = data;
              zipFile.readEntry();
            });
          });
        });
        zipFile.readEntry();
      });
    });
  }

  private validateArchive(archivePath: string, limits: ArchiveLimits = APP_ARCHIVE_LIMITS): Promise<void> {
    return new Promise((resolve, reject) => {
      yauzl.open(archivePath, { lazyEntries: true }, (openError, zipFile) => {
        if (openError || !zipFile) {
          reject(openError ?? new Error('APP_ARCHIVE_INVALID'));
          return;
        }

        const exact = new Set<string>();
        const folded = new Map<string, string>();
        let entryCount = 0;
        let totalSize = 0;
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          zipFile.close();
          reject(error);
        };

        zipFile.on('error', fail);
        zipFile.on('end', () => {
          if (settled) return;
          settled = true;
          resolve();
        });
        zipFile.on('entry', entry => {
          try {
            const name = entry.fileName;
            const normalized = this.validateEntryPath(name);
            const isDirectory = name.endsWith('/');
            const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
            const fileType = unixMode & 0o170000;
            if (fileType === 0o120000) throw new Error(`APP_ARCHIVE_SYMLINK: ${name}`);
            if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
              throw new Error(`APP_ARCHIVE_UNSUPPORTED_ENTRY: ${name}`);
            }

            if (exact.has(normalized)) throw new Error(`APP_ARCHIVE_DUPLICATE_PATH: ${name}`);
            exact.add(normalized);
            const lower = normalized.toLocaleLowerCase('en-US');
            const previous = folded.get(lower);
            if (previous && previous !== normalized) {
              throw new Error(`APP_ARCHIVE_CASE_CONFLICT: ${previous} / ${name}`);
            }
            folded.set(lower, normalized);

            entryCount += 1;
            if (entryCount > limits.maxFiles) throw new Error('APP_ARCHIVE_TOO_MANY_FILES');
            if (!isDirectory) {
              totalSize += entry.uncompressedSize;
              if (entry.uncompressedSize > limits.maxEntryBytes) {
                throw new Error(`APP_ARCHIVE_ENTRY_TOO_LARGE: ${name}`);
              }
              if (totalSize > limits.maxUncompressedBytes) {
                throw new Error('APP_ARCHIVE_UNCOMPRESSED_TOO_LARGE');
              }
            }
            zipFile.readEntry();
          } catch (error) {
            fail(error as Error);
          }
        });
        zipFile.readEntry();
      });
    });
  }

  private validateEntryPath(name: string): string {
    if (!name || name.includes('\0') || name.includes('\\')) {
      throw new Error(`APP_ARCHIVE_INVALID_PATH: ${name}`);
    }
    if (Buffer.byteLength(name, 'utf-8') > APP_ARCHIVE_LIMITS.maxPathBytes) {
      throw new Error(`APP_ARCHIVE_PATH_TOO_LONG: ${name}`);
    }
    if (path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || /^[A-Za-z]:/.test(name)) {
      throw new Error(`APP_ARCHIVE_ABSOLUTE_PATH: ${name}`);
    }

    const sourceSegments = name.replace(/\/$/, '').split('/');
    if (sourceSegments.includes('..')) throw new Error(`APP_ARCHIVE_PATH_TRAVERSAL: ${name}`);
    const normalized = path.posix.normalize(name).replace(/\/$/, '');
    const segments = normalized.split('/');
    if (!normalized || normalized === '.' || normalized.startsWith('../')) {
      throw new Error(`APP_ARCHIVE_PATH_TRAVERSAL: ${name}`);
    }
    if (segments.length > APP_ARCHIVE_LIMITS.maxPathDepth) {
      throw new Error(`APP_ARCHIVE_PATH_TOO_DEEP: ${name}`);
    }
    for (const segment of segments) {
      if (!segment || Buffer.byteLength(segment, 'utf-8') > 255 || segment.includes(':') || /[. ]$/.test(segment)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)) {
        throw new Error(`APP_ARCHIVE_INVALID_PATH: ${name}`);
      }
    }
    return normalized;
  }
}
