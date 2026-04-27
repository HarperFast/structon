import {
	writeStruct, readStruct,
	onLoadedStructures, prepareStructures,
	SOURCE_SYMBOL,
} from './struct.js';

/**
 * Creates a class that extends `BaseClass` (msgpackr's Packr or cbor-x's Encoder)
 * and adds random-access struct encoding/decoding.
 *
 * The struct binary format is identical to msgpackr's struct.js so data is
 * interoperable between both implementations.
 *
 * For top-level plain objects the encoder writes a compact fixed-width struct
 * header plus a variable-length ref section.  All inner nested-object data is
 * serialized by the base class, so the correct inner format (msgpack or cbor)
 * is used automatically depending on which class you extend.
 *
 * @param {class} BaseClass  - msgpackr Packr / Encoder or cbor-x Encoder
 * @returns {class} Structon subclass
 *
 * @example
 * import { Packr } from 'msgpackr';
 * import { createStructon } from 'structon';
 * const Structon = createStructon(Packr);
 * const s = new Structon({ structures: [] });
 * const encoded = s.encode({ name: 'Alice', age: 30 });
 * const decoded = s.decode(encoded);
 * console.log(decoded.name); // 'Alice'  — random access, zero-copy lazy
 */
export function createStructon(BaseClass) {
	// Capture base-class decode/unpack at class-creation time so we can call
	// them without risking infinite recursion through our overrides.
	const _baseDecode = BaseClass.prototype.decode;
	const _baseUnpack = BaseClass.prototype.unpack || null;

	class Structon extends BaseClass {
		constructor(options = {}) {
			// Disable msgpackr's own randomAccessStructure hook so it doesn't
			// interfere with our struct handling.
			super({ ...options, randomAccessStructure: false });

			// Initialise typed structures state on this instance
			if (!this.typedStructs) this.typedStructs = [];

			// Both msgpackr's Packr and cbor-x's Encoder set encode as an OWN
			// property (closure) inside their constructor, so we must wrap it here
			// rather than on the prototype.
			if (Object.prototype.hasOwnProperty.call(this, 'encode')) {
				const _super = this.encode.bind(this);
				const self = this;
				this.encode = function structonEncode(value, encodeOptions) {
					return self._structonEncode(value, encodeOptions, _super);
				};
			}
		}

		_structonEncode(value, encodeOptions, superEncode) {
			if (value && typeof value === 'object' && value.constructor === Object) {
				const prevLen = this.typedStructs.length;
				let structuresUpdated = false;
				this._onStructureAdded = () => { structuresUpdated = true; };
				try {
					const encoded = writeStruct(value, v => this.encode(v), this);
					if (encoded !== null) {
						if (structuresUpdated || this.typedStructs.length !== prevLen) {
							this._saveTypedStructures();
						}
						return encoded;
					}
				} finally {
					this._onStructureAdded = null;
				}
			}
			return superEncode(value, encodeOptions);
		}

		// Override decode on the prototype (works for both msgpackr and cbor-x
		// since neither sets decode as an own property from their constructor).
		decode(source) {
			const src = toUint8Array(source);
			if (src.length > 0 && src[0] >= 0x20 && src[0] < 0x40) {
				// Parse record ID from header to confirm this is a known struct,
				// not a msgpack fixint that happens to be in 0x20-0x3f range.
				const recordId = peekRecordId(src);
				this._ensureTypedStructures();
				if (recordId !== -1 && this.typedStructs && this.typedStructs[recordId]) {
					return readStruct(src, 0, src.length, this);
				}
			}
			// Delegate to the true base-class implementation (not our override)
			return _baseDecode.call(this, source);
		}

		/**
		 * Decode bytes from src[start..end) — called from readStruct getters for
		 * OBJECT_DATA fields.  Checks for nested struct bytes, then falls through
		 * to the base decoder.
		 */
		_decodeSliceDirect(src, start, end) {
			if (end > start && src[start] >= 0x20 && src[start] < 0x40) {
				const slice = src.subarray ? src.subarray(start, end) : src.slice(start, end);
				const recordId = peekRecordId(slice);
				if (recordId !== -1 && this.typedStructs && this.typedStructs[recordId]) {
					return readStruct(slice, 0, slice.length, this);
				}
			}
			if (_baseUnpack) return _baseUnpack.call(this, src, { start, end });
			const slice2 = src.subarray ? src.subarray(start, end) : src.slice(start, end);
			return _baseDecode.call(this, slice2);
		}

		/** Load shared typed structures if not yet initialised. */
		_ensureTypedStructures() {
			if (this.typedStructs && this.typedStructs.transitions) return;
			this._loadStructures();
		}

		_loadStructures() {
			let sharedData;
			// msgpackr API
			if (typeof this.getStructures === 'function') sharedData = this.getStructures();
			// cbor-x API
			else if (typeof this.getShared === 'function') sharedData = this.getShared();
			if (sharedData) onLoadedStructures.call(this, sharedData);
		}

		_saveTypedStructures() {
			// msgpackr API: saveStructures receives a Map(named, typed) or array
			if (typeof this.saveStructures === 'function') {
				const structures = prepareStructures(
					this.structures || [],
					this
				);
				this.saveStructures(structures);
			}
			// cbor-x API: saveShared receives a plain object
			else if (typeof this.saveShared === 'function') {
				this.saveShared({
					structures: this.structures || [],
					typedStructs: this.typedStructs,
				});
			}
		}

		// Compatibility shim used by msgpackr's internal _mergeStructures path
		_mergeStructures(loadedStructures) {
			if (loadedStructures) onLoadedStructures.call(this, loadedStructures);
			if (super._mergeStructures) return super._mergeStructures(loadedStructures);
		}

		clearSharedData() {
			if (super.clearSharedData) super.clearSharedData();
			this.typedStructs = [];
		}
	}

	return Structon;
}

function toUint8Array(source) {
	if (source instanceof Uint8Array) return source;
	if (typeof Buffer !== 'undefined' && Buffer.isBuffer(source)) return source;
	if (source instanceof ArrayBuffer) return new Uint8Array(source);
	return new Uint8Array(source);
}

// Parse the struct record ID from the first byte(s) of src without fully
// decoding it.  Returns -1 if the buffer is too short for the header.
function peekRecordId(src) {
	if (src.length < 1) return -1;
	let id = src[0] - 0x20;
	if (id < 24) return id; // 1-byte header, record IDs 0-15 (0x20-0x2f) + 16-23 via 0x30-0x37
	switch (id) {
		case 24: return src.length > 1 ? src[1] : -1;
		case 25: return src.length > 2 ? src[1] + (src[2] << 8) : -1;
		case 26: return src.length > 3 ? src[1] + (src[2] << 8) + (src[3] << 16) : -1;
		case 27: return src.length > 4 ? src[1] + (src[2] << 8) + (src[3] << 16) + (src[4] << 24) : -1;
		default: return -1;
	}
}

export { SOURCE_SYMBOL };
