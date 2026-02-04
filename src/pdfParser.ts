// Parser de faturas do Santander - Versão 9.0
// CORRIGIDO: Processa por PÁGINA, mantendo contexto do cartão entre colunas da mesma página
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export interface RawTransaction {
  date: string;
  desc: string;
  val: number;
  card: string;
  owner: string;
  type: "Parcelamento" | "À Vista";
}

export interface ParseResult {
  month: string;
  monthLabel: string;
  transactions: RawTransaction[];
  totalFatura: number;
  vencimento: string;
}

const MONTHS_PT: Record<string, string> = {
  '01': 'Janeiro', '02': 'Fevereiro', '03': 'Março', '04': 'Abril',
  '05': 'Maio', '06': 'Junho', '07': 'Julho', '08': 'Agosto',
  '09': 'Setembro', '10': 'Outubro', '11': 'Novembro', '12': 'Dezembro',
};

function calcularMesReferencia(vencimento: string): { month: string; monthLabel: string } {
  const [, mes, ano] = vencimento.split('/');
  let mesRef = parseInt(mes, 10) - 1;
  let anoRef = parseInt(ano, 10);
  if (mesRef === 0) { mesRef = 12; anoRef -= 1; }
  const mesStr = mesRef.toString().padStart(2, '0');
  return {
    month: `${anoRef}-${mesStr}`,
    monthLabel: `${MONTHS_PT[mesStr]}/${anoRef.toString().slice(-2)}`,
  };
}

interface TextItem {
  text: string;
  x: number;
  y: number;
  page: number;
}

interface LineItem {
  text: string;
  x: number;
  y: number;
  page: number;
  column: 'left' | 'right';
}

// Limite para separar colunas (baseado na análise do PDF)
const COLUMN_THRESHOLD = 300;

async function extractTextItems(pdf: any): Promise<TextItem[]> {
  const items: TextItem[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();

    for (const item of textContent.items) {
      if ('str' in item && item.str.trim()) {
        const transform = (item as any).transform;
        items.push({
          text: item.str.trim(),
          x: transform[4],
          y: transform[5],
          page: pageNum,
        });
      }
    }
  }

  return items;
}

function groupIntoLines(items: TextItem[]): LineItem[] {
  // Agrupa por página, coluna e Y
  const groups = new Map<string, TextItem[]>();

  for (const item of items) {
    const column = item.x < COLUMN_THRESHOLD ? 'left' : 'right';
    const roundedY = Math.round(item.y / 3) * 3;
    const key = `${item.page}-${column}-${roundedY}`;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  const lines: LineItem[] = [];

  for (const [key, groupItems] of groups.entries()) {
    const [pageStr, column, yStr] = key.split('-');
    const page = parseInt(pageStr);
    const y = parseInt(yStr);

    // Ordena por X dentro da linha
    groupItems.sort((a, b) => a.x - b.x);
    
    const text = groupItems.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim();
    const minX = Math.min(...groupItems.map(i => i.x));

    if (text) {
      lines.push({ 
        text, 
        x: minX,
        y, 
        page, 
        column: column as 'left' | 'right' 
      });
    }
  }

  return lines;
}

// Ordena linhas: por página, depois coluna esquerda inteira, depois coluna direita inteira
// Dentro de cada coluna: de cima para baixo (Y decrescente)
function sortLinesByPageAndColumn(lines: LineItem[]): LineItem[] {
  return lines.sort((a, b) => {
    // Primeiro por página
    if (a.page !== b.page) return a.page - b.page;
    // Depois coluna esquerda antes da direita
    if (a.column !== b.column) return a.column === 'left' ? -1 : 1;
    // Dentro da coluna: de cima para baixo (Y maior = mais acima)
    return b.y - a.y;
  });
}

function parseCardHeader(line: string): { name: string; suffix: string; isRodrigoOrLuana: boolean } | null {
  // Padrão de cartão: XXXX XXXX ou similar com 4 dígitos no final
  const hasCardPattern = /[Xx]{4}.*[Xx]{4}|\d{4}\s*X+\s*X+\s*\d{4}/i.test(line);
  if (!hasCardPattern) return null;

  // Extrai os últimos 4 dígitos
  const suffixMatch = line.match(/(\d{4})(?:\s|$)/g);
  const suffix = suffixMatch ? suffixMatch[suffixMatch.length - 1].trim() : '0000';

  const upperLine = line.toUpperCase();
  const isRodrigo = upperLine.includes('RODRIGO');
  const isLuana = upperLine.includes('LUANA');

  let name = 'DESCONHECIDO';
  if (isRodrigo) {
    const match = line.match(/RODRIGO[A-Z\s]*/i);
    name = match ? match[0].trim() : 'RODRIGO';
  } else if (isLuana) {
    const match = line.match(/LUANA[A-Z\s]*/i);
    name = match ? match[0].trim() : 'LUANA';
  } else {
    const match = line.match(/^[@\s]*([A-Z][A-Z\s]+?)\s*[-–]/i);
    name = match ? match[1].trim() : 'OUTRO';
  }

  return { name, suffix, isRodrigoOrLuana: isRodrigo || isLuana };
}

function parseTransaction(line: string): { date: string; desc: string; valor: number; isParcela: boolean } | null {
  // Procura data no formato DD/MM
  const dateMatch = line.match(/(\d{2}\/\d{2})/);
  if (!dateMatch) return null;

  const date = dateMatch[1];
  const dateIndex = line.indexOf(date);
  let afterDate = line.substring(dateIndex + 5).trim();

  // Procura valor no formato XXX,XX ou X.XXX,XX
  const valorMatch = afterDate.match(/(-?[\d\.]+,\d{2})(?:\s+[\d\.]+,\d{2})?$/);
  if (!valorMatch) return null;

  const valorStr = valorMatch[1];
  const valor = parseFloat(valorStr.replace(/\./g, '').replace(',', '.'));

  // Ignora valores negativos (pagamentos/créditos)
  if (valor <= 0) return null;

  let desc = afterDate.substring(0, afterDate.lastIndexOf(valorStr)).trim();

  // Detecta parcelas (XX/XX no final da descrição)
  let isParcela = false;
  const parcelaMatch = desc.match(/\s+(\d{2}\/\d{2})$/);
  if (parcelaMatch) {
    desc = desc.substring(0, desc.lastIndexOf(parcelaMatch[1])).trim() + ` (${parcelaMatch[1]})`;
    isParcela = true;
  }

  // Limpa descrição
  desc = desc.replace(/^\d+\s+/, '').replace(/^[@\)\s]+/, '').trim();

  if (desc.length < 3) return null;
  if (/^[\d,\.]+$/.test(desc)) return null;
  if (/^\d+\/\d+$/.test(desc)) return null;

  return { date, desc, valor, isParcela };
}

export async function parseSantanderPDF(file: File): Promise<ParseResult> {
  console.log("=== Parser v9.0 - Processamento por página com contexto entre colunas ===");
  console.log("Arquivo:", file.name);

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await (pdfjsLib.getDocument({ data: arrayBuffer, useSystemFonts: true })).promise;

  console.log("Páginas:", pdf.numPages);

  const textItems = await extractTextItems(pdf);
  console.log("Itens de texto:", textItems.length);

  const allLines = groupIntoLines(textItems);
  const sortedLines = sortLinesByPageAndColumn(allLines);
  console.log("Linhas processadas:", sortedLines.length);

  // Encontra vencimento
  let vencimento = "";
  for (const line of sortedLines) {
    const match = line.text.match(/[Vv]encimento[:\s]+(\d{2}\/\d{2}\/\d{4})/);
    if (match) {
      vencimento = match[1];
      console.log("Vencimento:", vencimento);
      break;
    }
  }

  // Estrutura para guardar info do cartão atual
  interface CardInfo {
    name: string;
    suffix: string;
    isAllowed: boolean;
    section: "Parcelamento" | "À Vista";
  }

  const transactions: RawTransaction[] = [];
  
  // Processa linha por linha, mantendo o cartão atual
  let currentCard: CardInfo | null = null;

  // Log dos cartões encontrados
  console.log("\n=== CARTÕES ENCONTRADOS ===");

  for (let i = 0; i < sortedLines.length; i++) {
    const line = sortedLines[i];
    const lineText = line.text;

    // Verifica se é header de cartão
    const cardInfo = parseCardHeader(lineText);
    if (cardInfo) {
      currentCard = {
        name: cardInfo.name,
        suffix: cardInfo.suffix,
        isAllowed: cardInfo.isRodrigoOrLuana,
        section: "À Vista", // Reset para cada novo cartão
      };
      
      const status = cardInfo.isRodrigoOrLuana ? '✓' : '✗';
      console.log(`${status} CARTÃO: ${cardInfo.name} – ${cardInfo.suffix} (pág ${line.page}, col ${line.column}, y=${line.y})`);
      continue;
    }

    // Se não tem cartão atual, pula
    if (!currentCard) continue;

    // Detecta seções
    if (/^Parcelamentos?$/i.test(lineText.trim())) {
      currentCard.section = "Parcelamento";
      continue;
    }
    if (/^Despesas?$/i.test(lineText.trim())) {
      currentCard.section = "À Vista";
      continue;
    }

    // Ignora linhas de resumo/totais
    if (/COTAÇÃO|IOF|VALOR TOTAL|Compra\s+Data|SUPERCRÉDITO|Total a pagar|Pagamento|Resumo|Saldo|CET|Juros|ANUIDADE|Esfera|Central|DEMONSTRATIVO|Detalhamento|Parcela\s+R\$|Descrição/i.test(lineText)) {
      continue;
    }

    // Se não é cartão permitido (Rodrigo ou Luana), pula
    if (!currentCard.isAllowed) continue;

    // Tenta extrair transação
    const tx = parseTransaction(lineText);
    if (!tx) continue;

    const owner = currentCard.name.toUpperCase().includes('RODRIGO') ? 'Rodrigo' : 'Luana';

    transactions.push({
      date: tx.date,
      desc: tx.desc,
      val: tx.valor,
      card: `${currentCard.name} – ${currentCard.suffix}`,
      owner,
      type: tx.isParcela ? "Parcelamento" : currentCard.section,
    });
  }

  // Remove duplicatas
  const seen = new Set<string>();
  const uniqueTransactions = transactions.filter(t => {
    const key = `${t.date}|${t.desc}|${t.val}|${t.card}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const totalFatura = uniqueTransactions.reduce((sum, t) => sum + t.val, 0);

  let month = "";
  let monthLabel = "Mês Desconhecido";

  if (vencimento) {
    const ref = calcularMesReferencia(vencimento);
    month = ref.month;
    monthLabel = ref.monthLabel;
  } else {
    const now = new Date();
    month = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;
  }

  console.log("\n=== RESULTADO ===");
  console.log("Transações:", uniqueTransactions.length);
  console.log("Total Rodrigo+Luana:", totalFatura.toFixed(2));

  // Agrupa por cartão para debug
  const byCard: Record<string, { count: number; total: number }> = {};
  uniqueTransactions.forEach(t => {
    if (!byCard[t.card]) byCard[t.card] = { count: 0, total: 0 };
    byCard[t.card].count++;
    byCard[t.card].total += t.val;
  });

  console.log("\nPor cartão:");
  for (const [card, data] of Object.entries(byCard)) {
    console.log(`  ${card}: ${data.count} transações, R$ ${data.total.toFixed(2)}`);
  }

  return { month, monthLabel, transactions: uniqueTransactions, totalFatura, vencimento };
}
