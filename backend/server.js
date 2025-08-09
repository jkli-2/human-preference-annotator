const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config({ path: __dirname + "/.env" });

if (!process.env.ADMIN_PASSWORD) {
    console.error("Missing ADMIN_PASSWORD in environment variables.");
    process.exit(1);
}

if (!process.env.ADMIN_TOKEN) {
  console.error("Missing ADMIN_TOKEN in environment variables.");
  process.exit(1);
}

const apiRoutes = require("./routes/api");
const app = express();
app.use(cors());
app.use(express.json());

mongoose
    .connect(process.env.MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
    })
    .then(() => console.log("MongoDB connected"));

app.use("/api", apiRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
