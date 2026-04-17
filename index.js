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
    .trim()
    .replace(/\s+/g, "_");
}

function extractWorkerDataFromPageText(pageText) {
  const text = pageText.replace(/\r/g, "");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const dniRegex = /\b([XYZ0-9][0-9A-Z]{7}[A-Z])\b/i;

  let rowLine = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes("TREBALLADOR/A") && line.includes("DNI")) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (dniRegex.test(lines[j])) {
          rowLine = lines[j];
          break;
        }
      }
      if (rowLine) break;
    }
  }

  if (!rowLine) {
    const match = text.match(
      /TREBALLADOR\/A[\s\S]{0,300}?DNI\s+([A-ZÀ-ÿ,' -]+?)\s+PEON\b[\s\S]{0,100}?\b([XYZ0-9][0-9A-Z]{7}[A-Z])\b/i
    );
    if (match) {
      return {
        name: sanitizeFilePart(match[1]),
        dni: sanitizeFilePart(match[2].toUpperCase())
      };
    }
    return null;
  }

  const dniMatch = rowLine.match(dniRegex);
  if (!dniMatch) return null;

  const dni = dniMatch[1].toUpperCase();
  const dniIndex = rowLine.indexOf(dni);
  const beforeDni = rowLine.slice(0, dniIndex).trim();

  let name = beforeDni;

  if (beforeDni.includes(" PEON ")) {
    name = beforeDni.split(" PEON ")[0].trim();
  } else if (beforeDni.endsWith(" PEON")) {
    name = beforeDni.slice(0, -5).trim();
  } else {
    const tokens = beforeDni.split(/\s+/);
    const monthSet = new Set([
      "GEN", "FEB", "MAR", "ABR", "MAI", "JUN",
      "JUL", "AGO", "SET", "OCT", "NOV", "DES",
      "ENE", "APR", "MAY", "AUG", "SEP", "DEC"
    ]);

    let cutIndex = tokens.length;
    for (let i = 0; i < tokens.length; i++) {
      if (
        monthSet.has(tokens[i].toUpperCase()) ||
        /^\d{1,2}$/.test(tokens[i]) ||
        /^\d+$/.test(tokens[i])
      ) {
        cutIndex = i - 1;
        break;
      }
    }

    if (cutIndex > 0) {
      name = tokens.slice(0, cutIndex).join(" ").trim();
    }
  }

  if (!name) return null;

  return {
    name: sanitizeFilePart(name),
    dni: sanitizeFilePart(dni)
  };
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
      .join("\n");

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
        fileName = `${worker.name}_${worker.dni}.pdf`;
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
