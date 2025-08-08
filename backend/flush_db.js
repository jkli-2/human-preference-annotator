const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Annotation = require('./models/Annotation');
const Annotator = require('./models/Annotator');

dotenv.config({ path: __dirname + '/.env' });

async function flushDB() {
  await mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });

  await Annotation.deleteMany({});
  await Annotator.deleteMany({});

  console.log('All records deleted from Annotation and Annotator collections.');
  process.exit();
}

flushDB();
