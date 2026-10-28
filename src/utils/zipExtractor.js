import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { INGESTION_LIMITS } from '../config/constants.js';

/**
 * Decompresses deflated data while strictly enforcing limits on bytes actually produced.
 * Protects against zip bombs with false/spoofed header sizes.
 *
 * @param {Buffer} compressedBuffer
 * @param {string} entryName
 * @param {number} maxSingleBytes
 * @param {number} maxTotalBytes
 * @param {number} currentTotalBytes
 * @returns {Promise<Buffer>}
 */
function decompressDeflateStream(
  compressedBuffer,
  entryName,
  maxSingleBytes,
  maxTotalBytes,
  currentTotalBytes
) {
  return new Promise((resolve, reject) => {
    const inflate = zlib.createInflateRaw();
    const chunks = [];
    let entryBytes = 0;
    let settled = false;

    function cleanupAndReject(err) {
      if (!settled) {
        settled = true;
        inflate.destroy();
        reject(err);
      }
    }

    inflate.on('data', (chunk) => {
      entryBytes += chunk.length;

      if (entryBytes > maxSingleBytes) {
        cleanupAndReject(
          new Error(
            `Extraction limit exceeded: Entry "${entryName}" decompressed size exceeds single-file limit (${maxSingleBytes} bytes).`
          )
        );
        return;
      }

      if (currentTotalBytes + entryBytes > maxTotalBytes) {
        cleanupAndReject(
          new Error(
            `Extraction limit exceeded: Total archive decompressed size exceeds limit of ${maxTotalBytes} bytes.`
          )
        );
        return;
      }

      chunks.push(chunk);
    });

    inflate.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });

    inflate.on('error', (err) => {
      cleanupAndReject(new Error(`Failed to decompress entry "${entryName}": ${err.message}`));
    });

    inflate.end(compressedBuffer);
  });
}

/**
 * Extracts a ZIP buffer into destDir with strict security limits:
 * - Limits enforced on BYTES ACTUALLY DECOMPRESSED (defending against zip bombs with fake header sizes)
 * - Limits enforced on count of files actually extracted
 * - Skips symlink entries
 * - Zip-slip path traversal prevention
 * - Automatic cleanup of temp folder on failure
 *
 * @param {Buffer} buffer
 * @param {string} destDir
 * @param {object} [options]
 * @param {number} [options.maxArchiveSizeBytes]
 * @param {number} [options.maxFileCount]
 * @param {number} [options.maxSingleFileSizeBytes]
 * @param {boolean} [options.stripRootPrefix=true]
 * @returns {Promise<Array<{ relativePath: string, fullPath: string, sizeBytes: number }>>}
 */
export async function extractZipBuffer(buffer, destDir, options = {}) {
  const maxArchiveSizeBytes =
    options.maxArchiveSizeBytes ??
    INGESTION_LIMITS.DEFAULT_MAX_ARCHIVE_SIZE_MB * 1024 * 1024;
  const maxFileCount =
    options.maxFileCount ?? INGESTION_LIMITS.DEFAULT_MAX_FILE_COUNT;
  const maxSingleFileSizeBytes =
    options.maxSingleFileSizeBytes ??
    INGESTION_LIMITS.DEFAULT_MAX_FILE_SIZE_KB * 1024;
  const stripRootPrefix = options.stripRootPrefix ?? true;

  const resolvedDestDir = path.resolve(destDir);
  fs.mkdirSync(resolvedDestDir, { recursive: true });

  try {
    // 1. Locate End of Central Directory (EOCD) signature: 0x06054b50
    let eocdOffset = -1;
    for (let i = buffer.length - 22; i >= 0; i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }

    if (eocdOffset === -1) {
      throw new Error('Invalid ZIP archive: End of Central Directory (EOCD) record not found.');
    }

    const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
    const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

    // 2. Parse Central Directory headers
    let cur = cdOffset;
    const cdEntries = [];
    for (let i = 0; i < totalEntries; i++) {
      if (cur + 46 > buffer.length || buffer.readUInt32LE(cur) !== 0x02014b50) {
        throw new Error('Invalid ZIP archive: Corrupted Central Directory header.');
      }

      const method = buffer.readUInt16LE(cur + 10);
      const compressedSize = buffer.readUInt32LE(cur + 20);
      const nameLen = buffer.readUInt16LE(cur + 28);
      const extraLen = buffer.readUInt16LE(cur + 30);
      const commentLen = buffer.readUInt16LE(cur + 32);
      const externalAttrs = buffer.readUInt32LE(cur + 38);
      const localHeaderOffset = buffer.readUInt32LE(cur + 42);

      const entryName = buffer.toString('utf8', cur + 46, cur + 46 + nameLen);
      cur += 46 + nameLen + extraLen + commentLen;

      // Check if entry is a symlink: UNIX mode in upper 16 bits: 0o120000 = symlink
      const unixMode = (externalAttrs >>> 16) & 0xffff;
      const isSymlink = (unixMode & 0o170000) === 0o120000;

      cdEntries.push({
        name: entryName,
        method,
        compressedSize,
        localHeaderOffset,
        isSymlink,
      });
    }

    // Determine common root prefix (e.g. GitHub archive top folder)
    let commonPrefix = '';
    if (stripRootPrefix && cdEntries.length > 0) {
      const firstEntry = cdEntries[0].name;
      const slashIndex = firstEntry.indexOf('/');
      if (slashIndex !== -1) {
        const potentialPrefix = firstEntry.slice(0, slashIndex + 1);
        const allSharePrefix = cdEntries.every((e) => e.name.startsWith(potentialPrefix));
        if (allSharePrefix) {
          commonPrefix = potentialPrefix;
        }
      }
    }

    let totalActuallyDecompressed = 0;
    let actualFileCount = 0;
    const extractedFiles = [];

    // 3. Extract entries with actual byte tracking
    for (const entry of cdEntries) {
      // Security: Skip symlinks entirely
      if (entry.isSymlink) {
        continue;
      }

      const isDirectory = entry.name.endsWith('/');
      let normalizedRelative = entry.name;
      if (commonPrefix && normalizedRelative.startsWith(commonPrefix)) {
        normalizedRelative = normalizedRelative.slice(commonPrefix.length);
      }

      if (!normalizedRelative || normalizedRelative === '.') {
        continue;
      }

      // Zip-slip path traversal check
      const targetPath = path.resolve(resolvedDestDir, normalizedRelative);
      const expectedPrefix = resolvedDestDir + path.sep;
      if (!targetPath.startsWith(expectedPrefix) && targetPath !== resolvedDestDir) {
        throw new Error(`Security Error: Zip-slip path traversal detected in entry: "${entry.name}".`);
      }

      if (isDirectory) {
        fs.mkdirSync(targetPath, { recursive: true });
        continue;
      }

      // Check file count limit on actual files being extracted
      actualFileCount++;
      if (actualFileCount > maxFileCount) {
        throw new Error(
          `Extraction limit exceeded: Archive contains more than ${maxFileCount} extracted files.`
        );
      }

      // Verify and locate local file header (0x04034b50)
      const lOffset = entry.localHeaderOffset;
      if (lOffset + 30 > buffer.length || buffer.readUInt32LE(lOffset) !== 0x04034b50) {
        throw new Error(`Invalid ZIP archive: Corrupted local header for "${entry.name}".`);
      }

      const lNameLen = buffer.readUInt16LE(lOffset + 26);
      const lExtraLen = buffer.readUInt16LE(lOffset + 28);
      const dataStart = lOffset + 30 + lNameLen + lExtraLen;

      if (dataStart + entry.compressedSize > buffer.length) {
        throw new Error(`Invalid ZIP archive: Truncated entry data for "${entry.name}".`);
      }

      const rawData = buffer.subarray(dataStart, dataStart + entry.compressedSize);
      let contentBuffer;

      if (entry.method === 0) {
        // Stored (uncompressed)
        if (rawData.length > maxSingleFileSizeBytes) {
          throw new Error(
            `Extraction limit exceeded: Entry "${normalizedRelative}" decompressed size exceeds single-file limit (${maxSingleFileSizeBytes} bytes).`
          );
        }
        if (totalActuallyDecompressed + rawData.length > maxArchiveSizeBytes) {
          throw new Error(
            `Extraction limit exceeded: Total archive decompressed size exceeds limit of ${maxArchiveSizeBytes} bytes.`
          );
        }
        contentBuffer = rawData;
      } else if (entry.method === 8) {
        // Deflated: stream-decompress while enforcing limits on bytes actually output
        contentBuffer = await decompressDeflateStream(
          rawData,
          normalizedRelative,
          maxSingleFileSizeBytes,
          maxArchiveSizeBytes,
          totalActuallyDecompressed
        );
      } else {
        throw new Error(`Unsupported compression method ${entry.method} in entry "${entry.name}".`);
      }

      totalActuallyDecompressed += contentBuffer.length;

      // Ensure directory exists and write file
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, contentBuffer);

      extractedFiles.push({
        relativePath: normalizedRelative.replace(/\\/g, '/'),
        fullPath: targetPath,
        sizeBytes: contentBuffer.length,
      });
    }

    return extractedFiles;
  } catch (err) {
    // Delete temp directory on failure
    try {
      if (fs.existsSync(resolvedDestDir)) {
        fs.rmSync(resolvedDestDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error during rethrow
    }
    throw err;
  }
}
