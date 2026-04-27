# structon

Random-access struct encoding/decoding as an extensible class for [msgpackr](https://github.com/kriszyp/msgpackr), [cbor-x](https://github.com/kriszyp/cbor-x), and compatible binary encoders.

## Overview

`structon` extracts the random-access struct functionality from msgpackr's `struct.js` into a standalone, class-based package.  It exposes a `createStructon(BaseClass)` factory that returns a class extending any compatible encoder.  The resulting class encodes top-level plain objects as compact fixed-width structs with lazy-access property getters, while delegating inner nested-object encoding to the underlying base encoder (msgpackr or cbor-x).

**Binary format compatibility**: the byte layout produced by `structon` is identical to msgpackr's `struct.js` format.  Data written by either implementation can be read by the other.

### Key features

- **Zero-copy lazy access** — property getters read directly from the raw buffer; no full deserialization needed to access a single field.
- **Extensible base class** — extend msgpackr's `Packr`/`Encoder` or cbor-x's `Encoder` (or any compatible encoder).
- **Structure caching** — structure definitions are incrementally learned and can be persisted via `saveStructures`/`getStructures` callbacks.
- **Nested struct support** — nested plain objects are encoded by the base encoder; nested structs within a struct field are handled recursively.
- **Binary compatible** with msgpackr's `struct.js` random-access format.

## Installation

```bash
npm install structon
# peer dependency for msgpackr usage:
npm install msgpackr
# or for cbor-x:
npm install cbor-x
```

## Usage

### With msgpackr

```js
import { Packr } from 'msgpackr';
import { createStructon } from 'structon';

const Structon = createStructon(Packr);

// Persist structures so they survive process restarts
let savedStructures = null;
const enc = new Structon({
    structures: [],
    saveStructures(s) { savedStructures = s; },
    getStructures()   { return savedStructures; },
});

const buf = enc.encode({ name: 'Alice', age: 30, score: 99.5 });
const obj = enc.decode(buf);

console.log(obj.name);  // 'Alice'  — reads from buffer without full decode
console.log(obj.age);   // 30
console.log(obj.toJSON());  // { name: 'Alice', age: 30, score: 99.5 }
```

### With cbor-x

```js
import { Encoder } from 'cbor-x';
import { createStructon } from 'structon';

const Structon = createStructon(Encoder);
const enc = new Structon({ structures: [] });

const buf = enc.encode({ id: 1, label: 'widget' });
const obj = enc.decode(buf);
console.log(obj.id);     // 1
console.log(obj.label);  // 'widget'
```

### Non-struct values pass through

Values that are not plain objects (arrays, strings, numbers, Maps, etc.) are encoded and decoded by the base class transparently.

```js
enc.encode([1, 2, 3]);          // regular msgpack/cbor array
enc.encode('hello');             // regular msgpack/cbor string
enc.encode(new Map([['a', 1]])); // regular msgpack/cbor map
```

## API

### `createStructon(BaseClass)`

Returns a `Structon` class that extends `BaseClass`.

**Parameters**
- `BaseClass` — `Packr` from msgpackr, `Encoder` from cbor-x, or any compatible encoder class.

**Returns** a class with the following additions over `BaseClass`:

| Member | Description |
|--------|-------------|
| `encode(value)` | Encodes plain objects as structs; other values via base class. |
| `decode(buffer)` | Decodes struct buffers into lazy objects; other buffers via base class. |
| `typedStructs` | Array of learned structure definitions (auto-populated). |
| `_decodeSliceDirect(src, start, end)` | Low-level slice decoder used by struct getters. |

### Constructor options

All options from the base class are forwarded.  Additional behaviour:

| Option | Description |
|--------|-------------|
| `structures` | Shared structure definitions array (passed to base class). |
| `saveStructures(s)` | Called when new struct definitions are learned (msgpackr API). |
| `getStructures()` | Called to load previously saved structures (msgpackr API). |
| `saveShared(s)` | cbor-x equivalent of `saveStructures`. |
| `getShared()` | cbor-x equivalent of `getStructures`. |

## Binary format

The format is identical to msgpackr's `struct.js`:

```
[header (1-4 bytes)][fixed-width field section][variable ref section]
```

- **Header**: record ID encoded as `0x20 + id` (single byte for ids 0-15), or `0x38/0x39/0x3a` with 1/2/3 extra bytes for larger IDs.
- **Fixed section**: one fixed-width slot per field — numbers as `uint8`/`uint32`/`float64`, strings as 0/1/2-byte ref offsets, objects as 2/4-byte ref offsets, dates as `float64`.
- **Ref section**: UTF-8 string bytes followed by msgpack/cbor-encoded object bytes.

Field access resolves directly from the buffer — only the bytes for the accessed field are read.

## Interoperability with msgpackr

`structon` is bidirectionally byte-compatible with msgpackr's `randomAccessStructure: true` mode (msgpackr ≤ 1.11.10, before its `struct.js` was removed).  The test suite verifies all four directions:

- Structon writes → native `Packr` reads
- native `Packr` writes → Structon reads
- byte-identical output for a given plain object
- mixed types + nested objects round-trip when `structures` and `typedStructs` are shared

These compatibility tests pin msgpackr `1.11.10` as a dev dependency.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
