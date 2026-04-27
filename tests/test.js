import { suite, test } from 'mocha';
import assert from 'assert';
import { Packr } from 'msgpackr';
import { createStructon } from '../index.js';

const Structon = createStructon(Packr);

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

// ── binary compatibility with msgpackr struct.js ──────────────────────────────

suite('structon – msgpackr binary compatibility', function () {
	test('bytes produced by Structon are decodable by msgpackr with randomAccessStructure', async function () {
		// Dynamically import msgpackr's struct.js to register its global hooks,
		// then use a raw Packr with randomAccessStructure to decode our bytes.
		let msgpackrStruct;
		try {
			msgpackrStruct = await import('msgpackr/struct.js');
		} catch {
			// struct.js might not be directly importable in all environments
			this.skip();
			return;
		}

		const { Packr } = await import('msgpackr');

		const sEnc = new Structon({ structures: [] });
		const buf = sEnc.encode({ name: 'compat', value: 42 });

		// Structon's recordId is relative to its own typedStructs;
		// load the same structures into a native Packr instance.
		const nativePackr = new Packr({
			structures: [],
			randomAccessStructure: true,
		});
		nativePackr.typedStructs = sEnc.typedStructs;
		if (nativePackr.typedStructs.transitions)
			nativePackr.typedStructs.transitions = sEnc.typedStructs.transitions;

		const result = nativePackr.unpack(buf);
		assert.strictEqual(result.name, 'compat');
		assert.strictEqual(result.value, 42);
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
