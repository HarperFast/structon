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

// Tracks the source being decoded by a nested unpack call so that
// `saveState` can detach it from the parent decoder's buffer state.
let currentSource;

/**
 * Called (bound to the decoder) when msgpackr saves its decoder state — e.g.
 * during a nested unpack call.  If we're in the middle of reading a struct's
 * OBJECT_DATA field, slice the lazy struct's bytes so it remains self-contained
 * after the parent decoder's globals are clobbered.
 */
export function saveState() {
	if (currentSource) {
		currentSource.bytes = Uint8Array.prototype.slice.call(currentSource.bytes, currentSource.position, currentSource.bytesEnd);
		currentSource.position = 0;
		currentSource.bytesEnd = currentSource.bytes.length;
		currentSource = null;
	}
}

// Multiplier table for float32 significant-digit rounding (matches msgpackr/unpack.js)
export const mult10 = new Array(256);
for (let i = 0; i < 256; i++) {
	mult10[i] = +('1e' + Math.floor(45.15 - i * 0.30103));
}

let evalSupported;
try { new Function(''); evalSupported = true; } catch (e) { /* sandboxed */ }

let _textDecoder;
try { _textDecoder = new TextDecoder(); } catch (e) { /* not available */ }

// ── UTF-8 encoding helpers ────────────────────────────────────────────────────

const _hasNodeBuffer = typeof Buffer !== 'undefined';

// TextEncoder.encodeInto writes directly into a target buffer (no allocation).
const _encodeInto = (() => {
	if (_hasNodeBuffer) return null; // prefer Buffer.utf8Write on Node.js
	try {
		const te = new TextEncoder();
		return te.encodeInto ? (s, buf) => te.encodeInto(s, buf).written : null;
	} catch (e) { return null; }
})();

function utf8EncodeFallback(str) {
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
	if (_hasNodeBuffer) {
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

// ── Work-buffer pool (one pair per nesting depth) ─────────────────────────────
//
// Instead of allocating a new Uint8Array for each field value, we write
// directly into pre-allocated work buffers.  A per-depth pool means nested
// struct encoding (from encodeNested) uses a separate set of buffers and
// never clobbers the outer call's state.

const INITIAL_FIXED = 4096;
const INITIAL_REFS  = 65536;
const _pool = [];
let   _depth = 0;

function _getWork() {
	let w = _pool[_depth];
	if (!w) {
		const fb = _hasNodeBuffer ? Buffer.allocUnsafe(INITIAL_FIXED) : new Uint8Array(INITIAL_FIXED);
		const rb = _hasNodeBuffer ? Buffer.allocUnsafe(INITIAL_REFS)  : new Uint8Array(INITIAL_REFS);
		_pool[_depth] = w = {
			fixedBuf: fb,
			fixedView: new DataView(fb.buffer, fb.byteOffset || 0, INITIAL_FIXED),
			refsBuf: rb,
		};
	}
	return w;
}

function _growFixed(w, need) {
	const size = Math.max(w.fixedBuf.length * 2, need);
	const nb = _hasNodeBuffer ? Buffer.allocUnsafe(size) : new Uint8Array(size);
	nb.set(w.fixedBuf.subarray(0, w.fixedBuf.length));
	w.fixedBuf = nb;
	w.fixedView = new DataView(nb.buffer, nb.byteOffset || 0, size);
}

function _growRefs(w, need) {
	const size = Math.max(w.refsBuf.length * 2, w.refsBuf.length + need);
	const nb = _hasNodeBuffer ? Buffer.allocUnsafe(size) : new Uint8Array(size);
	nb.set(w.refsBuf);
	w.refsBuf = nb;
}

// Write a string directly into w.refsBuf at refsPos; return updated refsPos.
function _writeStr(w, refsPos, value) {
	const need = value.length * 3;
	if (refsPos + need > w.refsBuf.length) _growRefs(w, need);
	if (_hasNodeBuffer) return refsPos + w.refsBuf.utf8Write(value, refsPos);
	if (_encodeInto)    return refsPos + _encodeInto(value, w.refsBuf.subarray(refsPos));
	const bytes = utf8EncodeFallback(value);
	w.refsBuf.set(bytes, refsPos);
	return refsPos + bytes.length;
}

// Try to encode null/undefined into an existing fixed-width slot.
// Returns the matching transition node on success, null on failure.
// Updates _anyPos with the new fixedPos.
let _anyPos = 0;
function _anyTypeFixed(w, transition, fixedPos, value /* -10=null, -9=undefined */) {
	let next;
	if ((next = transition.ascii8 || transition.num8)) {
		w.fixedView.setInt8(fixedPos, value);
		_anyPos = fixedPos + 1;
		return next;
	}
	if ((next = transition.string16 || transition.object16)) {
		w.fixedView.setInt16(fixedPos, value, true);
		_anyPos = fixedPos + 2;
		return next;
	}
	if ((next = transition.num32)) {
		w.fixedView.setUint32(fixedPos, 0xe0000100 + value, true);
		_anyPos = fixedPos + 4;
		return next;
	}
	if ((next = transition.num64)) {
		w.fixedView.setFloat64(fixedPos, NaN, true);
		w.fixedView.setInt8(fixedPos, value);
		_anyPos = fixedPos + 8;
		return next;
	}
	return null;
}

function _writeHeader(result, recordId, headerSize) {
	switch (headerSize) {
		case 1: result[0] = recordId + 0x20; break;
		case 2: result[0] = 0x38; result[1] = recordId; break;
		case 3: {
			result[0] = 0x39;
			new DataView(result.buffer, result.byteOffset || 0).setUint16(1, recordId, true);
			break;
		}
		case 4: {
			new DataView(result.buffer, result.byteOffset || 0).setUint32(0, (recordId << 8) + 0x3a, true);
			break;
		}
	}
}

/**
 * Fast path: writes a struct directly into the BaseClass's shared target
 * buffer at the given position.  Avoids the per-field allocations of the
 * standalone writeStruct.
 *
 * Designed to be assigned to a Packr/Encoder instance as `_writeStruct`.
 * The BaseClass's encode pipeline calls it as a method, so `this` is the
 * encoder instance (provides `typedStructs`).
 *
 * @param {object} object
 * @param {Uint8Array|Buffer} target  - shared encoding buffer
 * @param {number} encodingStart      - start of this encoding within target
 * @param {number} position           - current write position in target
 * @param {Array}  structures         - BaseClass's named-records array (unused)
 * @param {function} makeRoom         - grow target; returns new target
 * @param {function} pack             - pack a nested value at a given position
 * @returns {number} new write position, or 0 to bail (fall back to plain object)
 */
export function writeStructInPlace(object, target, encodingStart, position, structures, makeRoom, pack) {
	const packr = this;
	let typedStructs = packr.typedStructs || (packr.typedStructs = []);
	let targetView = target.dataView;
	let refsStartPosition = (typedStructs.lastStringStart || 100) + position;
	let safeEnd = target.length - 10;
	let start = position;
	if (position > safeEnd) {
		target = makeRoom(position);
		targetView = target.dataView;
		position -= encodingStart;
		start -= encodingStart;
		refsStartPosition -= encodingStart;
		encodingStart = 0;
		safeEnd = target.length - 10;
	}

	let refOffset, refPosition = refsStartPosition;
	let transition = typedStructs.transitions || (typedStructs.transitions = Object.create(null));
	let nextId = typedStructs.length;
	let headerSize =
		nextId < 0xf      ? 1 :
		nextId < 0xf0     ? 2 :
		nextId < 0xf000   ? 3 :
		nextId < 0xf00000 ? 4 : 0;
	if (headerSize === 0) return 0;
	position += headerSize;

	const queuedReferences = [];
	let usedAscii0 = false;
	let keyIndex = 0;

	for (let key in object) {
		let value = object[key];
		let nextTransition = transition[key];
		if (!nextTransition) {
			transition[key] = nextTransition = {
				key, parent: transition, enumerationOffset: 0,
				ascii0: null, ascii8: null, num8: null,
				string16: null, object16: null, num32: null,
				float64: null, date64: null,
			};
		}
		if (position > safeEnd) {
			target = makeRoom(position);
			targetView = target.dataView;
			position -= encodingStart;
			start -= encodingStart;
			refsStartPosition -= encodingStart;
			refPosition -= encodingStart;
			encodingStart = 0;
			safeEnd = target.length - 10;
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
							target[position++] = number;
						} else {
							transition = nextTransition.num32 || createTypeTransition(nextTransition, NUMBER, 4);
							targetView.setUint32(position, number, true);
							position += 4;
						}
						break;
					} else if (number < 0x100000000 && number >= -0x80000000) {
						targetView.setFloat32(position, number, true);
						if (float32Headers[target[position + 3] >>> 5]) {
							let xShifted;
							if (((xShifted = number * mult10[((target[position + 3] & 0x7f) << 1) | (target[position + 2] >> 7)]) >> 0) === xShifted) {
								transition = nextTransition.num32 || createTypeTransition(nextTransition, NUMBER, 4);
								position += 4;
								break;
							}
						}
					}
				}
				transition = nextTransition.num64 || createTypeTransition(nextTransition, NUMBER, 8);
				targetView.setFloat64(position, number, true);
				position += 8;
				break;
			}
			case 'string': {
				const strLength = value.length;
				refOffset = refPosition - refsStartPosition;
				if ((strLength << 2) + refPosition > safeEnd) {
					target = makeRoom((strLength << 2) + refPosition);
					targetView = target.dataView;
					position -= encodingStart;
					start -= encodingStart;
					refsStartPosition -= encodingStart;
					refPosition -= encodingStart;
					encodingStart = 0;
					safeEnd = target.length - 10;
				}
				if (strLength > ((0xff00 + refOffset) >> 2)) {
					queuedReferences.push(key, value, position - start);
					break;
				}
				let isNotAscii;
				let strStart = refPosition;
				if (strLength < 0x40) {
					let i, c1, c2;
					for (i = 0; i < strLength; i++) {
						c1 = value.charCodeAt(i);
						if (c1 < 0x80) {
							target[refPosition++] = c1;
						} else if (c1 < 0x800) {
							isNotAscii = true;
							target[refPosition++] = c1 >> 6 | 0xc0;
							target[refPosition++] = c1 & 0x3f | 0x80;
						} else if (
							(c1 & 0xfc00) === 0xd800 &&
							((c2 = value.charCodeAt(i + 1)) & 0xfc00) === 0xdc00
						) {
							isNotAscii = true;
							c1 = 0x10000 + ((c1 & 0x03ff) << 10) + (c2 & 0x03ff);
							i++;
							target[refPosition++] = c1 >> 18 | 0xf0;
							target[refPosition++] = c1 >> 12 & 0x3f | 0x80;
							target[refPosition++] = c1 >> 6  & 0x3f | 0x80;
							target[refPosition++] = c1       & 0x3f | 0x80;
						} else {
							isNotAscii = true;
							target[refPosition++] = c1 >> 12 | 0xe0;
							target[refPosition++] = c1 >> 6 & 0x3f | 0x80;
							target[refPosition++] = c1      & 0x3f | 0x80;
						}
					}
				} else if (_hasNodeBuffer) {
					refPosition += target.utf8Write(value, refPosition, target.byteLength - refPosition);
					isNotAscii = refPosition - strStart > strLength;
				} else if (_encodeInto) {
					refPosition += _encodeInto(value, target.subarray(refPosition));
					isNotAscii = refPosition - strStart > strLength;
				} else {
					const bytes = utf8EncodeFallback(value);
					target.set(bytes, refPosition);
					refPosition += bytes.length;
					isNotAscii = bytes.length > strLength;
				}
				if (refOffset < 0xa0 || (refOffset < 0xf6 && (nextTransition.ascii8 || nextTransition.string8))) {
					if (isNotAscii) {
						if (!(transition = nextTransition.string8)) {
							if (typedStructs.length > 10 && (transition = nextTransition.ascii8)) {
								transition.__type = UTF8;
								nextTransition.ascii8 = null;
								nextTransition.string8 = transition;
								pack(null, 0, true); // notify structure update
							} else {
								transition = createTypeTransition(nextTransition, UTF8, 1);
							}
						}
					} else if (refOffset === 0 && !usedAscii0) {
						usedAscii0 = true;
						transition = nextTransition.ascii0 || createTypeTransition(nextTransition, ASCII, 0);
						break; // size=0: don't increment position
					} else if (!(transition = nextTransition.ascii8) &&
							   !(typedStructs.length > 10 && (transition = nextTransition.string8))) {
						transition = createTypeTransition(nextTransition, ASCII, 1);
					}
					target[position++] = refOffset;
				} else {
					transition = nextTransition.string16 || createTypeTransition(nextTransition, UTF8, 2);
					targetView.setUint16(position, refOffset, true);
					position += 2;
				}
				break;
			}
			case 'object': {
				if (value) {
					if (value.constructor === Date) {
						transition = nextTransition.date64 || createTypeTransition(nextTransition, DATE, 8);
						targetView.setFloat64(position, value.getTime(), true);
						position += 8;
					} else {
						queuedReferences.push(key, value, keyIndex);
					}
				} else {
					nextTransition = anyTypeInPlace(nextTransition, position, targetView, -10);
					if (nextTransition) {
						transition = nextTransition;
						position = updatedPosition;
					} else {
						queuedReferences.push(key, value, keyIndex);
					}
				}
				break;
			}
			case 'boolean':
				transition = nextTransition.num8 || nextTransition.ascii8 || createTypeTransition(nextTransition, NUMBER, 1);
				target[position++] = value ? 0xf9 : 0xf8;
				break;
			case 'undefined': {
				nextTransition = anyTypeInPlace(nextTransition, position, targetView, -9);
				if (nextTransition) {
					transition = nextTransition;
					position = updatedPosition;
				} else {
					queuedReferences.push(key, value, keyIndex);
				}
				break;
			}
			default:
				queuedReferences.push(key, value, keyIndex);
		}
		keyIndex++;
	}

	for (let i = 0, l = queuedReferences.length; i < l;) {
		let key = queuedReferences[i++];
		let value = queuedReferences[i++];
		let propertyIndex = queuedReferences[i++];
		let nextTransition = transition[key];
		if (!nextTransition) {
			transition[key] = nextTransition = {
				key, parent: transition,
				enumerationOffset: propertyIndex - keyIndex,
				ascii0: null, ascii8: null, num8: null,
				string16: null, object16: null, num32: null,
				float64: null, date64: null,
			};
		}
		let newPosition;
		if (value) {
			let size;
			refOffset = refPosition - refsStartPosition;
			if (refOffset < 0xff00) {
				transition = nextTransition.object16;
				if (transition) size = 2;
				else if ((transition = nextTransition.object32)) size = 4;
				else { transition = createTypeTransition(nextTransition, OBJECT_DATA, 2); size = 2; }
			} else {
				transition = nextTransition.object32 || createTypeTransition(nextTransition, OBJECT_DATA, 4);
				size = 4;
			}
			newPosition = pack(value, refPosition);
			if (typeof newPosition === 'object') {
				// re-allocated buffer — refresh local refs
				refPosition = newPosition.position;
				targetView = newPosition.targetView;
				target = newPosition.target;
				refsStartPosition -= encodingStart;
				position -= encodingStart;
				start -= encodingStart;
				encodingStart = 0;
			} else {
				refPosition = newPosition;
			}
			if (size === 2) { targetView.setUint16(position, refOffset, true); position += 2; }
			else            { targetView.setUint32(position, refOffset, true); position += 4; }
		} else { // null or undefined
			transition = nextTransition.object16 || createTypeTransition(nextTransition, OBJECT_DATA, 2);
			targetView.setInt16(position, value === null ? -10 : -9, true);
			position += 2;
		}
		keyIndex++;
	}

	let recordId = transition[RECORD_SYMBOL];
	if (recordId == null) {
		recordId = packr.typedStructs.length;
		const structure = [];
		let nextTransition = transition;
		let key, type;
		while ((type = nextTransition.__type) !== undefined) {
			let size = nextTransition.__size;
			nextTransition = nextTransition.__parent;
			key = nextTransition.key;
			let property = [type, size, key];
			if (nextTransition.enumerationOffset) property.push(nextTransition.enumerationOffset);
			structure.push(property);
			nextTransition = nextTransition.parent;
		}
		structure.reverse();
		transition[RECORD_SYMBOL] = recordId;
		packr.typedStructs[recordId] = structure;
		pack(null, 0, true); // notify structure update
	}

	switch (headerSize) {
		case 1:
			if (recordId >= 0x10) return 0;
			target[start] = recordId + 0x20;
			break;
		case 2:
			if (recordId >= 0x100) return 0;
			target[start] = 0x38;
			target[start + 1] = recordId;
			break;
		case 3:
			if (recordId >= 0x10000) return 0;
			target[start] = 0x39;
			targetView.setUint16(start + 1, recordId, true);
			break;
		case 4:
			if (recordId >= 0x1000000) return 0;
			targetView.setUint32(start, (recordId << 8) + 0x3a, true);
			break;
	}

	if (position < refsStartPosition) {
		if (refsStartPosition === refPosition) return position; // no refs
		// compact: shift ref bytes left to immediately follow fixed section
		target.copyWithin(position, refsStartPosition, refPosition);
		refPosition += position - refsStartPosition;
		typedStructs.lastStringStart = position - start;
	} else if (position > refsStartPosition) {
		if (refsStartPosition === refPosition) return position; // no refs
		// fixed section overflowed our estimate — retry with the corrected size
		typedStructs.lastStringStart = position - start;
		return writeStructInPlace.call(packr, object, target, encodingStart, start, structures, makeRoom, pack);
	}
	return refPosition;
}

let updatedPosition;
function anyTypeInPlace(transition, position, targetView, value) {
	let next;
	if ((next = transition.ascii8 || transition.num8)) {
		targetView.setInt8(position, value, true);
		updatedPosition = position + 1;
		return next;
	}
	if ((next = transition.string16 || transition.object16)) {
		targetView.setInt16(position, value, true);
		updatedPosition = position + 2;
		return next;
	}
	if ((next = transition.num32)) {
		targetView.setUint32(position, 0xe0000100 + value, true);
		updatedPosition = position + 4;
		return next;
	}
	if ((next = transition.num64)) {
		targetView.setFloat64(position, NaN, true);
		targetView.setInt8(position, value);
		updatedPosition = position + 8;
		return next;
	}
	updatedPosition = position;
	return null;
}

/**
 * Encode `object` as a random-access struct (standalone path — used when the
 * base encoder doesn't expose the writeStructSlots hook, e.g. cbor-x).
 *
 * @param {object} object
 * @param {function} encodeNested  - (value) => Uint8Array, for nested objects
 * @param {object} packr  - must have .typedStructs array (created if absent)
 * @returns {Uint8Array|null}
 */
export function writeStruct(object, encodeNested, packr) {
	// Grab work buffers for this nesting depth before incrementing so that
	// any encodeNested call (which may re-enter writeStruct) uses the next slot.
	const work = _getWork();
	_depth++;
	try {
		return _encode(object, encodeNested, packr, work);
	} finally {
		_depth--;
	}
}

function _encode(object, encodeNested, packr, work) {
	let typedStructs = packr.typedStructs || (packr.typedStructs = []);
	let transition = typedStructs.transitions || (typedStructs.transitions = Object.create(null));

	const nextId = typedStructs.length;
	const headerSize =
		nextId < 0x10    ? 1 :
		nextId < 0xf0    ? 2 :
		nextId < 0xf000  ? 3 :
		nextId < 0xf00000 ? 4 : 0;
	if (headerSize === 0) return null;

	let fixedPos = 0;
	let refsPos  = 0;
	const queuedReferences = [];
	let usedAscii0 = false;
	let keyIndex = 0;
	let structureUpdated = false;

	for (const key in object) {
		const value = object[key];
		let nextTransition = transition[key];
		if (!nextTransition) {
			transition[key] = nextTransition = createBlankTransition(key, transition);
		}
		if (fixedPos + 8 > work.fixedBuf.length) _growFixed(work, fixedPos + 8);

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
							work.fixedBuf[fixedPos++] = number;
						} else {
							transition = nextTransition.num32 || createTypeTransition(nextTransition, NUMBER, 4);
							work.fixedView.setUint32(fixedPos, number, true);
							fixedPos += 4;
						}
						break;
					} else if (number < 0x100000000 && number >= -0x80000000) {
						work.fixedView.setFloat32(fixedPos, number, true);
						if (float32Headers[work.fixedBuf[fixedPos + 3] >>> 5]) {
							let xShifted;
							if (((xShifted = number * mult10[((work.fixedBuf[fixedPos + 3] & 0x7f) << 1) | (work.fixedBuf[fixedPos + 2] >> 7)]) >> 0) === xShifted) {
								transition = nextTransition.num32 || createTypeTransition(nextTransition, NUMBER, 4);
								fixedPos += 4;
								break;
							}
						}
					}
				}
				transition = nextTransition.num64 || createTypeTransition(nextTransition, NUMBER, 8);
				work.fixedView.setFloat64(fixedPos, number, true);
				fixedPos += 8;
				break;
			}

			case 'string': {
				const strStart = refsPos;
				refsPos = _writeStr(work, refsPos, value);
				const isNotAscii = refsPos - strStart > value.length;
				const curOffset = strStart;

				if (fixedPos + 2 > work.fixedBuf.length) _growFixed(work, fixedPos + 2);

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
						work.fixedBuf[fixedPos++] = curOffset;
					} else if (curOffset === 0 && !usedAscii0) {
						usedAscii0 = true;
						transition = nextTransition.ascii0 || createTypeTransition(nextTransition, ASCII, 0);
						// size=0: no fixed byte written
					} else {
						if (!(transition = nextTransition.ascii8) &&
							!(typedStructs.length > 10 && (transition = nextTransition.string8)))
							transition = createTypeTransition(nextTransition, ASCII, 1);
						work.fixedBuf[fixedPos++] = curOffset;
					}
				} else {
					transition = nextTransition.string16 || createTypeTransition(nextTransition, UTF8, 2);
					work.fixedView.setUint16(fixedPos, curOffset, true);
					fixedPos += 2;
				}
				break;
			}

			case 'object': {
				if (value && value.constructor === Date) {
					transition = nextTransition.date64 || createTypeTransition(nextTransition, DATE, 8);
					work.fixedView.setFloat64(fixedPos, value.getTime(), true);
					fixedPos += 8;
				} else if (value) {
					queuedReferences.push(key, value, keyIndex);
				} else {
					// null
					const any = _anyTypeFixed(work, nextTransition, fixedPos, -10);
					if (any !== null) {
						transition = any;
						fixedPos = _anyPos;
					} else {
						queuedReferences.push(key, null, keyIndex);
					}
				}
				break;
			}

			case 'boolean':
				transition = nextTransition.num8 || nextTransition.ascii8 ||
					createTypeTransition(nextTransition, NUMBER, 1);
				work.fixedBuf[fixedPos++] = value ? 0xf9 : 0xf8;
				break;

			case 'undefined': {
				const any = _anyTypeFixed(work, nextTransition, fixedPos, -9);
				if (any !== null) {
					transition = any;
					fixedPos = _anyPos;
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

	// Queued objects/null/undefined — their fixed bytes (offsets into ref section)
	// follow the primitive fixed bytes.
	for (let i = 0, l = queuedReferences.length; i < l;) {
		const key       = queuedReferences[i++];
		const value     = queuedReferences[i++];
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

		if (fixedPos + 4 > work.fixedBuf.length) _growFixed(work, fixedPos + 4);

		if (value != null) {
			const encoded = encodeNested(value);
			const curOffset = refsPos;
			if (refsPos + encoded.length > work.refsBuf.length) _growRefs(work, encoded.length);
			work.refsBuf.set(encoded, refsPos);
			refsPos += encoded.length;

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
			if (size === 2) { work.fixedView.setUint16(fixedPos, curOffset, true); fixedPos += 2; }
			else            { work.fixedView.setUint32(fixedPos, curOffset, true); fixedPos += 4; }
		} else {
			// null or undefined sentinel
			transition = nextTransition.object16 || createTypeTransition(nextTransition, OBJECT_DATA, 2);
			work.fixedView.setInt16(fixedPos, value === null ? -10 : -9, true);
			fixedPos += 2;
		}
		keyIndex++;
	}

	// Build/retrieve structure definition from the transition chain.
	let recordId = transition[RECORD_SYMBOL];
	if (recordId == null) {
		recordId = typedStructs.length;
		const structure = [];
		let t = transition;
		while (t.__type !== undefined) {
			const type = t.__type;
			const size = t.__size;
			const keyTrans = t.__parent;
			const entry = [type, size, keyTrans.key];
			if (keyTrans.enumerationOffset) entry.push(keyTrans.enumerationOffset);
			structure.push(entry);
			t = keyTrans.parent;
		}
		structure.reverse();
		transition[RECORD_SYMBOL] = recordId;
		typedStructs[recordId] = structure;
		structureUpdated = true;
	}

	if (structureUpdated && packr._onStructureAdded) packr._onStructureAdded();

	// Assemble: [header][fixedSection][refsSection] — one allocation total.
	const totalSize = headerSize + fixedPos + refsPos;
	const result = new Uint8Array(totalSize);
	_writeHeader(result, recordId, headerSize);
	result.set(work.fixedBuf.subarray(0, fixedPos), headerSize);
	if (refsPos > 0) result.set(work.refsBuf.subarray(0, refsPos), headerSize + fixedPos);
	return result;
}

/**
 * Decode a random-access struct.
 *
 * Designed to be assigned to a Packr/Unpackr instance as `_readStruct`.  Call
 * via `unpackr._readStruct(src, pos, end)` so that `this === unpackr`, or
 * via `readStruct.call(unpackr, src, pos, end)` from the standalone path.
 *
 * @param {Uint8Array} src
 * @param {number} position  - byte offset of the struct header in src
 * @param {number} srcEnd    - exclusive end byte
 * @returns lazy object with property getters
 */
export function readStruct(src, position, srcEnd) {
	const unpackr = this;
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
						// Prefer msgpackr's unpack(src, {start, end}) when available — it dispatches
						// struct bytes through the registered _readStruct hook, supporting nested
						// structs inside arrays/records.  Falls back to _decodeSliceDirect for
						// base classes that don't support struct hooks (e.g. cbor-x today).
						if (typeof unpackr.unpack === 'function' && unpackr.constructor &&
							unpackr.constructor.SUPPORTS_STRUCT_HOOKS) {
							currentSource = source;
							try {
								return unpackr.unpack(source.bytes, { start: ref + refStart, end: end + refStart });
							} finally {
								currentSource = null;
							}
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
	let named = sharedData.get('named') || [];
	let typed = sharedData.get('typed') || [];
	if (Object.isFrozen(typed)) typed = typed.map(s => s.slice(0));

	// Reload named structures so msgpackr's length tracking stays in sync.
	// Clearing transitions forces msgpackr to rebuild them and update lastNamedStructuresLength.
	// Unfreeze elements since msgpackr lazily adds a `read` property to each structure entry.
	const prevStructures = this.structures;
	this.structures = named.map(s => Object.isFrozen(s) ? s.slice() : s);
	this.structures.sharedLength = named.length;
	if (prevStructures && prevStructures.transitions) {
		// Mark as needing transition rebuild so msgpackr resets lastNamedStructuresLength
		delete this.structures.transitions;
	}

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
