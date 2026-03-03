import * as fs from "fs";
import * as zlib from "zlib";
import * as path from "path";
import * as crypto from "crypto";
import * as https from "https";
import * as http from "http";

const args = process.argv.slice(2);
const command = args.at(0);

const Commands = {
  Init: "init",
  CatFile: "cat-file",
  HashObject: "hash-object",
  LsTree: "ls-tree",
  WriteTree: "write-tree",
  CommitTree: "commit-tree",
  Clone: "clone",
} as const;

const Paths = {
  dotGit: ".git",
  objects: ".git/objects",
  refs: ".git/refs",
} as const;

function getDecompressedObject(hash: string): Buffer {
  const firstTwo = hash.substring(0, 2);
  const rest = hash.substring(2);
  const objectPath = path.resolve(Paths.objects, `${firstTwo}/${rest}`);
  const compressedObject = fs.readFileSync(objectPath);
  return zlib.inflateSync(new Uint8Array(compressedObject));
}

function getContentAndHeader(decompressedObject: Buffer): {
  header: string;
  content: string;
} {
  // Find the null byte position in the buffer
  // https://en.wikipedia.org/wiki/Null_character
  const nullByteIndex = decompressedObject.indexOf(0);
  // Get the header as string
  const header = decompressedObject.subarray(0, nullByteIndex).toString();
  // Get the content part (might be binary)
  const content = decompressedObject.subarray(nullByteIndex + 1);
  return {
    header,
    content: content.toString(),
  };
}

function getObjectPathAndFolder(hash: string): {
  fileToWritePath: string;
  folderPath: string;
} {
  const [firstNumber, secondNumber, ...restOfTheNumbers] = hash;
  const fileToWriteName = restOfTheNumbers.join("");
  const folderPath = `${Paths.objects}/${firstNumber}${secondNumber}`;
  const fileToWritePath = `${folderPath}/${fileToWriteName}`;

  return {
    fileToWritePath,
    folderPath,
  };
}

function getCompressedObjectAndHash(
  header: Buffer,
  fileContent: Buffer,
  encoding: crypto.BinaryToTextEncoding,
): { hash: string; compressedObject: Buffer };
function getCompressedObjectAndHash(
  header: Buffer,
  fileContent: Buffer,
): { hash: Buffer; compressedObject: Buffer };
function getCompressedObjectAndHash(
  header: Buffer,
  fileContent: Buffer,
  encoding?: crypto.BinaryToTextEncoding,
) {
  const fullContent = Buffer.concat([header, fileContent]);

  let hash: string | Buffer;
  if (encoding) {
    hash = crypto.createHash("sha1").update(fullContent).digest(encoding);
  } else {
    hash = crypto.createHash("sha1").update(fullContent).digest();
  }

  // Deflate - zlib compressed (not gzip)
  const compressedObject = zlib.deflateSync(fullContent);
  return { hash, compressedObject };
}

function writeObject(hash: string | Buffer, compressedObject: Buffer) {
  const hashStr = hash.toString("hex");
  fs.mkdirSync(getObjectPathAndFolder(hashStr).folderPath, {
    recursive: true,
  });
  // 'wx' - Like 'w' but fails if path exists.
  fs.writeFileSync(
    getObjectPathAndFolder(hashStr).fileToWritePath,
    compressedObject,
    {
      flag: "wx",
    },
  );
  return hashStr;
}

function hashObject(
  shallWrite: boolean,
  argPath: string,
  encoding?: crypto.BinaryToTextEncoding,
): string | Buffer {
  const filePath = path.resolve(argPath);
  const fileSize = fs.statSync(filePath).size;
  const fileContent = fs.readFileSync(filePath);
  const header = Buffer.from(`blob ${fileSize}\0`);
  let result;
  if (encoding) {
    result = getCompressedObjectAndHash(header, fileContent, encoding);
  } else {
    result = getCompressedObjectAndHash(header, fileContent);
  }
  const hash = result.hash;
  const compressedObject = result.compressedObject;
  if (shallWrite) {
    writeObject(hash, compressedObject);
  }

  return hash;
}

function addTreeEntry(
  mode: string,
  name: string,
  hash: Buffer,
  entries: Buffer[],
) {
  const modeAndName = Buffer.from(`${mode} ${name}\0`);
  const entry = Buffer.concat([modeAndName, hash]);
  entries.push(entry);
}

function writeTree(dirPath: string): string {
  const entries: Buffer[] = [];
  const items = fs
    .readdirSync(dirPath)
    .filter((item) => !item.startsWith("."))
    .sort(); // Sort to ensure consistent tree hashes

  for (const item of items) {
    const itemPath = path.join(dirPath, item);
    const stats = fs.statSync(itemPath);

    if (stats.isDirectory()) {
      // For directories, create a tree object and add an entry pointing to it
      const treeHash = writeTree(itemPath);
      const hashBuffer = Buffer.from(treeHash, "hex");
      addTreeEntry("40000", item, hashBuffer, entries);
    } else {
      // For files, hash the file and add an entry pointing to it
      const fileHash = hashObject(true, itemPath) as Buffer;
      const mode = stats.mode & 0o111 ? "100755" : "100644"; // Check if executable
      addTreeEntry(mode, item, fileHash, entries);
    }
  }

  // Create tree content
  const treeContent = Buffer.concat(entries);
  const header = Buffer.from(`tree ${treeContent.length}\0`);
  const { hash, compressedObject } = getCompressedObjectAndHash(
    header,
    treeContent,
  );

  // Write tree object to .git/objects
  return writeObject(hash, compressedObject);
}

// ─── Git Smart HTTP Clone ────────────────────────────────────────────────────

function httpGet(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function httpPost(url: string, body: Buffer, contentType: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = url.startsWith("https") ? https : http;
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (url.startsWith("https") ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "Content-Length": body.length,
        "Git-Protocol": "version=1",
      },
    };
    const req = client.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Parse pkt-line format: 4-hex-digit length prefix, then data
// Length includes the 4 bytes of the length itself
// "0000" is a flush packet
function parsePktLines(buf: Buffer): string[] {
  const lines: string[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const lenHex = buf.subarray(pos, pos + 4).toString("ascii");
    if (lenHex === "0000") {
      pos += 4;
      continue;
    }
    const len = parseInt(lenHex, 16);
    if (len < 4) break;
    const data = buf.subarray(pos + 4, pos + len).toString("utf8").replace(/\n$/, "");
    lines.push(data);
    pos += len;
  }
  return lines;
}

function pktLine(data: string): Buffer {
  const len = data.length + 4;
  const lenHex = len.toString(16).padStart(4, "0");
  return Buffer.from(lenHex + data);
}

const PKT_FLUSH = Buffer.from("0000");

// ─── Packfile parsing ────────────────────────────────────────────────────────

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

const OBJ_TYPE_NAMES: Record<number, string> = {
  [OBJ_COMMIT]: "commit",
  [OBJ_TREE]: "tree",
  [OBJ_BLOB]: "blob",
  [OBJ_TAG]: "tag",
};

// Read a variable-length size from the packfile (little-endian with MSB continuation)
function readVarInt(buf: Buffer, pos: number): { value: number; newPos: number } {
  let value = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = buf[pos++];
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { value, newPos: pos };
}

// Read big-endian variable size used for OFS_DELTA negative offset encoding
function readOffsetEncoding(buf: Buffer, pos: number): { value: number; newPos: number } {
  let byte = buf[pos++];
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[pos++];
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { value, newPos: pos };
}

// Apply a git delta to a base buffer
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;

  // Read source size
  let srcSize = 0, shift = 0, byte: number;
  do {
    byte = delta[pos++];
    srcSize |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);

  // Read target size
  let tgtSize = 0;
  shift = 0;
  do {
    byte = delta[pos++];
    tgtSize |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);

  const result = Buffer.alloc(tgtSize);
  let resultPos = 0;

  while (pos < delta.length) {
    const opcode = delta[pos++];
    if (opcode & 0x80) {
      // Copy instruction
      let copyOffset = 0, copySize = 0;
      if (opcode & 0x01) copyOffset |= delta[pos++];
      if (opcode & 0x02) copyOffset |= delta[pos++] << 8;
      if (opcode & 0x04) copyOffset |= delta[pos++] << 16;
      if (opcode & 0x08) copyOffset |= delta[pos++] << 24;
      if (opcode & 0x10) copySize |= delta[pos++];
      if (opcode & 0x20) copySize |= delta[pos++] << 8;
      if (opcode & 0x40) copySize |= delta[pos++] << 16;
      if (copySize === 0) copySize = 0x10000;
      base.copy(result, resultPos, copyOffset, copyOffset + copySize);
      resultPos += copySize;
    } else if (opcode > 0) {
      // Insert instruction
      delta.copy(result, resultPos, pos, pos + opcode);
      resultPos += opcode;
      pos += opcode;
    }
  }

  return result;
}

interface ParsedObject {
  type: number;
  data: Buffer;
  offset: number; // offset in packfile where this object starts
}

function parsePackfile(pack: Buffer, objectsDir: string): void {
  // Verify header: "PACK", version=2, object count
  if (pack.subarray(0, 4).toString("ascii") !== "PACK") {
    throw new Error("Invalid packfile signature");
  }
  const numObjects = pack.readUInt32BE(8);

  // First pass: collect raw objects (some may be deltas)
  const rawObjects: ParsedObject[] = [];
  // Map from offset -> index in rawObjects
  const offsetToIndex: Map<number, number> = new Map();

  let pos = 12;

  for (let i = 0; i < numObjects; i++) {
    const objectStart = pos;
    // Read type and size (variable length)
    let byte = pack[pos++];
    const type = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }

    if (type === OBJ_OFS_DELTA) {
      const { value: negOffset, newPos } = readOffsetEncoding(pack, pos);
      pos = newPos;
      const { data, bytesConsumed } = inflateFromPos(pack, pos);
      pos += bytesConsumed;
      rawObjects.push({ type: OBJ_OFS_DELTA, data, offset: objectStart });
      // Store the negative offset reference
      (rawObjects[rawObjects.length - 1] as any).baseOffset = objectStart - negOffset;
      offsetToIndex.set(objectStart, rawObjects.length - 1);
    } else if (type === OBJ_REF_DELTA) {
      const baseHash = pack.subarray(pos, pos + 20).toString("hex");
      pos += 20;
      const { data, bytesConsumed } = inflateFromPos(pack, pos);
      pos += bytesConsumed;
      rawObjects.push({ type: OBJ_REF_DELTA, data, offset: objectStart });
      (rawObjects[rawObjects.length - 1] as any).baseHash = baseHash;
      offsetToIndex.set(objectStart, rawObjects.length - 1);
    } else {
      const { data, bytesConsumed } = inflateFromPos(pack, pos);
      pos += bytesConsumed;
      rawObjects.push({ type, data, offset: objectStart });
      offsetToIndex.set(objectStart, rawObjects.length - 1);
    }
  }

  // Build a map of hash -> {type, data} for resolved objects
  const resolvedByHash: Map<string, { type: number; data: Buffer }> = new Map();

  // Write a resolved object to disk and return its hash
  function writeResolved(type: number, data: Buffer): string {
    const typeName = OBJ_TYPE_NAMES[type];
    const header = Buffer.from(`${typeName} ${data.length}\0`);
    const full = Buffer.concat([header, data]);
    const hash = crypto.createHash("sha1").update(full).digest("hex");
    const compressed = zlib.deflateSync(full);
    const dir = path.join(objectsDir, hash.substring(0, 2));
    const file = path.join(dir, hash.substring(2));
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, compressed, { flag: "wx" });
    }
    resolvedByHash.set(hash, { type, data });
    return hash;
  }

  // First pass: write all non-delta objects
  for (const obj of rawObjects) {
    if (obj.type !== OBJ_OFS_DELTA && obj.type !== OBJ_REF_DELTA) {
      writeResolved(obj.type, obj.data);
    }
  }

  // Resolve OFS_DELTA objects (may need multiple passes for chained deltas)
  let changed = true;
  let maxPasses = 100;
  while (changed && maxPasses-- > 0) {
    changed = false;
    for (const obj of rawObjects) {
      if (obj.type === OBJ_OFS_DELTA) {
        const baseOffset = (obj as any).baseOffset as number;
        const baseIdx = offsetToIndex.get(baseOffset);
        if (baseIdx === undefined) continue;
        const baseObj = rawObjects[baseIdx];
        if (baseObj.type === OBJ_OFS_DELTA || baseObj.type === OBJ_REF_DELTA) continue;
        // Find base hash by re-deriving it
        const baseTypeName = OBJ_TYPE_NAMES[baseObj.type];
        const baseHeader = Buffer.from(`${baseTypeName} ${baseObj.data.length}\0`);
        const baseFull = Buffer.concat([baseHeader, baseObj.data]);
        const baseHash = crypto.createHash("sha1").update(baseFull).digest("hex");
        if (!resolvedByHash.has(baseHash)) continue;
        const base = resolvedByHash.get(baseHash)!;
        const resolved = applyDelta(base.data, obj.data);
        obj.data = resolved;
        obj.type = base.type;
        writeResolved(obj.type, obj.data);
        changed = true;
      }
    }
  }

  // Resolve REF_DELTA objects
  changed = true;
  maxPasses = 100;
  while (changed && maxPasses-- > 0) {
    changed = false;
    for (const obj of rawObjects) {
      if (obj.type === OBJ_REF_DELTA) {
        const baseHash = (obj as any).baseHash as string;
        if (!resolvedByHash.has(baseHash)) continue;
        const base = resolvedByHash.get(baseHash)!;
        const resolved = applyDelta(base.data, obj.data);
        obj.data = resolved;
        obj.type = base.type;
        writeResolved(obj.type, obj.data);
        changed = true;
      }
    }
  }
}

// Inflate a zlib stream from buf at pos, returning {data, bytesConsumed}
// Uses the fact that zlib deflate streams end with a checksum we can detect
function inflateFromPos(buf: Buffer, pos: number): { data: Buffer; bytesConsumed: number } {
  // Use binary search: find the minimum length such that inflateSync succeeds
  // inflateSync throws if the stream is truncated or invalid
  // Once it succeeds with length L, the actual stream end is at most L bytes from pos
  // We want the MINIMUM L where it succeeds - that's the stream boundary
  let lo = 2; // minimum zlib stream is 2 bytes header + data
  let hi = buf.length - pos;
  // Exponential probe to find an upper bound that works
  let probe = Math.min(32, hi);
  while (probe < hi) {
    try {
      zlib.inflateSync(buf.subarray(pos, pos + probe));
      hi = probe;
      break;
    } catch {
      probe = Math.min(probe * 2, hi);
    }
  }
  if (probe >= hi) {
    // Try full remaining
    try {
      zlib.inflateSync(buf.subarray(pos, pos + hi));
    } catch {
      throw new Error(`Failed to inflate at position ${pos}`);
    }
  }
  // Binary search for minimum working length
  lo = 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      zlib.inflateSync(buf.subarray(pos, pos + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  const data = zlib.inflateSync(buf.subarray(pos, pos + lo));
  return { data, bytesConsumed: lo };
}


// Checkout a tree object recursively into dirPath
function checkoutTree(treeHash: string, dirPath: string, objectsDir: string): void {
  fs.mkdirSync(dirPath, { recursive: true });

  const firstTwo = treeHash.substring(0, 2);
  const rest = treeHash.substring(2);
  const objectPath = path.join(objectsDir, firstTwo, rest);
  const compressed = fs.readFileSync(objectPath);
  const decompressed = zlib.inflateSync(compressed);

  // Skip header
  const nullIdx = decompressed.indexOf(0);
  let pos = nullIdx + 1;

  while (pos < decompressed.length) {
    // mode[space]name[null]20-byte-sha
    const nullByte = decompressed.indexOf(0, pos);
    if (nullByte === -1) break;
    const entry = decompressed.subarray(pos, nullByte).toString();
    const spaceIdx = entry.indexOf(" ");
    const mode = entry.substring(0, spaceIdx);
    const name = entry.substring(spaceIdx + 1);
    const hash = decompressed.subarray(nullByte + 1, nullByte + 21).toString("hex");
    pos = nullByte + 21;

    const fullPath = path.join(dirPath, name);
    if (mode === "40000" || mode === "040000") {
      // directory
      checkoutTree(hash, fullPath, objectsDir);
    } else {
      // file
      const fFirstTwo = hash.substring(0, 2);
      const fRest = hash.substring(2);
      const fPath = path.join(objectsDir, fFirstTwo, fRest);
      const fCompressed = fs.readFileSync(fPath);
      const fDecompressed = zlib.inflateSync(fCompressed);
      const fNullIdx = fDecompressed.indexOf(0);
      const fileData = fDecompressed.subarray(fNullIdx + 1);
      fs.writeFileSync(fullPath, fileData);
      // Set executable bit if needed
      if (mode === "100755") {
        fs.chmodSync(fullPath, 0o755);
      }
    }
  }
}

async function cloneRepo(repoUrl: string, destDir: string): Promise<void> {
  // Step 1: Discover refs via Smart HTTP
  const infoRefsUrl = `${repoUrl}/info/refs?service=git-upload-pack`;
  const infoRefsData = await httpGet(infoRefsUrl);

  const lines = parsePktLines(infoRefsData);
  // First line is "# service=git-upload-pack", then a flush, then refs
  // lines[0] = "# service=git-upload-pack"
  // lines[1..] = refs

  let headHash: string | null = null;
  let defaultBranch = "master"; // fallback
  const wants: string[] = [];
  const allRefs: Map<string, string> = new Map();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (i === 1) {
      // First ref line contains capabilities after NUL
      const nullIdx = line.indexOf("\0");
      let refLine = line;
      if (nullIdx !== -1) {
        refLine = line.substring(0, nullIdx);
        const caps = line.substring(nullIdx + 1);
        // Parse symref=HEAD:refs/heads/main to find default branch
        const symrefMatch = caps.match(/symref=HEAD:([^\s]+)/);
        if (symrefMatch) {
          const symTarget = symrefMatch[1]; // e.g. "refs/heads/main"
          const branchMatch = symTarget.match(/^refs\/heads\/(.+)$/);
          if (branchMatch) defaultBranch = branchMatch[1];
        }
      }
      const parts = refLine.split(" ");
      const hash = parts[0];
      const refName = parts[1];
      allRefs.set(refName, hash);
      wants.push(hash);
      if (refName === "HEAD") headHash = hash;
    } else {
      const parts = line.split(" ");
      if (parts.length >= 2) {
        allRefs.set(parts[1], parts[0]);
        wants.push(parts[0]);
      }
    }
  }

  if (!headHash && wants.length > 0) headHash = wants[0];

  // Build upload-pack request
  // want lines + flush + done
  const wantLines: Buffer[] = [];
  const uniqueWants = [...new Set(wants)];
  for (let i = 0; i < uniqueWants.length; i++) {
    const wantLine = i === 0
      ? `want ${uniqueWants[i]} multi_ack_detailed side-band-64k ofs-delta\n`
      : `want ${uniqueWants[i]}\n`;
    wantLines.push(pktLine(wantLine));
  }
  wantLines.push(PKT_FLUSH);
  wantLines.push(Buffer.from("0009done\n")); // pkt-line "done\n" = 4+5=9

  const requestBody = Buffer.concat(wantLines);

  // Step 2: POST to git-upload-pack
  const packUrl = `${repoUrl}/git-upload-pack`;
  const packResponse = await httpPost(
    packUrl,
    requestBody,
    "application/x-git-upload-pack-request"
  );

  // Step 3: Parse side-band-64k response to extract packfile
  // Response is pkt-lines, each with 1-byte band indicator:
  // band 1 = packfile data, band 2 = progress, band 3 = error
  const packChunks: Buffer[] = [];
  let rpos = 0;
  while (rpos < packResponse.length) {
    const lenHex = packResponse.subarray(rpos, rpos + 4).toString("ascii");
    if (lenHex === "0000") {
      rpos += 4;
      continue;
    }
    const pktLen = parseInt(lenHex, 16);
    if (isNaN(pktLen) || pktLen < 4) { rpos += 4; continue; }
    const pktData = packResponse.subarray(rpos + 4, rpos + pktLen);
    rpos += pktLen;
    const band = pktData[0];
    if (band === 1) {
      packChunks.push(pktData.subarray(1));
    }
    // Ignore band 2 (progress) and band 3 (error) for now
  }

  const packData = Buffer.concat(packChunks);

  // Find "PACK" header in the response (skip any NAK/ACK lines before it)
  let packStart = 0;
  for (let i = 0; i <= packData.length - 4; i++) {
    if (packData.subarray(i, i + 4).toString("ascii") === "PACK") {
      packStart = i;
      break;
    }
  }
  const packfile = packData.subarray(packStart);

  // Step 4: Initialize destination git repo
  fs.mkdirSync(destDir, { recursive: true });
  const gitDir = path.join(destDir, ".git");
  fs.mkdirSync(path.join(gitDir, "objects"), { recursive: true });
  fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
  fs.mkdirSync(path.join(gitDir, "refs", "tags"), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${defaultBranch}\n`);

  const objectsDir = path.join(gitDir, "objects");

  // Step 5: Parse and write all objects from packfile
  parsePackfile(packfile, objectsDir);

  // Step 6: Write all received refs
  for (const [refName, refHash] of allRefs) {
    if (refName === "HEAD") continue; // HEAD is a symref, not stored in refs/
    if (refName.startsWith("refs/heads/") || refName.startsWith("refs/tags/")) {
      const refPath = path.join(gitDir, refName);
      fs.mkdirSync(path.dirname(refPath), { recursive: true });
      fs.writeFileSync(refPath, refHash + "\n");
    }
  }

  // Step 7: Read the commit to get tree hash and checkout working tree
  if (headHash) {
    const commitPath = path.join(objectsDir, headHash.substring(0, 2), headHash.substring(2));
    const commitCompressed = fs.readFileSync(commitPath);
    const commitDecompressed = zlib.inflateSync(commitCompressed);
    const commitNullIdx = commitDecompressed.indexOf(0);
    const commitContent = commitDecompressed.subarray(commitNullIdx + 1).toString();
    const treeMatch = commitContent.match(/^tree ([0-9a-f]{40})/m);
    if (treeMatch) {
      const treeHash = treeMatch[1];
      // Step 8: Checkout working tree
      checkoutTree(treeHash, destDir, objectsDir);
    }
  }
}

// ─── Switch ──────────────────────────────────────────────────────────────────

switch (command) {
  case Commands.Init:
    fs.mkdirSync(".git", { recursive: true });
    fs.mkdirSync(".git/objects", { recursive: true });
    fs.mkdirSync(".git/refs", { recursive: true });
    fs.writeFileSync(".git/HEAD", "ref: refs/heads/main\n");
    console.log("Initialized git directory");
    break;
  case Commands.CatFile: {
    const hash = args.pop();
    if (hash) {
      const decompressedBlob = getDecompressedObject(hash);
      const { content } = getContentAndHeader(decompressedBlob);
      process.stdout.write(content);
    } else {
      throw new Error("No hash provided!");
    }
    break;
  }
  case Commands.HashObject: {
    const shallWrite = args.indexOf("-w") !== -1;
    const path = args.pop();
    if (path) {
      const hash = hashObject(shallWrite, path, "hex");
      // Some terminals (especially `zsh` and custom shell configurations) may display a % when no newline (\n) is present at the end of the output.
      process.stdout.write(hash as string);
    } else {
      throw new Error("No target file provided!");
    }
    break;
  }
  case Commands.LsTree: {
    const namesOnly = args.indexOf("--name-only");
    const hash = args.pop();
    if (hash) {
      const decompressedObject = getDecompressedObject(hash);
      const entries: {
        mode: number;
        type: string;
        hash: string;
        name: string;
      }[] = [];
      let pos = decompressedObject.indexOf(0) + 1;
      while (pos < decompressedObject.length) {
        // tree <size>\0<mode> <name>\0<20_byte_sha><mode> <name>\0<20_byte_sha>
        // Find the next null byte which separates the mode+name from the SHA
        const nullByte = decompressedObject.indexOf(0, pos);
        if (nullByte === -1) break;
        // Get the mode and filename
        const entry = decompressedObject.subarray(pos, nullByte).toString();
        const [mode, name] = entry.split(" ");
        // Get the SHA hash (20 bytes after the null byte)
        // Using hex to convert the 20 bytes to a 40 character hash to match the format that the hash-object command outputs
        const hash = decompressedObject
          .subarray(nullByte + 1, nullByte + 21)
          .toString("hex");
        // Move position to after the SHA hash
        pos = nullByte + 21;
        const { header } = getContentAndHeader(getDecompressedObject(hash));
        const type = header.split(" ")[0];
        entries.push({ mode: parseInt(mode), type, hash, name });
      }
      if (namesOnly !== -1) {
        // Just the names
        entries.forEach((entry) => {
          process.stdout.write(entry.name + "\n");
        });
      } else {
        // Full format
        entries.forEach((entry) => {
          process.stdout.write(
            `${entry.mode} ${entry.type} ${entry.hash} ${entry.name}\n`,
          );
        });
      }
    } else {
      throw new Error("No hash provided!");
    }
    break;
  }
  case Commands.WriteTree: {
    // Create tree objects recursively starting from current directory
    const treeHash = writeTree(".");
    process.stdout.write(treeHash);
    break;
  }
  case Commands.CommitTree: {
    // The format of the commit object in Git:
    // commit <size>\0
    // tree <tree-sha>
    // parent <parent-sha>
    // author <name> <email> <timestamp>
    // committer <name> <email> <timestamp>
    
    // <message>
    // We don't care about the positional args
    const [_command, treeSha, _dashP, commitSha, _dashM, message] = args;

    const name = "ArditZubaku"
    const email = "zubakuardit@gmail.com";
    const timestamp = Date.now();

    // Building the content by following te above format
    const content = Buffer.from(`tree ${treeSha}\nparent ${commitSha}\nauthor ${name} ${email} ${timestamp}\ncommittter ${name} ${email} ${timestamp}\n\n${message}\n`);

    const header = Buffer.from(`commit ${content.byteLength}\0`);
    const { hash, compressedObject } = getCompressedObjectAndHash(header, content);

    // Write commit object to .git/objects
    process.stdout.write(writeObject(hash, compressedObject));
    break;
  }
  case Commands.Clone: {
    const repoUrl = args[1];
    const destDir = args[2];
    if (!repoUrl || !destDir) {
      throw new Error("Usage: clone <url> <directory>");
    }
    cloneRepo(repoUrl, destDir).catch((err) => {
      console.error(err);
      process.exit(1);
    });
    break;
  }
  default:
    throw new Error(`Unknown command ${command}`);
}
