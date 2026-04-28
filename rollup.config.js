export default {
    input: 'index.js',
    output: {
        file: 'dist/node.cjs',
        format: 'cjs',
        sourcemap: true,
    },
    external: ['msgpackr', 'cbor-x'],
};
