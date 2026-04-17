const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get("/", (req, res) => {
  res.send("OK");
});

app.get("/init", async (req, res) => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      completed BOOLEAN DEFAULT FALSE
    )
  `);
  res.send("DB ready");
});

app.get("/todos", async (req, res) => {
  const result = await pool.query("SELECT * FROM todos");
  res.json(result.rows);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
