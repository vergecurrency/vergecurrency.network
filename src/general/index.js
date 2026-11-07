'use strict';

const point = (measurement, fields) => ({ measurement, tags: { host: 'verge' }, fields });

async function collectGeneral({ rpc, influx }) {
  const [info, hash] = await Promise.all([
    rpc.send('getinfo'), rpc.send('getallnetworkhashps'),
  ]);
  // Current Verge exposes all five difficulties through getinfo. getdifficulty
  // only describes the selected algorithm and cannot replace these fields.
  await influx.write('verge', [
    point('difficulty', {
      x17: info.difficulty_x17, scrypt: info.difficulty_scrypt,
      groestl: info.difficulty_groestl, lyra2re: info.difficulty_lyra2re, blake: info.difficulty_blake,
    }),
    point('hashpower', { scrypt: hash.scrypt, groestl: hash.groestl, lyra2re: hash.lyra2re, x17: hash.x17, blake2s: hash.blake2s }),
  ]);
}

module.exports = { collectGeneral };
if (require.main === module) require('../runtime').runCli(['general']);
