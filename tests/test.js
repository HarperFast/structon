import { suite, test } from 'mocha';
import assert from 'assert';
import { Packr } from 'msgpackr'; // v2 — no randomAccessStructure
import { Packr as LegacyPackr } from 'msgpackr-legacy'; // v1.11 — has randomAccessStructure
import { createStructon } from '../index.js';

const Structon = createStructon(Packr); // structon wrapping msgpackr v2

// ── helpers ──────────────────────────────────────────────────────────────────

function roundtrip(enc, value) {
	return enc.decode(enc.encode(value));
}

// Materialize a lazy struct into a plain object for deep-equality checks
function materialize(obj) {
	if (obj && typeof obj.toJSON === 'function') return obj.toJSON();
	return obj;
}

// ── basic types ───────────────────────────────────────────────────────────────

suite('structon – basic types', function () {
	const enc = new Structon({ structures: [] });

	test('small integer field', function () {
		const result = roundtrip(enc, { x: 5 });
		assert.strictEqual(result.x, 5);
	});

	test('larger integer field (num32)', function () {
		const result = roundtrip(enc, { count: 100000 });
		assert.strictEqual(result.count, 100000);
	});

	test('negative integer', function () {
		const result = roundtrip(enc, { delta: -42 });
		assert.strictEqual(result.delta, -42);
	});

	test('float64 field', function () {
		const result = roundtrip(enc, { ratio: 3.141592653589793 });
		assert.strictEqual(result.ratio, 3.141592653589793);
	});

	test('float32-representable number', function () {
		const result = roundtrip(enc, { value: 1.5 });
		assert.strictEqual(result.value, 1.5);
	});

	test('ASCII string field (ascii0 optimisation)', function () {
		const result = roundtrip(enc, { name: 'Alice' });
		assert.strictEqual(result.name, 'Alice');
	});

	test('second ASCII string (ascii8)', function () {
		const result = roundtrip(enc, { first: 'Alice', last: 'Smith' });
		assert.strictEqual(result.first, 'Alice');
		assert.strictEqual(result.last, 'Smith');
	});

	test('UTF-8 string field', function () {
		const result = roundtrip(enc, { greeting: 'héllo wörld' });
		assert.strictEqual(result.greeting, 'héllo wörld');
	});

	test('boolean true/false', function () {
		const result = roundtrip(enc, { active: true });
		assert.strictEqual(result.active, true);
		const result2 = roundtrip(enc, { active: false });
		assert.strictEqual(result2.active, false);
	});

	test('null field', function () {
		const enc2 = new Structon({ structures: [] });
		// First encode with a number so the transition for the field is established
		roundtrip(enc2, { val: 1 });
		const result = roundtrip(enc2, { val: null });
		assert.strictEqual(result.val, null);
	});

	test('date field', function () {
		const d = new Date('2024-01-15T12:00:00.000Z');
		const result = roundtrip(enc, { ts: d });
		assert.ok(result.ts instanceof Date);
		assert.strictEqual(result.ts.getTime(), d.getTime());
	});
});

// ── multiple fields ───────────────────────────────────────────────────────────

suite('structon – multiple fields', function () {
	const enc = new Structon({ structures: [] });

	test('mixed number and string fields', function () {
		const obj = { name: 'Bob', age: 25, score: 99.5 };
		const result = roundtrip(enc, obj);
		assert.strictEqual(result.name, 'Bob');
		assert.strictEqual(result.age, 25);
		assert.strictEqual(result.score, 99.5);
	});

	test('toJSON produces correct values', function () {
		const obj = { id: 1, label: 'test', active: true };
		const encoded = enc.encode(obj);
		const result = enc.decode(encoded);
		const plain = materialize(result);
		assert.strictEqual(plain.id, 1);
		assert.strictEqual(plain.label, 'test');
		assert.strictEqual(plain.active, true);
	});

	test('nested object field', function () {
		const obj = { id: 7, meta: { kind: 'widget', count: 3 } };
		const result = roundtrip(enc, obj);
		assert.strictEqual(result.id, 7);
		const meta = result.meta;
		// nested is encoded by base Packr, comes back as plain object
		assert.strictEqual(meta.kind, 'widget');
		assert.strictEqual(meta.count, 3);
	});
});

// ── struct is random-access (lazy) ────────────────────────────────────────────

suite('structon – random access', function () {
	const enc = new Structon({ structures: [] });

	test('encoded bytes start with struct header byte (0x20-0x3f)', function () {
		const buf = enc.encode({ x: 1 });
		assert.ok(buf[0] >= 0x20 && buf[0] < 0x40, `expected struct header, got 0x${buf[0].toString(16)}`);
	});

	test('individual properties are lazily accessible without full decode', function () {
		const obj = { name: 'lazy', count: 42, flag: true };
		const buf = enc.encode(obj);
		const result = enc.decode(buf);
		// Accessing just one property should work
		assert.strictEqual(result.count, 42);
	});

	test('same structure encoded twice reuses record id', function () {
		const enc2 = new Structon({ structures: [] });
		const buf1 = enc2.encode({ a: 1, b: 'x' });
		const buf2 = enc2.encode({ a: 2, b: 'y' });
		// Both should use the same record id (same first header byte)
		assert.strictEqual(buf1[0], buf2[0]);
	});

	test('different structures get different record ids', function () {
		const enc2 = new Structon({ structures: [] });
		const buf1 = enc2.encode({ x: 1 });
		const buf2 = enc2.encode({ y: 2 });
		assert.notStrictEqual(buf1[0], buf2[0]);
	});
});

// ── non-struct values fall through to base Packr ─────────────────────────────

suite('structon – non-struct pass-through', function () {
	const enc = new Structon({ structures: [] });

	test('arrays are encoded/decoded by base Packr', function () {
		const arr = [1, 2, 3];
		const buf = enc.encode(arr);
		const result = enc.decode(buf);
		assert.deepStrictEqual(result, arr);
	});

	test('strings are encoded/decoded by base Packr', function () {
		const buf = enc.encode('hello');
		assert.strictEqual(enc.decode(buf), 'hello');
	});

	test('numbers are encoded/decoded by base Packr', function () {
		const buf = enc.encode(42);
		assert.strictEqual(enc.decode(buf), 42);
	});

	test('null is encoded/decoded by base Packr', function () {
		const buf = enc.encode(null);
		assert.strictEqual(enc.decode(buf), null);
	});

	test('Map is encoded/decoded by base Packr', function () {
		const enc2 = new Structon({ structures: [], mapsAsObjects: false });
		const m = new Map([['a', 1]]);
		const result = enc2.decode(enc2.encode(m));
		assert.strictEqual(result.get('a'), 1);
	});
});

// ── structure persistence ─────────────────────────────────────────────────────

suite('structon – structure persistence', function () {
	test('structures are saved and reloaded via saveStructures / getStructures', function () {
		let savedStructures = null;

		const enc1 = new Structon({
			structures: [],
			saveStructures(s) { savedStructures = s; },
		});

		// Encode to establish a structure
		enc1.encode({ name: 'Alice', age: 30 });
		assert.ok(savedStructures !== null, 'saveStructures should have been called');

		// Create a fresh decoder that loads the saved structures
		const enc2 = new Structon({
			structures: [],
			getStructures() { return savedStructures; },
		});

		// Encode with enc1 (uses known structure), decode with enc2 (loads it)
		const buf = enc1.encode({ name: 'Bob', age: 25 });
		const result = enc2.decode(buf);
		assert.strictEqual(result.name, 'Bob');
		assert.strictEqual(result.age, 25);
	});
});

// ── binary compatibility with msgpackr's randomAccessStructure ──────────────
//
// These tests pin a legacy msgpackr (with struct.js) and verify that bytes
// flow correctly in BOTH directions:
//   1. Structon writes  →  native msgpackr reads
//   2. native msgpackr writes  →  Structon reads
//
// msgpackr's struct.js is imported via a relative path because msgpackr's
// package "exports" map does not expose ./struct.js publicly; the side-effect
// import registers the read/write hooks on Packr's setWriteStructSlots /
// setReadStruct globals.

// ── structon with msgpackr v2 ─────────────────────────────────────────────────

suite('structon – with msgpackr v2', function () {
	// The top-level Structon already wraps v2 Packr, but this suite makes it explicit.
	test('basic roundtrip using msgpackr v2 as the base encoder', function () {
		const enc = new Structon({ structures: [] });
		const result = roundtrip(enc, { name: 'v2 user', age: 42, active: true });
		assert.strictEqual(result.name, 'v2 user');
		assert.strictEqual(result.age, 42);
		assert.strictEqual(result.active, true);
	});

	test('struct bytes are still produced (not plain msgpack records)', function () {
		const enc = new Structon({ structures: [] });
		const buf = enc.encode({ x: 1, y: 2 });
		assert.ok(buf[0] >= 0x20 && buf[0] < 0x40, 'expected struct header byte');
	});

	test('msgpackr v2 Packr alone does not produce struct bytes', function () {
		const plain = new Packr({ structures: [] });
		const buf = plain.pack({ x: 1, y: 2 });
		// v2 encodes as a msgpack record (0x40+) or map, not a struct
		assert.ok(buf[0] < 0x20 || buf[0] >= 0x40, 'v2 alone should not produce struct header bytes');
	});
});

// ── binary compatibility with msgpackr v1.11 randomAccessStructure ────────────
//
// These tests verify that bytes flow correctly in both directions between
// structon and msgpackr v1.11's native randomAccessStructure implementation:
//   1. Structon writes  →  msgpackr v1.11 reads
//   2. msgpackr v1.11 writes  →  Structon reads
//
// struct.js is imported via the direct node_modules path because msgpackr's
// exports map does not expose it publicly; the side-effect import registers
// the read/write hooks on the legacy Packr's globals.

await import('../node_modules/msgpackr-legacy/struct.js');

suite('structon – msgpackr v1.11 randomAccessStructure round-trip', function () {
	test('Structon → msgpackr v1.11: bytes produced by Structon are decoded by legacy Packr', function () {
		const sEnc = new Structon({ structures: [] });
		const buf = sEnc.encode({ name: 'compat', value: 42 });

		const nativePackr = new LegacyPackr({
			structures: [],
			randomAccessStructure: true,
		});
		nativePackr.typedStructs = sEnc.typedStructs;

		const result = nativePackr.unpack(buf);
		assert.strictEqual(result.name, 'compat');
		assert.strictEqual(result.value, 42);
	});

	test('msgpackr v1.11 → Structon: bytes produced by legacy Packr are decoded by Structon', function () {
		const nativePackr = new LegacyPackr({
			structures: [],
			randomAccessStructure: true,
		});
		const buf = nativePackr.encode({ id: 7, label: 'native', amount: 1.5 });

		const sEnc = new Structon({ structures: [] });
		sEnc.typedStructs = nativePackr.typedStructs;

		const result = sEnc.decode(buf);
		assert.strictEqual(result.id, 7);
		assert.strictEqual(result.label, 'native');
		assert.strictEqual(result.amount, 1.5);
	});

	test('round-trip with mixed types and a nested object', function () {
		const sharedStructures = [];
		const nativePackr = new LegacyPackr({
			structures: sharedStructures,
			randomAccessStructure: true,
		});

		const value = {
			id: 100,
			name: 'mixed',
			active: true,
			ts: new Date('2024-06-15T10:00:00.000Z'),
			meta: { kind: 'sample', priority: 5 },
		};

		const buf = nativePackr.encode(value);

		// Pass the same structures array so the inner msgpack record id used for
		// the nested object can be resolved.
		const sEnc = new Structon({ structures: nativePackr.structures });
		sEnc.typedStructs = nativePackr.typedStructs;

		const result = sEnc.decode(buf);
		assert.strictEqual(result.id, 100);
		assert.strictEqual(result.name, 'mixed');
		assert.strictEqual(result.active, true);
		assert.ok(result.ts instanceof Date);
		assert.strictEqual(result.ts.getTime(), value.ts.getTime());
		assert.strictEqual(result.meta.kind, 'sample');
		assert.strictEqual(result.meta.priority, 5);
	});

	test('Structon and msgpackr v1.11 produce byte-identical output for the same input', function () {
		const value = { x: 5, label: 'hello', flag: true };

		const sEnc = new Structon({ structures: [] });
		const sBuf = sEnc.encode(value);

		const nativePackr = new LegacyPackr({
			structures: [],
			randomAccessStructure: true,
		});
		const nBuf = nativePackr.encode(value);

		assert.deepStrictEqual(
			Array.from(sBuf),
			Array.from(nBuf),
			'Structon and msgpackr v1.11 should emit identical byte sequences'
		);
	});
});

// ── multiple encodings of the same structure ──────────────────────────────────

suite('structon – repeated encodings', function () {
	const enc = new Structon({ structures: [] });

	test('10 objects with the same shape round-trip correctly', function () {
		for (let i = 0; i < 10; i++) {
			const obj = { id: i, name: `user${i}`, score: i * 1.5 };
			const result = roundtrip(enc, obj);
			assert.strictEqual(result.id, i);
			assert.strictEqual(result.name, `user${i}`);
			assert.strictEqual(result.score, i * 1.5);
		}
	});

	test('two different structures coexist', function () {
		const enc2 = new Structon({ structures: [] });
		const typeA = { kind: 'A', x: 1 };
		const typeB = { kind: 'B', y: 2, z: 3 };

		const ra = roundtrip(enc2, typeA);
		const rb = roundtrip(enc2, typeB);
		assert.strictEqual(ra.kind, 'A');
		assert.strictEqual(ra.x, 1);
		assert.strictEqual(rb.kind, 'B');
		assert.strictEqual(rb.y, 2);
		assert.strictEqual(rb.z, 3);
	});
});
