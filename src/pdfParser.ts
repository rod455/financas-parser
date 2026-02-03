import fs from "fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.js";

// @ts-ignore
pdfjs.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.js";

const LIMITE_COLUNA_X = 300;

export interface Transacao {
  cartao: string;
  titular: string;
  final: string;
  descricao: string;
  valor: number;
  page: number;
}

export interface ResultadoParser {
  totalGeral: number;
  totalPorCartao: Record<string, number>;
  transacoes: Transacao[];
}

interface ItemTexto {
  text: string;
  x: number;
  y: number;
  page: number;
}

function normalizarValor(valor: string): number {
  return parseFloat(
    valor.replace("R$", "").replace(/\./g, "").replace(",", ".").trim()
  );
}

function ordenar(itens: ItemTexto[]) {
  return itens.sort((a, b) => b.y - a.y || a.x - b.x);
}

function extrairCartao(texto: string) {
  const match = texto.match(/@?\s*([A-Z ]+)\s+-\s+.*?(\d{4})$/);
  if (!match) return null;
  return { titular: match[1].trim(), final: match[2] };
}

export async function parseSantanderPDF(
  caminho: string
): Promise<ResultadoParser> {
  const data = new Uint8Array(fs.readFileSync(caminho));
  const pdf = await pdfjs.getDocument({ data }).promise;

  const itens: ItemTexto[] = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();

    content.items.forEach((i: any) => {
      if (!i.str?.trim()) return;
      itens.push({
        text: i.str.trim(),
        x: i.transform[4],
        y: i.transform[5],
        page: p
      });
    });
  }

  const esquerda = ordenar(itens.filter(i => i.x < LIMITE_COLUNA_X));
  const direita = ordenar(itens.filter(i => i.x >= LIMITE_COLUNA_X));

  const totalPorCartao: Record<string, number> = {};
  const transacoes: Transacao[] = [];

  function processar(coluna: ItemTexto[]) {
    let cartaoAtual: any = null;

    for (const linha of coluna) {
      const cartao = extrairCartao(linha.text);
      if (cartao) {
        cartaoAtual = cartao;
        const chave = `${cartao.titular} - ${cartao.final}`;
        if (!totalPorCartao[chave]) totalPorCartao[chave] = 0;
        continue;
      }

      if (!cartaoAtual) continue;

      const matchValor = linha.text.match(/R\$\s*[\d.,]+/);
      if (!matchValor) continue;

      const valor = normalizarValor(matchValor[0]);
      const chave = `${cartaoAtual.titular} - ${cartaoAtual.final}`;
      totalPorCartao[chave] += valor;

      transacoes.push({
        cartao: chave,
        titular: cartaoAtual.titular,
        final: cartaoAtual.final,
        descricao: linha.text.replace(matchValor[0], "").trim(),
        valor,
        page: linha.page
      });
    }
  }

  processar(esquerda);
  processar(direita);

  return {
    totalGeral: Object.values(totalPorCartao).reduce((a, b) => a + b, 0),
    totalPorCartao,
    transacoes
  };
}

