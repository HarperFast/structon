import {
	writeStruct, writeStructInPlace,
	readStruct, onLoadedStructures, prepareStructures, saveState,
	SOURCE_SYMBOL,
} from './struct.js';

/**
 * Creates a class that extends `BaseClass` (msgpackr's Packr or cbor-x's Encoder)
 * and adds random-access struct encoding/decoding.
 *
 * Two encoding paths are supported:
 *
 *  - **Fast path** (BaseClass advertises `SUPPORTS_STRUCT_HOOKS`):  structon
 *    sets per-instance hook methods (`_writeStruct`, `_readStruct`, …) which
 *    the BaseClass's encode/decode pipeline dispatches to.  The struct is
 *    written directly into the BaseClass's shared target buffer with no
 *    intermediate allocations.
 *
 *  - **Standalone path** (any other base):  structon wraps `encode`/`decode`
 *    and uses its own pre-allocated work buffers, returning a fresh
 *    `Uint8Array` per encode call.
 *
 * The on-the-wire binary format is identical in both paths.
 *
 * @param {class} BaseClass  - msgpackr Packr / Encoder or cbor-x Encoder
 * @returns {class} Structon subclass
 */
export function createStructon(BaseClass) {
	const _baseDecode = BaseClass.prototype.decode;
	const _baseUnpack = BaseClass.prototype.unpack || null;

	// A BaseClass advertises hook support via a static `SUPPORTS_STRUCT_HOOKS`
	// flag (set by msgpackr ≥ 2.0.1, cbor-x post-update, etc.).  Walking the
	// prototype chain lets a Packr subclass be passed in unchanged.
	const fastPath = lookupStatic(BaseClass, 'SUPPORTS_STRUCT_HOOKS') === true;

	class Structon extends BaseClass {
		constructor(options = {}) {
			super(options);

			// Initialise typed structures state on this instance
			if (!this.typedStructs) this.typedStructs = [];

			if (fastPath) {
				// Set per-instance hook methods.  The BaseClass's encode/decode
				// pipeline picks these up automatically.
				this._writeStruct = writeStructInPlace;
				this._readStruct = readStruct;
				this._onLoadedStructures = onLoadedStructures;
				this._onSaveState = saveState;
				this._prepareStructures = prepareStructures;
				return;
			}

			// Standalone path: wrap encode (set as own property by the base ctor).
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

		decode(source) {
			// Fast path: let the BaseClass's checkedRead dispatch via _readStruct.
			if (fastPath) return _baseDecode.call(this, source);

			// Standalone path: intercept top-level struct bytes ourselves.
			const src = toUint8Array(source);
			if (src.length > 0 && src[0] >= 0x20 && src[0] < 0x40) {
				const recordId = peekRecordId(src);
				this._ensureTypedStructures();
				if (recordId !== -1 && this.typedStructs && this.typedStructs[recordId]) {
					return readStruct.call(this, src, 0, src.length);
				}
			}
			return _baseDecode.call(this, source);
		}

		/**
		 * Decode bytes from src[start..end) — used by readStruct's OBJECT_DATA
		 * getters when the base class doesn't support unpack(src, {start, end})
		 * (e.g. cbor-x without hook support).
		 */
		_decodeSliceDirect(src, start, end) {
			if (end > start && src[start] >= 0x20 && src[start] < 0x40) {
				const slice = src.subarray ? src.subarray(start, end) : src.slice(start, end);
				const recordId = peekRecordId(slice);
				if (recordId !== -1 && this.typedStructs && this.typedStructs[recordId]) {
					return readStruct.call(this, slice, 0, slice.length);
				}
			}
			if (_baseUnpack) return _baseUnpack.call(this, src, { start, end });
			const slice2 = src.subarray ? src.subarray(start, end) : src.slice(start, end);
			return _baseDecode.call(this, slice2);
		}

		_ensureTypedStructures() {
			if (this.typedStructs && this.typedStructs.transitions) return;
			this._loadStructures();
		}

		_loadStructures() {
			let sharedData;
			if (typeof this.getStructures === 'function') sharedData = this.getStructures();
			else if (typeof this.getShared === 'function') sharedData = this.getShared();
			if (sharedData) onLoadedStructures.call(this, sharedData);
		}

		_saveTypedStructures() {
			if (typeof this.saveStructures === 'function') {
				const structures = prepareStructures(this.structures || [], this);
				this.saveStructures(structures);
			} else if (typeof this.saveShared === 'function') {
				this.saveShared({
					structures: this.structures || [],
					typedStructs: this.typedStructs,
				});
			}
		}

		_mergeStructures(loadedStructures) {
			// On the fast path the BaseClass already calls _onLoadedStructures
			// itself; only the standalone path needs to invoke it manually.
			if (!fastPath && loadedStructures) onLoadedStructures.call(this, loadedStructures);
			if (super._mergeStructures) return super._mergeStructures(loadedStructures);
		}

		clearSharedData() {
			if (super.clearSharedData) super.clearSharedData();
			this.typedStructs = [];
		}
	}

	return Structon;
}

function lookupStatic(cls, name) {
	let c = cls;
	while (c) {
		if (Object.prototype.hasOwnProperty.call(c, name)) return c[name];
		c = Object.getPrototypeOf(c);
	}
	return undefined;
}

function toUint8Array(source) {
	if (source instanceof Uint8Array) return source;
	if (typeof Buffer !== 'undefined' && Buffer.isBuffer(source)) return source;
	if (source instanceof ArrayBuffer) return new Uint8Array(source);
	return new Uint8Array(source);
}

function peekRecordId(src) {
	if (src.length < 1) return -1;
	let id = src[0] - 0x20;
	if (id < 24) return id;
	switch (id) {
		case 24: return src.length > 1 ? src[1] : -1;
		case 25: return src.length > 2 ? src[1] + (src[2] << 8) : -1;
		case 26: return src.length > 3 ? src[1] + (src[2] << 8) + (src[3] << 16) : -1;
		case 27: return src.length > 4 ? src[1] + (src[2] << 8) + (src[3] << 16) + (src[4] << 24) : -1;
		default: return -1;
	}
}

export { SOURCE_SYMBOL };
