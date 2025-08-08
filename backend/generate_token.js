const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const tokenFile = path.join(__dirname, 'data/tokens.json');
const tokens = JSON.parse(fs.readFileSync(tokenFile));
const annotatorId = process.argv[2];

if (!annotatorId) {
  console.error('Please provide an annotator ID');
  process.exit(1);
}

if (tokens.some(entry => entry.annotatorId === annotatorId)) {
  console.error('Annotator ID already exists');
  process.exit(1);
}

const newToken = randomUUID().slice(0, 8);
tokens.push({ token: newToken, annotatorId });
fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2));
console.log(`Generated token for ${annotatorId}: ${newToken}`);