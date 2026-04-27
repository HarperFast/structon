/*
 * Random-access struct encoding/decoding.
 *
 * Binary format is identical to msgpackr's struct.js:
 *   0x20-0x2f  record id 0-15  (1-byte header)
 *   0x38       8-bit record id follows
 *   0x39       16-bit record id follows (LE)
 *   0x3a       24-bit record id follows (LE)
 *   0x3b       32-bit record id follows (LE)
 *
 * Layout: [header][fixed-width fields][variable ref section]
 * Fixed section: non-queued fields first (in enumeration order), then
 *   queued object/null/undefined fields.
 * Ref section: string bytes first, then msgpack/cbor-encoded object bytes.
 * String/object ref fields contain byte offsets relative to start of ref section.
 */

const ASCII = 3;
const NUMBER = 0;
const UTF8 = 2;
const OBJECT_DATA = 1;
const DATE = 16;
const TYPE_NAMES = ['num', 'object', 'string', 'ascii'];
TYPE_NAMES[DATE] = 'date';

const float32Headers = [false, true, true, false, false, true, true, false];

export const RECORD_SYMBOL = Symbol('record-id');
export const SOURCE_SYMBOL = Symbol.for('source');

// Multiplier table for float32 significant-digit rounding (matches msgpackr/unpack.js)
export const mult10 = new Array(256);
for (let i = 0; i < 256; i++) {
	mult10[i] = +('1e' + Math.floor(45.15 - i * 0.30103));
}

let evalSupported;
try { new Function(''); evalSupported = true; } catch (e) { /* sandboxed */ }

let _textEncoder;
try { _textEncoder = new TextEncoder(); } catch (e) { /* not available */ }

let _textDecoder;
try { _textDecoder = new TextDecoder(); } catch (e) { /* not available */ }

function utf8Encode(str) {
	if (typeof Buffer !== 'undefined') {
		const b = Buffer.from(str, 'utf8');
		return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
	}
	if (_textEncoder) return _textEncoder.encode(str);
	const bytes = [];
	for (let i = 0; i < str.length; i++) {
		const c = str.charCodeAt(i);
		if (c < 0x80) bytes.push(c);
		else if (c < 0x800) bytes.push(c >> 6 | 0xc0, c & 0x3f | 0x80);
		else bytes.push(c >> 12 | 0xe0, c >> 6 & 0x3f | 0x80, c & 0x3f | 0x80);
	}
	return new Uint8Array(bytes);
}

export function readString(src, start, length) {
	if (typeof Buffer !== 'undefined') {
		const b = Buffer.isBuffer(src)
			? src
			: Buffer.from(src.buffer, src.byteOffset, src.byteLength);
		return b.toString('utf8', start, start + length);
	}
	if (_textDecoder) return _textDecoder.decode(src.subarray(start, start + length));
	let s = '';
	for (let i = start, end = start + length; i < end; i++) s += String.fromCharCode(src[i]);
	return s;
}

function toConstant(code) {
	switch (code) {
		case 0xf6: return null;
		case 0xf7: return undefined;
		case 0xf8: return false;
		case 0xf9: return true;
	}
	throw new Error('Unknown constant 0x' + code.toString(16));
}

function withSource(get) {
	return function () { return get(this[SOURCE_SYMBOL]); };
}

function createBlankTransition(key, parent) {
	return {
		key, parent,
		enumerationOffset: 0,
		ascii0: null, ascii8: null, num8: null,
		string16: null, object16: null, num32: null,
		float64: null, date64: null,
	};
}

function createTypeTransition(transition, type, size) {
	const typeName = TYPE_NAMES[type] + (size << 3);
	let t = transition[typeName] || (transition[typeName] = Object.create(null));
	t.__type = type;
	t.__size = size;
	t.__parent = transition;
	return t;
}

// Try to encode null/undefined into an existing fixed-width slot via CBOR constants.
// Returns {transition, bytes} or null if no existing slot found.
function anyTypeFixed(transition, value /* -10=null, -9=undefined */) {
	let next;
	if ((next = transition.ascii8 || transition.num8)) {
		const b = new Uint8Array(1);
		new DataView(b.buffer).setInt8(0, value);
		return { transition: next, bytes: b };
	}
	if ((next = transition.string16 || transition.object16)) {
		const b = new Uint8Array(2);
		new DataView(b.buffer).setInt16(0, value, true);
		return { transition: next, bytes: b };
	}
	if ((next = transition.num32)) {
		const b = new Uint8Array(4);
		new DataView(b.buffer).setUint32(0, 0xe0000100 + value, true);
		return { transition: next, bytes: b };
	}
	if ((next = transition.num64)) {
		const b = new Uint8Array(8);
		new DataView(b.buffer).setFloat64(0, NaN, true);
		new DataView(b.buffer).setInt8(0, value);
		return { transition: next, bytes: b };
	}
	return null;
}

/**
 * Encode `object` as a random-access struct.
 *
 * @param {object} object
 * @param {function} encodeNested  - (value) => Uint8Array, for nested objects
 * @param {object} packr  - must have .typedStructs array (created if absent)
 * @returns {Uint8Array|null}
 */
export function writeStruct(object, encodeNested, packr) {
	let typedStructs = packr.typedStructs || (packr.typedStructs = []);
	let transition = typedStructs.transitions || (typedStructs.transitions = Object.create(null));

	const nextId = typedStructs.length;
	const headerSize =
		nextId < 0x10  ? 1 :
		nextId < 0xf0  ? 2 :
		nextId < 0xf000 ? 3 :
		nextId < 0xf00000 ? 4 : 0;
	if (headerSize === 0) return null;

	// primFixed: fixed bytes for non-queued fields (in enumeration order)
	// objFixed:  fixed bytes for queued fields (objects / null / undefined)
	// strRef:    string bytes written to ref section
	// objRef:    msgpack/cbor-encoded object bytes written to ref section
	const primFixed = [];
	const objFixed = [];
	const strRef = [];
	const objRef = [];
	let strRefOffset = 0; // running byte count in strRef
	let objRefOffset = 0; // running byte count in objRef

	const queuedReferences = []; // [key, value, keyIndex, ...]
	let usedAscii0 = false;
	let keyIndex = 0;
	let structureUpdated = false;

	for (const key in object) {
		const value = object[key];
		let nextTransition = transition[key];
		if (!nextTransition) {
			transition[key] = nextTransition = createBlankTransition(key, transition);
		}

		switch (typeof value) {
			case 'number': {
				const number = value;
				if (nextId < 200 || !nextTransition.num64) {
					if (number >> 0 === number && number < 0x20000000 && number > -0x1f000000) {
						if (
							number < 0xf6 && number >= 0 &&
							(nextTransition.num8 && !(nextId > 200 && nextTransition.num32) ||
							 number < 0x20 && !nextTransition.num32)
						) {
							transition = nextTransition.num8 || createTypeTransition(nextTransition, NUMBER, 1);
							primFixed.push(new Uint8Array([number]));
						} else {
							transition = nextTransition.num32 || createTypeTransition(nextTransition, NUMBER, 4);
							const b = new Uint8Array(4);
							new DataView(b.buffer).setUint32(0, number, true);
							primFixed.push(b);
						}
						break;
					} else if (number < 0x100000000 && number >= -0x80000000) {
						const f32b = new Uint8Array(4);
						new DataView(f32b.buffer).setFloat32(0, number, true);
						if (float32Headers[f32b[3] >>> 5]) {
							let xShifted;
							if (((xShifted = number * mult10[((f32b[3] & 0x7f) << 1) | (f32b[2] >> 7)]) >> 0) === xShifted) {
								transition = nextTransition.num32 || createTypeTransition(nextTransition, NUMBER, 4);
								primFixed.push(f32b);
								break;
							}
						}
					}
				}
				transition = nextTransition.num64 || createTypeTransition(nextTransition, NUMBER, 8);
				const b64 = new Uint8Array(8);
				new DataView(b64.buffer).setFloat64(0, number, true);
				primFixed.push(b64);
				break;
			}

			case 'string': {
				const strBytes = utf8Encode(value);
				const isNotAscii = strBytes.length > value.length;
				const curOffset = strRefOffset;

				if (curOffset < 0xa0 || (curOffset < 0xf6 && (nextTransition.ascii8 || nextTransition.string8))) {
					if (isNotAscii) {
						if (!(transition = nextTransition.string8)) {
							if (typedStructs.length > 10 && (transition = nextTransition.ascii8)) {
								transition.__type = UTF8;
								nextTransition.ascii8 = null;
								nextTransition.string8 = transition;
								structureUpdated = true;
							} else {
								transition = createTypeTransition(nextTransition, UTF8, 1);
							}
						}
						primFixed.push(new Uint8Array([curOffset]));
					} else if (curOffset === 0 && !usedAscii0) {
						usedAscii0 = true;
						transition = nextTransition.ascii0 || createTypeTransition(nextTransition, ASCII, 0);
						// size=0: no fixed bytes pushed
					} else {
						if (!(transition = nextTransition.ascii8) &&
							!(typedStructs.length > 10 && (transition = nextTransition.string8)))
							transition = createTypeTransition(nextTransition, ASCII, 1);
						primFixed.push(new Uint8Array([curOffset]));
					}
				} else {
					transition = nextTransition.string16 || createTypeTransition(nextTransition, UTF8, 2);
					const b = new Uint8Array(2);
					new DataView(b.buffer).setUint16(0, curOffset, true);
					primFixed.push(b);
				}
				strRef.push(strBytes);
				strRefOffset += strBytes.length;
				break;
			}

			case 'object': {
				if (value && value.constructor === Date) {
					transition = nextTransition.date64 || createTypeTransition(nextTransition, DATE, 8);
					const bd = new Uint8Array(8);
					new DataView(bd.buffer).setFloat64(0, value.getTime(), true);
					primFixed.push(bd);
				} else if (value) {
					queuedReferences.push(key, value, keyIndex);
					// no primFixed push — queued bytes go to objFixed
				} else {
					// null
					const any = anyTypeFixed(nextTransition, -10);
					if (any) {
						transition = any.transition;
						primFixed.push(any.bytes);
					} else {
						queuedReferences.push(key, null, keyIndex);
					}
				}
				break;
			}

			case 'boolean':
				transition = nextTransition.num8 || nextTransition.ascii8 ||
					createTypeTransition(nextTransition, NUMBER, 1);
				primFixed.push(new Uint8Array([value ? 0xf9 : 0xf8]));
				break;

			case 'undefined': {
				const any = anyTypeFixed(nextTransition, -9);
				if (any) {
					transition = any.transition;
					primFixed.push(any.bytes);
				} else {
					queuedReferences.push(key, undefined, keyIndex);
				}
				break;
			}

			default:
				queuedReferences.push(key, value, keyIndex);
				break;
		}
		keyIndex++;
	}

	// Queued objects/null/undefined — their fixed bytes follow the primitive fixed bytes
	const totalStrBytes = strRefOffset;

	for (let i = 0, l = queuedReferences.length; i < l;) {
		const key = queuedReferences[i++];
		const value = queuedReferences[i++];
		const propertyIndex = queuedReferences[i++];

		let nextTransition = transition[key];
		if (!nextTransition) {
			transition[key] = nextTransition = {
				key,
				parent: transition,
				enumerationOffset: propertyIndex - keyIndex,
				ascii0: null, ascii8: null, num8: null,
				string16: null, object16: null, num32: null,
				float64: null, date64: null,
			};
		}

		if (value != null) {
			// Encode value (object or queued string) as msgpack/cbor in the ref section
			const encoded = encodeNested(value);
			const curOffset = totalStrBytes + objRefOffset;
			let size;
			if (curOffset < 0xff00) {
				transition = nextTransition.object16;
				if (transition) size = 2;
				else if ((transition = nextTransition.object32)) size = 4;
				else { transition = createTypeTransition(nextTransition, OBJECT_DATA, 2); size = 2; }
			} else {
				transition = nextTransition.object32 || createTypeTransition(nextTransition, OBJECT_DATA, 4);
				size = 4;
			}
			const b = new Uint8Array(size);
			if (size === 2) new DataView(b.buffer).setUint16(0, curOffset, true);
			else new DataView(b.buffer).setUint32(0, curOffset, true);
			objFixed.push(b);
			objRef.push(encoded);
			objRefOffset += encoded.length;
		} else {
			// null or undefined sentinel
			transition = nextTransition.object16 || createTypeTransition(nextTransition, OBJECT_DATA, 2);
			const b = new Uint8Array(2);
			new DataView(b.buffer).setInt16(0, value === null ? -10 : -9, true);
			objFixed.push(b);
		}
		keyIndex++;
	}

	// Build/retrieve structure definition from the transition chain
	let recordId = transition[RECORD_SYMBOL];
	if (recordId == null) {
		recordId = typedStructs.length;
		const structure = [];
		let t = transition;
		while (t.__type !== undefined) {
			const type = t.__type;
			const size = t.__size;
			const keyTrans = t.__parent; // key-level transition
			const entry = [type, size, keyTrans.key];
			if (keyTrans.enumerationOffset) entry.push(keyTrans.enumerationOffset);
			structure.push(entry);
			t = keyTrans.parent; // move to parent type-level transition
		}
		structure.reverse();
		transition[RECORD_SYMBOL] = recordId;
		typedStructs[recordId] = structure;
		structureUpdated = true;
	}

	if (structureUpdated && packr._onStructureAdded) packr._onStructureAdded();

	// Build header
	const header = buildHeader(recordId, headerSize);
	if (!header) return null;

	// Combine into final buffer
	let totalSize = header.length;
	for (const b of primFixed) totalSize += b.length;
	for (const b of objFixed) totalSize += b.length;
	for (const b of strRef) totalSize += b.length;
	for (const b of objRef) totalSize += b.length;

	const result = new Uint8Array(totalSize);
	let pos = 0;
	result.set(header, pos); pos += header.length;
	for (const b of primFixed) { result.set(b, pos); pos += b.length; }
	for (const b of objFixed) { result.set(b, pos); pos += b.length; }
	for (const b of strRef) { result.set(b, pos); pos += b.length; }
	for (const b of objRef) { result.set(b, pos); pos += b.length; }

	return result;
}

function buildHeader(recordId, headerSize) {
	switch (headerSize) {
		case 1:
			if (recordId >= 0x10) return null;
			return new Uint8Array([recordId + 0x20]);
		case 2:
			if (recordId >= 0x100) return null;
			return new Uint8Array([0x38, recordId]);
		case 3: {
			if (recordId >= 0x10000) return null;
			const b = new Uint8Array(3);
			b[0] = 0x39;
			new DataView(b.buffer).setUint16(1, recordId, true);
			return b;
		}
		case 4: {
			if (recordId >= 0x1000000) return null;
			const b = new Uint8Array(4);
			new DataView(b.buffer).setUint32(0, (recordId << 8) + 0x3a, true);
			return b;
		}
	}
	return null;
}

/**
 * Decode a random-access struct.
 *
 * @param {Uint8Array} src
 * @param {number} position  - byte offset of the struct header in src
 * @param {number} srcEnd    - exclusive end byte
 * @param {object} unpackr   - must implement _decodeSliceDirect(src, start, end)
 * @returns lazy object with property getters
 */
export function readStruct(src, position, srcEnd, unpackr) {
	let recordId = src[position++] - 0x20;
	if (recordId >= 24) {
		switch (recordId) {
			case 24: recordId = src[position++]; break;
			case 25: recordId = src[position++] + (src[position++] << 8); break;
			case 26: recordId = src[position++] + (src[position++] << 8) + (src[position++] << 16); break;
			case 27: recordId = src[position++] + (src[position++] << 8) + (src[position++] << 16) + (src[position++] << 24); break;
		}
	}

	let structure = unpackr.typedStructs && unpackr.typedStructs[recordId];
	if (!structure) {
		if (typeof unpackr._loadStructures === 'function') {
			unpackr._loadStructures();
			structure = unpackr.typedStructs && unpackr.typedStructs[recordId];
		}
		if (!structure) throw new Error('Could not find typed structure ' + recordId);
	}

	if (!structure.construct) {
		structure.construct = function LazyObject() {};
		structure.fullConstruct = function LoadedObject() {};
		structure.fullConstruct.prototype = unpackr.structPrototype || {};
		const prototype = structure.construct.prototype = unpackr.structPrototype
			? Object.create(unpackr.structPrototype) : {};

		const properties = [];
		let currentOffset = 0;
		let lastRefProperty;

		for (let i = 0, l = structure.length; i < l; i++) {
			let [type, size, key, enumerationOffset] = structure[i];
			if (key === '__proto__') key = '__proto_';

			const property = { key, offset: currentOffset };
			if (enumerationOffset) properties.splice(i + enumerationOffset, 0, property);
			else properties.push(property);

			let getRef;
			switch (size) {
				case 0: getRef = () => 0; break;
				case 1:
					getRef = (src, pos) => {
						const v = src.bytes[pos + property.offset];
						return v >= 0xf6 ? toConstant(v) : v;
					};
					break;
				case 2:
					getRef = (src, pos) => {
						const b = src.bytes;
						const dv = b.dataView || (b.dataView = new DataView(b.buffer, b.byteOffset, b.byteLength));
						const v = dv.getUint16(pos + property.offset, true);
						return v >= 0xff00 ? toConstant(v & 0xff) : v;
					};
					break;
				case 4:
					getRef = (src, pos) => {
						const b = src.bytes;
						const dv = b.dataView || (b.dataView = new DataView(b.buffer, b.byteOffset, b.byteLength));
						const v = dv.getUint32(pos + property.offset, true);
						return v >= 0xffffff00 ? toConstant(v & 0xff) : v;
					};
					break;
			}
			property.getRef = getRef;
			currentOffset += size;

			let get;
			switch (type) {
				case ASCII:
					if (lastRefProperty && !lastRefProperty.next) lastRefProperty.next = property;
					lastRefProperty = property;
					property.multiGetCount = 0;
					get = (function(prop) { return function(source) {
						const pos = source.position;
						const refStart = currentOffset + pos;
						const ref = prop.getRef(source, pos);
						if (typeof ref !== 'number') return ref;
						let end, next = prop.next;
						while (next) {
							end = next.getRef(source, pos);
							if (typeof end === 'number') break;
							else end = null;
							next = next.next;
						}
						if (end == null) end = source.bytesEnd - refStart;
						if (source.srcString) return source.srcString.slice(ref, end);
						return readString(source.bytes, ref + refStart, end - ref);
					}; })(property);
					break;

				case UTF8:
				case OBJECT_DATA:
					if (lastRefProperty && !lastRefProperty.next) lastRefProperty.next = property;
					lastRefProperty = property;
					get = (function(prop, t) { return function(source) {
						const pos = source.position;
						const refStart = currentOffset + pos;
						const ref = prop.getRef(source, pos);
						if (typeof ref !== 'number') return ref;
						let end, next = prop.next;
						while (next) {
							end = next.getRef(source, pos);
							if (typeof end === 'number') break;
							else end = null;
							next = next.next;
						}
						if (end == null) end = source.bytesEnd - refStart;
						if (t === UTF8) {
							return readString(source.bytes, ref + refStart, end - ref);
						}
						return unpackr._decodeSliceDirect(source.bytes, ref + refStart, end + refStart);
					}; })(property, type);
					break;

				case NUMBER:
					switch (size) {
						case 4:
							get = (function(prop) { return function(source) {
								const b = source.bytes;
								const dv = b.dataView || (b.dataView = new DataView(b.buffer, b.byteOffset, b.byteLength));
								const p = source.position + prop.offset;
								const v = dv.getInt32(p, true);
								if (v < 0x20000000) {
									if (v > -0x1f000000) return v;
									if (v > -0x20000000) return toConstant(v & 0xff);
								}
								const fv = dv.getFloat32(p, true);
								const m = mult10[((b[p + 3] & 0x7f) << 1) | (b[p + 2] >> 7)];
								return ((m * fv + (fv > 0 ? 0.5 : -0.5)) >> 0) / m;
							}; })(property);
							break;
						case 8:
							get = (function(prop) { return function(source) {
								const b = source.bytes;
								const dv = b.dataView || (b.dataView = new DataView(b.buffer, b.byteOffset, b.byteLength));
								const v = dv.getFloat64(source.position + prop.offset, true);
								if (isNaN(v)) {
									const byte = b[source.position + prop.offset];
									if (byte >= 0xf6) return toConstant(byte);
								}
								return v;
							}; })(property);
							break;
						case 1:
							get = (function(prop) { return function(source) {
								const v = source.bytes[source.position + prop.offset];
								return v < 0xf6 ? v : toConstant(v);
							}; })(property);
							break;
					}
					break;

				case DATE:
					get = (function(prop) { return function(source) {
						const b = source.bytes;
						const dv = b.dataView || (b.dataView = new DataView(b.buffer, b.byteOffset, b.byteLength));
						return new Date(dv.getFloat64(source.position + prop.offset, true));
					}; })(property);
					break;
			}
			property.get = get;
		}

		if (evalSupported) {
			const args = [], litProps = [];
			let gi = 0, hasInherited;
			for (const prop of properties) {
				if (unpackr.alwaysLazyProperty && unpackr.alwaysLazyProperty(prop.key)) {
					hasInherited = true; continue;
				}
				Object.defineProperty(prototype, prop.key, { get: withSource(prop.get), enumerable: true });
				const vf = 'v' + gi++;
				args.push(vf);
				litProps.push('o[' + JSON.stringify(prop.key) + ']=' + vf + '(s)');
			}
			if (hasInherited) litProps.push('__proto__:this');
			const toObj = (new Function(...args,
				'var c=this;return function(s){var o=new c();' + litProps.join(';') + ';return o;}'))
				.apply(structure.fullConstruct, properties.map(p => p.get));
			Object.defineProperty(prototype, 'toJSON', {
				value() { return toObj.call(this, this[SOURCE_SYMBOL]); }
			});
		} else {
			for (const prop of properties)
				Object.defineProperty(prototype, prop.key, { get: withSource(prop.get), enumerable: true });
			Object.defineProperty(prototype, 'toJSON', {
				value() {
					const out = {};
					for (const p of properties) out[p.key] = this[p.key];
					return out;
				}
			});
		}
	}

	const instance = new structure.construct();
	instance[SOURCE_SYMBOL] = { bytes: src, position, srcString: '', bytesEnd: srcEnd };
	return instance;
}

/**
 * Called (bound to the decoder instance) when stored structures are loaded.
 * Accepts the same Map format that msgpackr's struct.js produces.
 */
export function onLoadedStructures(sharedData) {
	if (!(sharedData instanceof Map)) return;
	let typed = sharedData.get('typed') || [];
	if (Object.isFrozen(typed)) typed = typed.map(s => s.slice(0));

	const transitions = Object.create(null);
	for (let i = 0, l = typed.length; i < l; i++) {
		let t = transitions;
		for (const [type, size, key] of typed[i]) {
			let next = t[key];
			if (!next) {
				t[key] = next = {
					key, parent: t, enumerationOffset: 0,
					ascii0: null, ascii8: null, num8: null,
					string16: null, object16: null, num32: null,
					float64: null, date64: null,
				};
			}
			t = createTypeTransition(next, type, size);
		}
		t[RECORD_SYMBOL] = i;
	}
	typed.transitions = transitions;
	this.typedStructs = typed;
	this.lastTypedStructuresLength = typed.length;
}

/**
 * Wraps structures for saving in the same Map format as msgpackr's struct.js.
 */
export function prepareStructures(structures, packr) {
	if (packr.typedStructs) {
		const m = new Map();
		m.set('named', structures);
		m.set('typed', packr.typedStructs);
		structures = m;
	}
	const lastTypedLen = packr.lastTypedStructuresLength || 0;
	structures.isCompatible = existing => {
		let ok = true;
		if (existing instanceof Map) {
			if ((existing.get('named') || []).length !== (packr.lastNamedStructuresLength || 0)) ok = false;
			if ((existing.get('typed') || []).length !== lastTypedLen) ok = false;
		} else if (Array.isArray(existing)) {
			if (existing.length !== (packr.lastNamedStructuresLength || 0)) ok = false;
		}
		if (!ok) onLoadedStructures.call(packr, existing);
		return ok;
	};
	packr.lastTypedStructuresLength = packr.typedStructs && packr.typedStructs.length;
	return structures;
}
