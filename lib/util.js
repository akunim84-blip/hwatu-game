const crypto = require('crypto');
function rngInt(n) { return crypto.randomInt(n); }
function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand ? Math.floor(rand() * (i + 1)) : rngInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
module.exports = { shuffle, rngInt };
