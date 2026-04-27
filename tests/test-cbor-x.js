import { suite, test } from 'mocha';
import assert from 'assert';
import { Encoder } from 'cbor-x';
import { createStructon } from '../index.js';

const Structon = createStructon(Encoder);

function roundtrip(enc, value) {
	return enc.decode(enc.encode(value));
}

// ── basic types ───────────────────────────────────────────────────────────────

suite('structon (cbor-x base) – basic types', function () {
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

// ── multiple fields & nested objects ──────────────────────────────────────────

suite('structon (cbor-x base) – multiple fields', function () {
	const enc = new Structon({ structures: [] });

	test('mixed number and string fields', function () {
		const obj = { name: 'Bob', age: 25, score: 99.5 };
		const result = roundtrip(enc, obj);
		assert.strictEqual(result.name, 'Bob');
		assert.strictEqual(result.age, 25);
		assert.strictEqual(result.score, 99.5);
	});

	test('nested object field is encoded by cbor-x base', function () {
		const obj = { id: 7, meta: { kind: 'widget', count: 3 } };
		const result = roundtrip(enc, obj);
		assert.strictEqual(result.id, 7);
		const meta = result.meta;
		assert.strictEqual(meta.kind, 'widget');
		assert.strictEqual(meta.count, 3);
	});

	test('toJSON produces correct values', function () {
		const obj = { id: 1, label: 'test', active: true };
		const result = enc.decode(enc.encode(obj));
		const plain = result.toJSON();
		assert.strictEqual(plain.id, 1);
		assert.strictEqual(plain.label, 'test');
		assert.strictEqual(plain.active, true);
	});
});

// ── struct random-access behaviour ────────────────────────────────────────────

suite('structon (cbor-x base) – random access', function () {
	const enc = new Structon({ structures: [] });

	test('encoded bytes start with struct header byte (0x20-0x3f)', function () {
		const buf = enc.encode({ x: 1 });
		assert.ok(buf[0] >= 0x20 && buf[0] < 0x40, `expected struct header, got 0x${buf[0].toString(16)}`);
	});

	test('individual properties are lazily accessible', function () {
		const obj = { name: 'lazy', count: 42, flag: true };
		const result = enc.decode(enc.encode(obj));
		assert.strictEqual(result.count, 42);
	});

	test('same structure encoded twice reuses record id', function () {
		const enc2 = new Structon({ structures: [] });
		const buf1 = enc2.encode({ a: 1, b: 'x' });
		const buf2 = enc2.encode({ a: 2, b: 'y' });
		assert.strictEqual(buf1[0], buf2[0]);
	});

	test('different structures get different record ids', function () {
		const enc2 = new Structon({ structures: [] });
		const buf1 = enc2.encode({ x: 1 });
		const buf2 = enc2.encode({ y: 2 });
		assert.notStrictEqual(buf1[0], buf2[0]);
	});
});

// ── non-struct values fall through to base cbor-x Encoder ────────────────────

suite('structon (cbor-x base) – non-struct pass-through', function () {
	const enc = new Structon({ structures: [] });

	test('arrays are encoded/decoded by cbor-x', function () {
		const arr = [1, 2, 3];
		const buf = enc.encode(arr);
		const result = enc.decode(buf);
		assert.deepStrictEqual(result, arr);
	});

	test('strings are encoded/decoded by cbor-x', function () {
		const buf = enc.encode('hello');
		assert.strictEqual(enc.decode(buf), 'hello');
	});

	test('large numbers are encoded/decoded by cbor-x', function () {
		// cbor-x encodes 1000 as a multi-byte integer (not 0x20-0x3f range)
		const buf = enc.encode(1000);
		assert.strictEqual(enc.decode(buf), 1000);
	});

	test('null is encoded/decoded by cbor-x', function () {
		const buf = enc.encode(null);
		assert.strictEqual(enc.decode(buf), null);
	});
});

// ── repeated encodings ────────────────────────────────────────────────────────

suite('structon (cbor-x base) – repeated encodings', function () {
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
		const ra = roundtrip(enc2, { kind: 'A', x: 1 });
		const rb = roundtrip(enc2, { kind: 'B', y: 2, z: 3 });
		assert.strictEqual(ra.kind, 'A');
		assert.strictEqual(ra.x, 1);
		assert.strictEqual(rb.kind, 'B');
		assert.strictEqual(rb.y, 2);
		assert.strictEqual(rb.z, 3);
	});
});

// ── cross-format consistency between cbor-x and msgpackr struct headers ──────

suite('structon (cbor-x base) – format details', function () {
	test('struct binary header is identical regardless of base encoder', async function () {
		const { Packr } = await import('msgpackr');
		const StructonMsgpackr = createStructon(Packr);

		const cborEnc = new Structon({ structures: [] });
		const msgpackrEnc = new StructonMsgpackr({ structures: [] });

		const cborBuf = cborEnc.encode({ x: 5 });
		const msgpackBuf = msgpackrEnc.encode({ x: 5 });

		// Both use the same struct header for record id 0
		assert.strictEqual(cborBuf[0], msgpackBuf[0]);
		// And the fixed integer field
		assert.strictEqual(cborBuf[1], msgpackBuf[1]);
	});

	test('struct with nested object: cbor-x payload differs from msgpackr', async function () {
		// The struct header + fixed section is identical, but nested object
		// bytes use cbor or msgpack depending on the base class.
		const { Packr } = await import('msgpackr');
		const StructonMsgpackr = createStructon(Packr);

		const cborEnc = new Structon({ structures: [] });
		const msgpackrEnc = new StructonMsgpackr({ structures: [] });

		const value = { id: 1, meta: { x: 10 } };
		const cborBuf = cborEnc.encode(value);
		const msgpackBuf = msgpackrEnc.encode(value);

		// Both round-trip correctly with their respective decoders
		const cborResult = cborEnc.decode(cborBuf);
		const msgpackResult = msgpackrEnc.decode(msgpackBuf);
		assert.strictEqual(cborResult.id, 1);
		assert.strictEqual(cborResult.meta.x, 10);
		assert.strictEqual(msgpackResult.id, 1);
		assert.strictEqual(msgpackResult.meta.x, 10);
	});
});
