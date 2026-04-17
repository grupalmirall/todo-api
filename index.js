const express = require("express");
const { Pool } = require("pg");
const multer = require("multer");
const { PDFDocument } = require("pdf-lib");
const archiver = require("archiver");

const app = express();
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get("/", (req, res) => {
  res.send(`
    <!doctype html>
    <html lang="ca">
      <head>
        <meta charset="utf-8" />
        <title>Dividir PDF</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 700px;
            margin: 40px auto;
            padding: 20px;
          }
          .box {
            border: 1px solid #ddd;
            border-radius: 10px;
            padding: 24px;
          }
          button {
            padding: 10px 16px;
            font-size: 16px;
            cursor: pointer;
          }
          input {
            margin: 12px 0;
          }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>Dividir PDF</h1>
          <p>Selecciona un PDF i el sistema et descarregarà un ZIP amb una pàgina per fitxer.</p>

          <form action="/split-pdf" method="post" enctype="multipart/form-data">
            <input type="file" name="file" accept="application/pdf" required />
            <br />
            <button type="submit">Dividir PDF</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

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

app.get("/todos", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM todos");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching todos");
  }
});

app.post("/split-pdf", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send("No PDF file uploaded");
    }

    const pdfBytes = req.file.buffer;
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="pdf-dividit.zip"');

    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", (err) => {
      console.error(err);
      if (!res.headersSent) {
        res.status(500).send("Error creating ZIP");
      } else {
        res.end();
      }
    });

    archive.pipe(res);

    for (let i = 0; i < totalPages; i++) {
      const newPdf = await PDFDocument.create();
      const [page] = await newPdf.copyPages(pdfDoc, [i]);
      newPdf.addPage(page);

      const newPdfBytes = await newPdf.save();
      archive.append(Buffer.from(newPdfBytes), { name: `pagina-${i + 1}.pdf` });
    }

    await archive.finalize();
  } catch (error) {
    console.error(error);
    res.status(500).send("Error processing PDF");
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
