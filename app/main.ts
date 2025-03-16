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
} as const;

const Paths = {
  dotGit: ".git",
  objects: ".git/objects",
  refs: ".git/refs",
} as const;

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
    const hash = args.pop();
    const blobPath = path.resolve(
      Paths.objects,
      `${hash?.at(0)}${hash?.at(1)}/${hash?.slice(2)}`,
    );
    const compressedBlob = fs.readFileSync(blobPath);
    // Convert Buffer to Uint8Array explicitly to satisfy TypeScript
    const decompressedBlob = zlib
      .unzipSync(new Uint8Array(compressedBlob))
      .toString();
    // https://en.wikipedia.org/wiki/Null_character
    const content = decompressedBlob.slice(decompressedBlob.indexOf("\0") + 1);
    process.stdout.write(content);
    break;
  case Commands.HashObject:
    const shallWrite = args.indexOf("-w");
    const fileName = args.pop();
    if (fileName) {
      const filePath = path.resolve(fileName);
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
      const [firstNumber, secondNumber, ...restOfTheNumbers] = hash;
      const fileToWriteName = restOfTheNumbers.join("");
      // Use the same content array for compression
      // Deflate - zlib compressed (not gzip)
      const compressedObject = zlib.deflateSync(contentArray);
      const folderPath = `${Paths.objects}/${firstNumber}${secondNumber}`;
      const fileToWritePath = `${folderPath}/${fileToWriteName}`;
      if (shallWrite !== -1) {
        fs.mkdirSync(folderPath, { recursive: true });
        // 'wx' - Like 'w' but fails if path exists.
        fs.writeFileSync(fileToWritePath, new Uint8Array(compressedObject), {
          flag: "wx",
        });
        process.stdout.write(hash);
      } else {
        // Some terminals (especially `zsh` and custom shell configurations) may display a % when no newline (\n) is present at the end of the output.
        process.stdout.write(hash);
      }
    } else {
      throw new Error("No target file provided!");
    }
    break;
  default:
    throw new Error(`Unknown command ${command}`);
}
