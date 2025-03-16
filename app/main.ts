import * as fs from "fs";
import * as zlib from "zlib";
import * as path from 'path';

const args = process.argv.slice(2);
let command = args.at(0);

if (command && command === "cat-file") {
  command = args.slice(0, -1).join(" ");
}

const Commands = {
  Init: "init",
  CatFile: "cat-file -p",
} as const;

const Paths = {
  dotGit: ".git",
  objects: ".git/objects",
  refs: ".git/refs"
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
      const blobPath = path.resolve(Paths.objects, `${hash?.at(0)}${hash?.at(1)}/${hash?.slice(2)}`);
      const compressedBlob = fs.readFileSync(blobPath);
      // Convert Buffer to Uint8Array explicitly to satisfy TypeScript
      const decompressedBlob = zlib.unzipSync(new Uint8Array(compressedBlob)).toString();
      // https://en.wikipedia.org/wiki/Null_character
      const content = decompressedBlob.slice(decompressedBlob.indexOf('\0') + 1);
      process.stdout.write(content);
    break;
  default:
    throw new Error(`Unknown command ${command}`);
}
