import express from "express";
import multer from "multer";
import cors from "cors";
import { parseSantanderPDF } from "./pdfParser";

const upload = multer({ dest: "uploads/" });
const app = express();

app.use(cors());

app.post("/parse", upload.single("file"), async (req, res) => {
  try {
    const resultado = await parseSantanderPDF(req.file!.path);
    res.json(resultado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao processar PDF" });
  }
});

app.get("/health", (_, res) => {
  res.send("OK");
});

app.listen(3000, () => {
  console.log("🚀 Parser rodando na porta 3000");
});
