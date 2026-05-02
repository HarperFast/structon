/**
 * Benchmark: structon + msgpackr v2 vs msgpackr v1.11 randomAccessStructure
 *
 * Run with: npm run benchmark
 */

import { Packr } from 'msgpackr'; // v2 — no native randomAccessStructure
import { Packr as LegacyPackr } from 'msgpackr-legacy'; // v1.11
import { createStructon } from '../index.js';

// Register struct hooks on the legacy packr so randomAccessStructure: true works
await import('../node_modules/msgpackr-legacy/struct.js');

const StructonV2 = createStructon(Packr);
const StructonLegacy = createStructon(LegacyPackr);

const data = {
	id: 12345,
	name: 'benchmark user',
	email: 'user@example.com',
	age: 34,
	score: 98.7,
	active: true,
	createdAt: new Date('2024-01-15T12:00:00.000Z'),
	tags: ['alpha', 'beta'],
	meta: { region: 'us-west', tier: 3 },
};

const DURATION = 3000; // ms per operation
const COL1 = 55;
const COL2 = 9;
const COL3 = 6;

console.log();
console.log(rpad('operation', COL1), '|', lpad('ops', COL2), '|', lpad('ms', COL3), '|', 'ops/s');
console.log(rpad('', COL1, '-'), '|', lpad(':', COL2, '-'), '|', lpad(':', COL3, '-'), '|', '------');

// ── structon + msgpackr v2 ────────────────────────────────────────────────────

const encV2 = new StructonV2({ structures: [] });
let buf;
buf = bench('structon + msgpackr v2 encode', (d) => encV2.encode(d), data);
bench('structon + msgpackr v2 decode', (b) => encV2.decode(b), buf);

console.log();

// ── msgpackr v1.11 with native randomAccessStructure ─────────────────────────

const nativeLegacy = new LegacyPackr({ structures: [], randomAccessStructure: true });
buf = bench('msgpackr v1.11 randomAccessStructure encode', (d) => nativeLegacy.pack(d), data);
bench('msgpackr v1.11 randomAccessStructure decode', (b) => nativeLegacy.unpack(b), buf);

console.log();

// ── structon + msgpackr v1.11 (structon wrapping legacy) ─────────────────────

const encLegacy = new StructonLegacy({ structures: [] });
buf = bench('structon + msgpackr v1.11 encode', (d) => encLegacy.encode(d), data);
bench('structon + msgpackr v1.11 decode', (b) => encLegacy.decode(b), buf);

console.log();

// ── plain msgpackr v2 baselines ───────────────────────────────────────────────

const sharedRecords = new Packr({ structures: [] });
buf = bench('msgpackr v2 shared records encode', (d) => sharedRecords.pack(d), data);
bench('msgpackr v2 shared records decode', (b) => sharedRecords.unpack(b), buf);

console.log();

const plainV2 = new Packr({ useRecords: false });
buf = bench('msgpackr v2 plain encode', (d) => plainV2.pack(d), data);
bench('msgpackr v2 plain decode', (b) => plainV2.unpack(b), buf);

console.log();

// ── JSON baseline ─────────────────────────────────────────────────────────────

buf = bench('JSON.stringify encode', (d) => Buffer.from(JSON.stringify(d)), data);
bench('JSON.parse decode', (b) => JSON.parse(b), buf);

console.log();

// ── helpers ───────────────────────────────────────────────────────────────────

function bench(name, fn, src) {
	let ret, count = 0;
	const start = Date.now();
	while (true) {
		const elapsed = Date.now() - start;
		if (elapsed >= DURATION) {
			const score = Math.floor(count / elapsed * 1000);
			console.log(rpad(name, COL1), '|', lpad(count, COL2), '|', lpad(elapsed, COL3), '|', score);
			return ret;
		}
		while (++count % 100) ret = fn(src);
	}
}

function rpad(str, len, chr = ' ') {
	str = String(str);
	while (str.length < len) str += chr;
	return str;
}

function lpad(str, len, chr = ' ') {
	str = String(str);
	while (str.length < len) str = chr + str;
	return str;
}
