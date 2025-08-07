const mongoose = require('mongoose');
const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config({ path: __dirname + '/.env' });

const Annotation = require('./models/Annotation');

async function exportData() {
  await mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });

  const annotations = await Annotation.find({});
  const output = annotations.map(entry => ({
    annotator_id: entry.annotatorId,
    pair_id: entry.pairId,
    response: entry.response,
    timestamp: entry.timestamp
  }));

  fs.writeFileSync('annotations_export.json', JSON.stringify(output, null, 2));
  console.log(`Exported ${output.length} annotations to annotations_export.json`);

  mongoose.disconnect();
}

exportData();
