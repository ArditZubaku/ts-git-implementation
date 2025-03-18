import * as fs from "fs";
import * as zlib from "zlib";
import * as path from "path";
import * as crypto from "crypto";

const args = process.argv.slice(2);
const command = args.at(0);

const Commands = {
  Init: "init",
  CatFile: "cat-file",
  HashObject: "hash-object",
  LsTree: "ls-tree",
  WriteTree: "write-tree",
  CommitTree: "commit-tree",
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

  default:
    throw new Error(`Unknown command ${command}`);
}
