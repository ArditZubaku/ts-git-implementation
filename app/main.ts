import * as fs from "fs";
import * as zlib from "zlib";
import * as path from "path";
import * as crypto from "crypto";

const args = process.argv.slice(2);
const command = args.at(0);
const hashOrPath = args.pop();

const Commands = {
  Init: "init",
  CatFile: "cat-file",
  HashObject: "hash-object",
  LsTree: "ls-tree",
} as const;

const Paths = {
  dotGit: ".git",
  objects: ".git/objects",
  refs: ".git/refs",
} as const;

function getDecompressedObject(hash: string): Buffer {
  const firstTwo = hash.substring(0, 2);
  const rest = hash.substring(2);
  const objectPath = path.resolve(
    Paths.objects,
    `${firstTwo}/${rest}`,
  );
  const compressedObject = fs.readFileSync(objectPath);
  return zlib.inflateSync(new Uint8Array(compressedObject));
}

function getContentAndHeader(decompressedObject: Buffer): { header: string; content: string } {
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

switch (command) {
  case Commands.Init:
    // You can use print statements as follows for debugging, they'll be visible when running tests.
    console.error("Logs from your program will appear here!");

    //Uncomment this block to pass the first stage
    fs.mkdirSync(".git", { recursive: true });
    fs.mkdirSync(".git/objects", { recursive: true });
    fs.mkdirSync(".git/refs", { recursive: true });
    fs.writeFileSync(".git/HEAD", "ref: refs/heads/main\n");
    console.log("Initialized git directory");
    break;
  case Commands.CatFile:
    if (hashOrPath) {
      const decompressedBlob = getDecompressedObject(hashOrPath);
      const { content } = getContentAndHeader(decompressedBlob);
      process.stdout.write(content);
    } else {
      throw new Error("No hash provided!");
    }
    break;
  case Commands.HashObject:
    const shallWrite = args.indexOf("-w");
    if (hashOrPath) {
      const filePath = path.resolve(hashOrPath);
      const fileSize = fs.statSync(filePath).size;
      const fileContent = fs.readFileSync(filePath);
      const header = Buffer.from(`blob ${fileSize}\0`);
      // I believe there might be a problem with the types somehow bc I am having to do this extra conversion
      const fullContent = Buffer.concat([
        new Uint8Array(header),
        new Uint8Array(fileContent),
      ]);
      // Convert to Uint8Array for consistent typing
      const contentArray = new Uint8Array(fullContent);
      const hash = crypto.createHash("sha1").update(contentArray).digest("hex");
      // Deflate - zlib compressed (not gzip)
      const compressedObject = zlib.deflateSync(contentArray);
      if (shallWrite !== -1) {
        fs.mkdirSync(getObjectPathAndFolder(hash).folderPath, {
          recursive: true,
        });
        // 'wx' - Like 'w' but fails if path exists.
        fs.writeFileSync(
          getObjectPathAndFolder(hash).fileToWritePath,
          new Uint8Array(compressedObject),
          {
            flag: "wx",
          },
        );
        process.stdout.write(hash);
      } else {
        // Some terminals (especially `zsh` and custom shell configurations) may display a % when no newline (\n) is present at the end of the output.
        process.stdout.write(hash);
      }
    } else {
      throw new Error("No target file provided!");
    }
    break;
  case Commands.LsTree:
    const namesOnly = args.indexOf("--name-only");
    if (hashOrPath) {
      const decompressedObject = getDecompressedObject(hashOrPath);
      const entries: { mode: number; type: string; hash: string; name: string }[] = [];
      let pos = decompressedObject.indexOf(0) + 1;
      while (pos < decompressedObject.length) {
        // tree <size>\0<mode> <name>\0<20_byte_sha><mode> <name>\0<20_byte_sha>
        // Find the next null byte which separates the mode+name from the SHA
        const nullByte = decompressedObject.indexOf(0, pos);
        if (nullByte === -1) break;
        // Get the mode and filename
        const entry = decompressedObject.subarray(pos, nullByte).toString();
        const [mode, name] = entry.split(' ');
        // Get the SHA hash (20 bytes after the null byte)
        // Using hex to convert the 20 bytes to a 40 character hash to match the format that the hash-object command outputs
        const hash = decompressedObject.subarray(nullByte + 1, nullByte + 21).toString('hex');
        // Move position to after the SHA hash
        pos = nullByte + 21;
        const { header } = getContentAndHeader(getDecompressedObject(hash));
        const type = header.split(' ')[0];
        entries.push({ mode: parseInt(mode), type, hash, name });
      }
      if (namesOnly !== -1) {
        // Just the names
        entries.forEach(entry => {
          process.stdout.write(entry.name + '\n');
        });
      } else {
        // Full format
        entries.forEach(entry => {
          process.stdout.write(`${entry.mode} ${entry.type} ${entry.hash} ${entry.name}\n`);
        });
      }
    } else {
      throw new Error("No hash provided!");
    }
    break;
  default:
    throw new Error(`Unknown command ${command}`);
}
