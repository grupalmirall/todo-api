const express = require("express");
const { Pool } = require("pg");
const multer = require("multer");
const { PDFDocument } = require("pdf-lib");

const app = express();
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Ruta test
app.get("/", (req, res) => {
  res.send("OK");
});

// Inicialitzar base de dades
app.get("/init", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todos (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        completed BOOLEAN DEFAULT FALSE
      )
    `);
    res.send("DB ready");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error init DB");
  }
});

// Llistar tasques
app.get("/todos", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM todos");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching todos");
  }
});

// Dividir PDF
app.post("/split-pdf", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send("No PDF file uploaded");
    }

    const pdfBytes = req.file.buffer;
    const pdfDoc = await PDFDocument.load(pdfBytes);

    const totalPages = pdfDoc.getPageCount();
    const resultFiles = [];

    for (let i = 0; i < totalPages; i++) {
      const newPdf = await PDFDocument.create();
      const [page] = await newPdf.copyPages(pdfDoc, [i]);
      newPdf.addPage(page);

      const newPdfBytes = await newPdf.save();
      resultFiles.push(Buffer.from(newPdfBytes).toString("base64"));
    }

    res.json({
      pages: resultFiles.length,
      files: resultFiles
    });

  } catch (error) {
    console.error(error);
    res.status(500).send("Error processing PDF");
  }
});

// Arrancar servidor
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
