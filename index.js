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

function sanitizeFilePart(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w,\- ]+/g, "")
    .replace(/\bCATEGORIA\b/gi, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/^CATEGORIA_+/i, "")
    .replace(/^_+|_+$/g, "");
}

function extractWorkerDataFromPageText(pageText) {
  const text = String(pageText || "");
  const flatText = text.replace(/\r/g, " ").replace(/\n/g, " ").replace(/\s+/g, " ").trim();

  const dniRegex = /\b([XYZ0-9][0-9A-Z]{7}[A-Z])\b/i;

  const mainMatch = flatText.match(
    /TREBALLADOR\/A.*?DNI\s+(.+?)\s+PEON\s+\d{1,2}\s+[A-Z]{3}\s+\d{2}\s+([XYZ0-9][0-9A-Z]{7}[A-Z])\b/i
  );

  if (mainMatch) {
    return {
      name: sanitizeFilePart(mainMatch[1]),
      dni: sanitizeFilePart(mainMatch[2].toUpperCase())
    };
  }

  const dniMatch = flatText.match(dniRegex);

  const topNameMatch = flatText.match(
    /^([A-ZÀ-ÿ,' -]{4,}?)\s+(?:AV|CL|CM|MS|LG|PZ)\b/
  );

  if (topNameMatch && dniMatch) {
    return {
      name: sanitizeFilePart(topNameMatch[1]),
      dni: sanitizeFilePart(dniMatch[1].toUpperCase())
    };
  }

  return null;
}

async function extractTextsPerPage(pdfBuffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true
  });

  const pdf = await loadingTask.promise;
  const pages = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");

    pages.push(text);
  }

  return pages;
}

app.get("/", (req, res) => {
  res.send(`
    <!doctype html>
    <html lang="ca">
      <head>
        <meta charset="utf-8" />
        <title>Dividir nòmines PDF</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 720px;
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
          p {
            line-height: 1.5;
          }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>Dividir nòmines PDF</h1>
          <p>Puja un PDF de nòmines i es descarregarà un ZIP amb un PDF per treballador, amb nom automàtic.</p>
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
    const pageTexts = await extractTextsPerPage(pdfBytes);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="nomines-dividides.zip"');

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
      const pageText = pageTexts[i] || "";
      const worker = extractWorkerDataFromPageText(pageText);

      let fileName = `pagina-${i + 1}.pdf`;

      if (worker?.name && worker?.dni) {
        const cleanName = worker.name.replace(/^CATEGORIA_+/i, "");
        fileName = `${cleanName}_${worker.dni}.pdf`;
      }

      archive.append(Buffer.from(newPdfBytes), { name: fileName });
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
