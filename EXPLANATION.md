# Git Clone Implementation — Detailed Explanation

This document explains every piece of the `clone` command implementation in `app/main.ts`, starting from first principles and walking through every layer of the Git Smart HTTP protocol, packfile format, delta resolution, and working tree checkout.

---

## Table of Contents

1. [Overview](#overview)
2. [The Git Object Model](#the-git-object-model)
3. [Git Smart HTTP Protocol](#git-smart-http-protocol)
4. [Step 1 — Ref Discovery (`info/refs`)](#step-1--ref-discovery-inforefs)
5. [Step 2 — Upload-Pack Request (want/done)](#step-2--upload-pack-request-wantdone)
6. [Step 3 — Side-Band Demultiplexing](#step-3--side-band-demultiplexing)
7. [Step 4 — Packfile Parsing](#step-4--packfile-parsing)
8. [Step 5 — Delta Resolution](#step-5--delta-resolution)
9. [Step 6 — `inflateFromPos`: Finding Zlib Stream Boundaries](#step-6--inflatefrompos-finding-zlib-stream-boundaries)
10. [Step 7 — Writing the Repository Structure](#step-7--writing-the-repository-structure)
11. [Step 8 — Checking Out the Working Tree](#step-8--checking-out-the-working-tree)
12. [Supporting Infrastructure](#supporting-infrastructure)
13. [All Prior Commands (init through commit-tree)](#all-prior-commands-init-through-commit-tree)

---

## Overview

`git clone` is, conceptually, three things:

1. **Ask the server what it has** — discover all commits, branches, and tags.
2. **Download all the objects** — receive a compressed binary packfile containing every git object.
3. **Reconstruct a local repository** — write objects to `.git/objects`, set up refs, and copy files into the working directory.

The entire implementation lives in a single TypeScript file using only Node.js builtins: `fs`, `zlib`, `path`, `crypto`, `http`, and `https` — no third-party libraries.

---

## The Git Object Model

Before understanding the network protocol, it helps to understand what git actually stores.

Git stores four types of objects, each identified by the SHA-1 hash of its content:

| Type   | Description |
|--------|-------------|
| `blob` | Raw file content |
| `tree` | A directory listing: entries of the form `mode name\0<20-byte-hash>` |
| `commit` | Metadata (author, committer, message) + pointer to a `tree` and zero or more parent `commit` hashes |
| `tag`  | An annotated tag pointing to another object |

Every object is stored on disk as:

```
zlib_deflate( "<type> <size>\0<raw_content>" )
```

The SHA-1 hash is computed over the uncompressed bytes (header + content). That hash is the object's identity. The first two hex characters form the subdirectory name under `.git/objects/`, and the remaining 38 form the filename:

```
.git/objects/47/b37f1a82bfe85f6d8df52b6258b75e4343b7fd
```

---

## Git Smart HTTP Protocol

Git has two HTTP transport modes: "dumb" (just file serving) and "smart" (stateful RPC). We use **Smart HTTP**, which involves exactly two HTTP calls:

1. `GET  /info/refs?service=git-upload-pack`  → discover what the server has
2. `POST /git-upload-pack`                     → negotiate and receive a packfile

Both request/response bodies use a framing format called **pkt-line**.

### pkt-line Format

Every logical message is prefixed with a 4-digit hex length (including the 4 length bytes themselves):

```
0032want 47b37f1a82bfe85f6d8df52b6258b75e4343b7fd\n
```

Here `0032` = 50 decimal = 4 (length prefix) + 46 (content). The special value `0000` is a **flush packet**, used as a delimiter.

```typescript
function parsePktLines(buf: Buffer): string[] { ... }
function pktLine(data: string): Buffer { ... }
const PKT_FLUSH = Buffer.from("0000");
```

`parsePktLines` reads each 4-byte length, extracts the payload, and skips flush packets, building an array of decoded strings.

`pktLine` encodes a string: computes `len = data.length + 4`, pads to 4 hex digits, prepends it.

---

## Step 1 — Ref Discovery (`info/refs`)

```
GET https://github.com/<owner>/<repo>/info/refs?service=git-upload-pack
```

The server responds with a pkt-line stream:

```
001e# service=git-upload-pack\n
0000
<first-ref-line-with-capabilities>
<more-ref-lines>
0000
```

The **first ref line** is special: after the `<hash> <refname>` pair it contains a NUL byte followed by a space-separated list of server capability strings, for example:

```
47b37f...  HEAD\0multi_ack side-band-64k ofs-delta symref=HEAD:refs/heads/master
```

### What we extract

```typescript
const symrefMatch = caps.match(/symref=HEAD:([^\s]+)/);
```

The `symref=HEAD:refs/heads/master` capability tells us the name of the default branch. We parse this to know what to write in the local `HEAD` file later. Falling back to `"master"` if absent.

All remaining lines are plain `<hash> <refname>` pairs. We collect everything into:

- `allRefs: Map<string, string>` — refname → hash, for writing local refs later
- `wants: string[]` — all hashes we want to download
- `headHash: string | null` — the hash pointed to by `HEAD`

---

## Step 2 — Upload-Pack Request (want/done)

```
POST https://github.com/<owner>/<repo>/git-upload-pack
Content-Type: application/x-git-upload-pack-request
```

The request body is a pkt-line stream:

```
<pkt-line> want <hash> multi_ack_detailed side-band-64k ofs-delta\n
<pkt-line> want <hash2>\n
...
0000
0009done\n
```

The **first `want` line** appends the capabilities we want to use:

- `side-band-64k` — the server multiplexes the response into bands (packfile data, progress messages, errors). Without this, we'd get raw packfile bytes, which makes error reporting impossible.
- `ofs-delta` — we accept OFS_DELTA objects (offset-based deltas), which are more compact than REF_DELTA (hash-based deltas).
- `multi_ack_detailed` — needed for proper protocol negotiation (though we immediately send `done` since we have no local objects to compare against, i.e. this is a fresh clone).

The `done` line tells the server we have no local objects and it should send everything.

```typescript
wantLines.push(Buffer.from("0009done\n")); // 4 + 5 = 9
```

Note: `"done\n"` is 5 bytes, plus 4 for the length prefix = 9, hence `0009`.

---

## Step 3 — Side-Band Demultiplexing

The server's response is a pkt-line stream where each packet's payload starts with a **1-byte band number**:

| Band | Meaning |
|------|---------|
| `1`  | Packfile data |
| `2`  | Progress messages (human-readable, printed to stderr by real git) |
| `3`  | Fatal error message |

```typescript
const band = pktData[0];
if (band === 1) {
  packChunks.push(pktData.subarray(1));
}
```

We accumulate all band-1 bytes and concatenate them into the full packfile. Before the packfile begins, the server also sends `NAK\n` (since we sent no `have` lines), which appears as a band-2 or free-standing pkt-line. We skip it by searching for the `PACK` magic bytes:

```typescript
for (let i = 0; i <= packData.length - 4; i++) {
  if (packData.subarray(i, i + 4).toString("ascii") === "PACK") {
    packStart = i;
    break;
  }
}
```

---

## Step 4 — Packfile Parsing

A packfile is a binary format containing many git objects packed together with optional delta compression.

### Packfile Header

```
Bytes 0-3:  "PACK" (magic)
Bytes 4-7:  version number (big-endian uint32, always 2)
Bytes 8-11: number of objects (big-endian uint32)
```

We validate the magic and read the object count:

```typescript
if (pack.subarray(0, 4).toString("ascii") !== "PACK") throw new Error(...);
const numObjects = pack.readUInt32BE(8);
let pos = 12;
```

### Per-Object Header

Each object starts with a variable-length integer encoding both the **type** and the **uncompressed size**:

```
First byte:
  bit 7    = MSB continuation (1 = more bytes follow)
  bits 6-4 = object type (3 bits)
  bits 3-0 = size bits 0-3

Subsequent bytes (if MSB was set):
  bit 7    = MSB continuation
  bits 6-0 = next 7 size bits
```

The six object types are:

```typescript
const OBJ_COMMIT    = 1;
const OBJ_TREE      = 2;
const OBJ_BLOB      = 3;
const OBJ_TAG       = 4;
const OBJ_OFS_DELTA = 6; // delta relative to another object in this packfile
const OBJ_REF_DELTA = 7; // delta relative to an object identified by its hash
```

Parsing the header:

```typescript
let byte = pack[pos++];
const type = (byte >> 4) & 0x7;   // bits 6-4
let size = byte & 0x0f;            // bits 3-0
let shift = 4;
while (byte & 0x80) {
  byte = pack[pos++];
  size |= (byte & 0x7f) << shift;
  shift += 7;
}
```

After the header comes the compressed object data (or delta-specific fields for OFS/REF deltas).

### OFS_DELTA Objects

These reference a base object located at an earlier offset in the same packfile. After the type/size header, there is a specially encoded negative offset:

```typescript
function readOffsetEncoding(buf: Buffer, pos: number): { value: number; newPos: number } {
  let byte = buf[pos++];
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[pos++];
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { value, newPos: pos };
}
```

This is a big-endian "sneaky" encoding (documented in the referenced Medium article). The `+1` on continuation bytes avoids encoding ambiguity. The actual base object starts at `currentOffset - value`.

### REF_DELTA Objects

These reference a base object by its full 20-byte binary SHA-1 hash, which appears directly after the type/size header:

```typescript
const baseHash = pack.subarray(pos, pos + 20).toString("hex");
pos += 20;
```

Then the delta data follows as a zlib-compressed stream.

### Collecting Raw Objects

In the first pass over the packfile, we collect all objects into `rawObjects[]`, tagging delta objects with their `baseOffset` or `baseHash`. We also build `offsetToIndex` — a map from packfile byte offset to array index — so we can look up OFS_DELTA bases efficiently.

---

## Step 5 — Delta Resolution

Git deltas are a binary diff format. A delta stream contains:
1. Source size (varint, little-endian MSB)
2. Target size (varint, little-endian MSB)
3. A sequence of **instructions**

There are two instruction types, distinguished by the high bit of the opcode byte:

#### Copy instruction (bit 7 = 1)

The lower 7 bits are a bitmask indicating which of 4 offset bytes and 3+1 size bytes to read. Copies `size` bytes from `base[offset]` into the result.

```typescript
if (opcode & 0x80) {
  let copyOffset = 0, copySize = 0;
  if (opcode & 0x01) copyOffset |= delta[pos++];
  if (opcode & 0x02) copyOffset |= delta[pos++] << 8;
  if (opcode & 0x04) copyOffset |= delta[pos++] << 16;
  if (opcode & 0x08) copyOffset |= delta[pos++] << 24;
  if (opcode & 0x10) copySize  |= delta[pos++];
  if (opcode & 0x20) copySize  |= delta[pos++] << 8;
  if (opcode & 0x40) copySize  |= delta[pos++] << 16;
  if (copySize === 0) copySize = 0x10000;
  base.copy(result, resultPos, copyOffset, copyOffset + copySize);
  resultPos += copySize;
}
```

If the size field encodes zero, it means 65536 (`0x10000`) bytes — a special case in the spec.

#### Insert instruction (bit 7 = 0)

The opcode itself is the number of literal bytes to copy from the delta stream directly into the result:

```typescript
} else if (opcode > 0) {
  delta.copy(result, resultPos, pos, pos + opcode);
  resultPos += opcode;
  pos += opcode;
}
```

### Multi-Pass Resolution

Deltas can be chained: a delta can be based on another delta's result. We handle this with a fixed-point loop:

```typescript
let changed = true;
while (changed && maxPasses-- > 0) {
  changed = false;
  for (const obj of rawObjects) {
    if (obj.type === OBJ_OFS_DELTA) {
      // look up base, apply delta, write resolved object
      // mutate obj.type and obj.data in place to mark as resolved
      changed = true;
    }
  }
}
```

Each pass resolves all deltas whose base is already resolved. We repeat until no progress is made (or a safety limit of 100 passes is hit). OFS_DELTA objects are resolved first (their bases are always earlier in the same packfile), then REF_DELTA objects (whose bases may be anywhere, including the just-resolved batch).

---

## Step 6 — `inflateFromPos`: Finding Zlib Stream Boundaries

This was the trickiest part. The packfile stores all objects back-to-back as zlib streams. There is no length prefix for the compressed data — we must determine where each stream ends by parsing it.

Node's `zlib.inflateSync` does not expose "how many bytes were consumed". However, it has a useful property: it **throws** if given a truncated stream but **succeeds** (ignoring trailing bytes) if given a complete stream with extra data appended.

We exploit this with a two-phase approach:

### Phase 1: Exponential probe

Start with `probe = 32` bytes. If that fails (throws), double it. If it succeeds, we know the stream ends somewhere in `[2, probe]`.

```typescript
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
```

### Phase 2: Binary search

Once we have an upper bound `hi` where inflate succeeds, binary-search for the **minimum** length that still succeeds:

```typescript
lo = 2;
while (lo < hi) {
  const mid = (lo + hi) >> 1;
  try {
    zlib.inflateSync(buf.subarray(pos, pos + mid));
    hi = mid;  // mid works, try smaller
  } catch {
    lo = mid + 1;  // mid fails, try larger
  }
}
```

Because `inflateSync` throws on truncation and succeeds on complete+trailing, the minimum `L` where it succeeds equals the exact stream length. This was verified empirically: compressing `"hello world"` produces a 47-byte stream; adding 4 trailing bytes still succeeds, and the binary search finds exactly 47.

This approach is `O(log(streamLength))` inflate calls, not `O(streamLength)`.

---

## Step 7 — Writing the Repository Structure

After parsing the packfile, we set up the `.git` directory:

```
destDir/
  .git/
    HEAD          ← "ref: refs/heads/<defaultBranch>\n"
    objects/      ← all parsed git objects
    refs/
      heads/
        master    ← "<headHash>\n"
      tags/
```

The `HEAD` file is written with the branch name parsed from the `symref=HEAD:refs/heads/<name>` capability, so it's always correct regardless of whether the default branch is `main`, `master`, or anything else.

All refs received from the server are written to their canonical paths:

```typescript
for (const [refName, refHash] of allRefs) {
  if (refName === "HEAD") continue; // HEAD is a symref, not a regular ref
  if (refName.startsWith("refs/heads/") || refName.startsWith("refs/tags/")) {
    const refPath = path.join(gitDir, refName);
    fs.mkdirSync(path.dirname(refPath), { recursive: true });
    fs.writeFileSync(refPath, refHash + "\n");
  }
}
```

Each git object is written by `writeResolved`:

```typescript
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
```

The `flag: "wx"` means "create, fail if exists" — safe for concurrent writes and idempotent.

---

## Step 8 — Checking Out the Working Tree

Once all objects exist on disk, we reconstruct the working directory. We start from the head commit:

1. Read the commit object → parse `tree <hash>` from its content
2. Call `checkoutTree(treeHash, destDir, objectsDir)` recursively

### Tree Parsing

A tree object's content is a sequence of entries, each:

```
<mode> <name>\0<20-byte-binary-sha1>
```

Note: the SHA is stored as **raw binary**, not hex — 20 bytes, not 40.

```typescript
const nullByte = decompressed.indexOf(0, pos);
const entry = decompressed.subarray(pos, nullByte).toString(); // "100644 README.md"
const spaceIdx = entry.indexOf(" ");
const mode = entry.substring(0, spaceIdx);   // "100644"
const name = entry.substring(spaceIdx + 1);  // "README.md"
const hash = decompressed.subarray(nullByte + 1, nullByte + 21).toString("hex");
pos = nullByte + 21;
```

### Mode Handling

| Mode    | Meaning |
|---------|---------|
| `40000` or `040000` | Directory (tree) |
| `100644` | Regular file |
| `100755` | Executable file |
| `120000` | Symbolic link (blob content = link target) |

For directories, we recurse. For files, we read the blob object, strip its header (`blob <size>\0`), and write the raw content. Executable files get `chmod 755`.

---

## Supporting Infrastructure

### HTTP Helpers

`httpGet` and `httpPost` are Promise wrappers around Node's `http`/`https` modules, chosen based on the URL scheme. The POST includes the required `Content-Type` and `Content-Length` headers.

### `readVarInt`

Used internally for reading variable-length integers in the delta format (little-endian with MSB continuation — the same encoding as protobuf varints):

```typescript
function readVarInt(buf: Buffer, pos: number): { value: number; newPos: number } {
  let value = 0, shift = 0;
  do {
    const byte = buf[pos++];
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { value, newPos: pos };
}
```

### `readOffsetEncoding`

Used specifically for OFS_DELTA base-offset decoding. It uses the "sneaky encoding" where continuation bytes add an implicit `+1` to remove ambiguity:

```typescript
value = ((value + 1) << 7) | (byte & 0x7f);
```

This ensures there's only one way to represent each integer (unlike standard varints, which can have leading zero bytes).

---

## All Prior Commands (init through commit-tree)

The clone functionality builds on all earlier commands. Here's a condensed overview:

### `init`
Creates the `.git` directory structure: `objects/`, `refs/`, and the initial `HEAD` file pointing to `refs/heads/main`.

### `cat-file -p <hash>`
Reads a compressed object from `.git/objects/<xx>/<38>`, decompresses it with `zlib.inflateSync`, strips the header (`<type> <size>\0`), and writes the content to stdout.

### `hash-object [-w] <file>`
Reads a file, builds the blob header (`blob <size>\0`), concatenates header + content, computes SHA-1, and optionally writes the compressed object to `.git/objects`.

### `ls-tree [--name-only] <hash>`
Reads a tree object and parses its binary entry format, looking up each entry's type from `.git/objects` to print the full `<mode> <type> <hash> <name>` listing.

### `write-tree`
Recursively hashes every file in the current directory (creating blob objects), builds tree objects bottom-up, and returns the root tree hash. Files are sorted and the `.git` directory is excluded.

### `commit-tree <tree> -p <parent> -m <message>`
Constructs a commit object with the tree hash, parent hash, author/committer metadata, and message. Writes it to `.git/objects` and prints the hash.

---

## End-to-End Flow Summary

```
clone https://github.com/owner/repo ./dest
         │
         ▼
1. GET /info/refs?service=git-upload-pack
   → parse pkt-lines → extract HEAD hash, default branch (symref), all refs
         │
         ▼
2. POST /git-upload-pack
   body: want <hash> side-band-64k ofs-delta\n ... flush done\n
   → receive side-band-64k multiplexed response
         │
         ▼
3. Demux sideband → concatenate band-1 chunks → locate "PACK" magic
         │
         ▼
4. Parse packfile header (numObjects)
   For each object:
     - read type+size varint
     - if OFS_DELTA: read negative offset
     - if REF_DELTA: read 20-byte base hash
     - inflateFromPos() → binary search for exact zlib stream length
         │
         ▼
5. Write all non-delta objects to .git/objects
   Multi-pass resolve OFS_DELTA → REF_DELTA chains using applyDelta()
         │
         ▼
6. mkdir destDir/.git/{objects,refs/heads,refs/tags}
   write HEAD → "ref: refs/heads/<defaultBranch>"
   write all refs/heads/* and refs/tags/*
         │
         ▼
7. Read HEAD commit → extract tree hash
   checkoutTree() recursively:
     parse tree entries → recurse into subtrees, write blob files
```