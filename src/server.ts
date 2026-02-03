import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import https from "https";
import { parseSantanderPDF } from "./pdfParser.js";

const upload = multer({ dest: "uploads/" });
const app = express();

app.use(cors());
app.use(express.json());

/* ======================
   HEALTH CHECK
====================== */
app.get("/health", (_, res) => {
  res.send("OK");
});

/* ======================
   PARSE VIA UPLOAD
====================== */
app.post("/parse", upload.single("file"), async (req, res) => {
  try {
    const resultado = await parseSantanderPDF(req.file!.path);
    res.json(resultado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao processar PDF" });
  }
});

/* ======================
   PARSE FROM GITHUB
====================== */
app.post("/parse-from-github", async (req, res) => {
  try {
    const { fileName } = req.body;

    if (!fileName) {
      return res.status(400).json({
        error: "Informe o nome do arquivo (ex: faturajaneiro.pdf)",
      });
    }

    // 🔴 TROQUE PARA O SEU GITHUB
    const GITHUB_RAW_BASE =
      "https://raw.githubusercontent.com/SEU-USUARIO/SEU-REPO/main/pdfs";

    const fileUrl = `${GITHUB_RAW_BASE}/${fileName}`;
    const tempPath = path.join("uploads", fileName);

    const file = fs.createWriteStream(tempPath);

    https.get(fileUrl, (response) => {
      if (response.statusCode !== 200) {
        return res
          .status(404)
          .json({ error: "Arquivo não encontrado no GitHub" });
      }

      response.pipe(file);

      file.on("finish", async () => {
        file.close();

        try {
          const resultado = await parseSantanderPDF(tempPath);
          fs.unlinkSync(tempPath);
          res.json(resultado);
        } catch (err) {
          console.error(err);
          res.status(500).json({ error: "Erro ao processar PDF" });
        }
      });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro inesperado" });
  }
});

/* ======================
   SERVER
====================== */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Parser rodando na porta ${PORT}`);
});
