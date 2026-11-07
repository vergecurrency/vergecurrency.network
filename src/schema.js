'use strict';

// Preserve the existing algorithm measurement names, tags, and numeric types.
// The historical Blake field differs between the two measurements.
const schemas = { verge: {
  difficulty: { x17: 'float', scrypt: 'float', groestl: 'float', lyra2re: 'float', blake: 'float' },
  hashpower: { scrypt: 'integer', groestl: 'integer', lyra2re: 'integer', x17: 'integer', blake2s: 'integer' },
} };

module.exports = { schemas };
