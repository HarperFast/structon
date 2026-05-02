import {
	writeStruct, writeStructInPlace,
	readStruct, onLoadedStructures, prepareStructures, saveState,
	SOURCE_SYMBOL,
} from './struct.js';

// Track which BaseClasses have had hooks registered so we don't re-register.
const _hooksRegistered = new WeakSet();

/**
 * Creates a class that extends `BaseClass` (msgpackr's Packr or cbor-x's Encoder)
 * and adds random-access struct encoding/decoding.
 *
 * Two encoding paths are supported:
 *
 *  - **Fast path** (msgpackr ≥ 2.0.1 with `setWriteStructSlots` / `setReadStruct`):
 *    structon registers its writeStruct as a hook in msgpackr's encoder so that
 *    plain objects are written directly into msgpackr's shared target buffer.
 *    No intermediate allocations.  Detected automatically by checking for
 *    `BaseClass.setWriteStructSlots`.
 *
 *  - **Standalone path** (cbor-x, msgpackr without hooks):
 *    structon wraps `encode`/`decode` and uses its own pre-allocated work
 *    buffers, returning a fresh Uint8Array per encode call.
 *
 * Either way, the binary format is identical to msgpackr's struct.js.
 *
 * @param {class} BaseClass  - msgpackr Packr / Encoder or cbor-x Encoder
 * @returns {class} Structon subclass
 */
export function createStructon(BaseClass) {
	const _baseDecode = BaseClass.prototype.decode;
	const _baseUnpack = BaseClass.prototype.unpack || null;

	// Detect the msgpackr fast path: msgpackr ≥ 2.0.1 exposes setWriteStructSlots
	// as a static on Packr (and setReadStruct on Unpackr).
	const setWriteStructSlots = BaseClass.setWriteStructSlots;
	const setReadStruct = findStaticOnChain(BaseClass, 'setReadStruct');
	const fastPath = typeof setWriteStructSlots === 'function' && typeof setReadStruct === 'function';

	if (fastPath && !_hooksRegistered.has(BaseClass)) {
		setWriteStructSlots(writeStructInPlace, prepareStructures);
		setReadStruct(readStruct, onLoadedStructures, saveState);
		_hooksRegistered.add(BaseClass);
	}

	class Structon extends BaseClass {
		constructor(options = {}) {
			super(options);

			// Initialise typed structures state on this instance
			if (!this.typedStructs) this.typedStructs = [];

			if (fastPath) {
				// Opt this instance into struct encoding/decoding via the hooks.
				this._useStructEncoding = true;
				// No encode/decode wrappers needed — msgpackr's pipeline handles it.
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
			// Fast path: let msgpackr's checkedRead dispatch via the readStruct hook.
			if (this._useStructEncoding) return _baseDecode.call(this, source);

			// Standalone path: intercept top-level struct bytes ourselves.
			const src = toUint8Array(source);
			if (src.length > 0 && src[0] >= 0x20 && src[0] < 0x40) {
				const recordId = peekRecordId(src);
				this._ensureTypedStructures();
				if (recordId !== -1 && this.typedStructs && this.typedStructs[recordId]) {
					return readStruct(src, 0, src.length, this);
				}
			}
			return _baseDecode.call(this, source);
		}

		/**
		 * Decode bytes from src[start..end) — used by readStruct's OBJECT_DATA
		 * getters when the base class doesn't support unpack(src, {start, end})
		 * (e.g. cbor-x).
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

		// Compatibility shim used by msgpackr's internal _mergeStructures path on
		// the standalone (non-fast) path.  On the fast path msgpackr now installs
		// onLoadedStructures via setReadStruct and calls it directly.
		_mergeStructures(loadedStructures) {
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

function findStaticOnChain(cls, name) {
	let c = cls;
	while (c) {
		if (typeof c[name] === 'function') return c[name];
		c = Object.getPrototypeOf(c);
	}
	return null;
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
