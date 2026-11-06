/* =========================================================
   backup.js
   Respaldo dentro de los archivos que descargas.

   Cada PDF y cada Excel que baja la app lleva ADENTRO una copia completa
   de tus datos (comprimida). Así, si algún día se borran los datos del
   teléfono, puedes volver a cargar ese mismo archivo y todo regresa.

     - PDF:   la copia va en un objeto interno del PDF (no se ve al leerlo).
     - Excel: la copia va en la hoja "Respaldo" (no la borres ni la cambies).

   Este archivo SOLO arma y lee ese respaldo. Quien guarda los datos
   (y los valida otra vez) es storage.js.
   ========================================================= */

import { loadLib } from './libs.js';
import { getItems } from './storage.js';
import { isPlainObject } from './utils.js';

const APP_ID = 'finanzas-app';
const FORMAT_VERSION = 1;

export const BACKUP_MARKER = 'FINANZAS-APP-BACKUP:';
export const BACKUP_SHEET = 'Respaldo';

const MAX_FILE_BYTES = 25 * 1024 * 1024; // archivo más grande que esto se rechaza
const MAX_JSON_BYTES = 5 * 1024 * 1024; // mismo tope que storage.js
const MAX_XML_BYTES = 30 * 1024 * 1024;
const EXCEL_CHUNK = 30000; // una celda de Excel admite hasta 32,767 caracteres

/** Error con un mensaje listo para mostrarle a la persona. */
export class BackupError extends Error {}

const MSG = {
  notAllowed: 'Solo se aceptan archivos PDF o Excel (.xlsx) descargados desde esta app.',
  mismatch: 'El contenido del archivo no coincide con su tipo. Usa un PDF o Excel descargado desde esta app.',
  notOurs:
    'Este archivo no es un respaldo de Mis Finanzas. Usa un PDF o Excel que hayas descargado desde esta app (con la versión actual).',
  corrupt: 'El respaldo está dañado o fue modificado, y no se pudo leer.',
  tooBig: 'El archivo es demasiado grande.',
  newer: 'Este respaldo viene de otra versión de la app y no se puede leer.',
  read: 'No se pudo leer el archivo.',
};

/* =========================================================
   1. CREAR EL RESPALDO (al descargar PDF o Excel)
   ========================================================= */

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Texto del respaldo ("v1:....") con TODOS tus datos, comprimido. */
export async function createBackupPayload() {
  await loadLib('backup-tools.min.js');
  const { gzipSync, strToU8 } = globalThis.FinanzasZip;

  const envelope = {
    app: APP_ID,
    format: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      transactions: getItems('transactions'),
      loans: getItems('loans'),
      debts: getItems('debts'),
    },
  };
  const bytes = gzipSync(strToU8(JSON.stringify(envelope)), { level: 9 });
  return `v${FORMAT_VERSION}:${toBase64(bytes)}`;
}

/** Mete el respaldo dentro del PDF como un objeto interno más (los lectores de PDF lo ignoran). */
export function embedBackupInPdf(doc, payload) {
  const body = `${BACKUP_MARKER}${payload}`;
  let objectId = 0;

  doc.internal.events.subscribe('putResources', () => {
    objectId = doc.internal.newObject();
    doc.internal.write(`<< /Type /FinanzasBackup /Length ${body.length} >>`);
    doc.internal.write('stream');
    doc.internal.write(body);
    doc.internal.write('endstream');
    doc.internal.write('endobj');
  });
  doc.internal.events.subscribe('putCatalog', () => {
    if (objectId) doc.internal.write(`/FinanzasBackup ${objectId} 0 R`);
  });
}

/** Celdas (una por fila) de la hoja "Respaldo" del Excel: la marca y luego el respaldo en trozos. */
export function backupExcelCells(payload) {
  const separator = payload.indexOf(':');
  const version = payload.slice(0, separator); // "v1"
  const base64 = payload.slice(separator + 1);

  const cells = [`${BACKUP_MARKER}${version}`];
  for (let i = 0; i < base64.length; i += EXCEL_CHUNK) cells.push(base64.slice(i, i + EXCEL_CHUNK));
  return cells;
}

/* =========================================================
   2. LEER UN ARCHIVO (al restaurar)
   ========================================================= */

/** Busca el respaldo dentro de un PDF. Devuelve { version, base64 } o null. */
function findInPdf(bytes) {
  const text = new TextDecoder('latin1').decode(bytes);
  const match = /FINANZAS-APP-BACKUP:v(\d+):([A-Za-z0-9+/=]+)/.exec(text);
  return match ? { version: Number(match[1]), base64: match[2] } : null;
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new BackupError(MSG.mismatch);
  return doc;
}

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Textos compartidos de Excel (así guarda Excel las celdas de texto). */
function readSharedStrings(xml) {
  if (!xml) return [];
  const doc = parseXml(xml);
  return Array.from(doc.getElementsByTagName('si')).map((si) =>
    Array.from(si.getElementsByTagName('t'))
      .filter((t) => t.parentNode && t.parentNode.nodeName !== 'rPh')
      .map((t) => t.textContent)
      .join('')
  );
}

function cellText(cell, shared) {
  const type = cell.getAttribute('t');
  if (type === 'inlineStr') {
    return Array.from(cell.getElementsByTagName('t')).map((t) => t.textContent).join('');
  }
  const valueNode = cell.getElementsByTagName('v')[0];
  const value = valueNode ? valueNode.textContent : '';
  return type === 's' ? (shared[Number(value)] ?? '') : value;
}

/** Busca el respaldo en la hoja "Respaldo" de un Excel. Devuelve { version, base64 } o null. */
function findInExcel(bytes) {
  const { unzipSync, strFromU8 } = globalThis.FinanzasZip;

  let files;
  try {
    files = unzipSync(bytes, {
      filter: (file) =>
        file.originalSize <= MAX_XML_BYTES &&
        (file.name === 'xl/workbook.xml' ||
          file.name === 'xl/_rels/workbook.xml.rels' ||
          file.name === 'xl/sharedStrings.xml' ||
          /^xl\/worksheets\/[^/]+\.xml$/.test(file.name)),
    });
  } catch {
    throw new BackupError(MSG.mismatch);
  }
  if (!files['xl/workbook.xml'] || !files['xl/_rels/workbook.xml.rels']) throw new BackupError(MSG.notOurs);

  // 1) ¿Qué archivo es la hoja "Respaldo"?
  const workbook = parseXml(strFromU8(files['xl/workbook.xml']));
  const sheet = Array.from(workbook.getElementsByTagName('sheet')).find((s) => s.getAttribute('name') === BACKUP_SHEET);
  if (!sheet) return null;
  const relId = sheet.getAttributeNS(REL_NS, 'id') || sheet.getAttribute('r:id');

  const rels = parseXml(strFromU8(files['xl/_rels/workbook.xml.rels']));
  const rel = Array.from(rels.getElementsByTagName('Relationship')).find((r) => r.getAttribute('Id') === relId);
  if (!rel) return null;
  let target = rel.getAttribute('Target') || '';
  target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  if (!files[target]) return null;

  // 2) Las celdas de la columna A, en orden
  const shared = readSharedStrings(files['xl/sharedStrings.xml'] ? strFromU8(files['xl/sharedStrings.xml']) : '');
  const sheetDoc = parseXml(strFromU8(files[target]));
  const cells = [];
  for (const cell of Array.from(sheetDoc.getElementsByTagName('c'))) {
    const ref = /^A(\d+)$/.exec(cell.getAttribute('r') || '');
    if (ref) cells.push({ row: Number(ref[1]), text: cellText(cell, shared) });
  }
  cells.sort((a, b) => a.row - b.row);

  // 3) La marca "FINANZAS-APP-BACKUP:v1" y, debajo, los trozos del respaldo
  const start = cells.findIndex((c) => /^FINANZAS-APP-BACKUP:v\d+$/.test(c.text.trim()));
  if (start === -1) return null;
  const version = Number(cells[start].text.trim().split(':v')[1]);

  let base64 = '';
  for (let i = start + 1; i < cells.length; i++) {
    const chunk = cells[i].text.trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(chunk)) break;
    base64 += chunk;
  }
  return base64 ? { version, base64 } : null;
}

/** Descomprime con tope de tamaño (por si alguien manda un archivo "bomba"). */
function gunzipLimited(bytes) {
  const { Gunzip } = globalThis.FinanzasZip;
  const parts = [];
  let total = 0;

  const gunzip = new Gunzip((chunk) => {
    total += chunk.length;
    if (total > MAX_JSON_BYTES) throw new BackupError(MSG.tooBig);
    parts.push(chunk);
  });
  gunzip.push(bytes, true);

  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Convierte el texto del respaldo en datos. Lanza BackupError si algo no cuadra. */
async function decodePayload({ version, base64 }) {
  if (version !== FORMAT_VERSION) throw new BackupError(MSG.newer);
  await loadLib('backup-tools.min.js');
  const { strFromU8 } = globalThis.FinanzasZip;

  let json;
  try {
    const bytes = fromBase64(base64);
    if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('no gzip');
    json = strFromU8(gunzipLimited(bytes));
  } catch (error) {
    throw error instanceof BackupError ? error : new BackupError(MSG.corrupt);
  }

  let envelope;
  try {
    envelope = JSON.parse(json);
  } catch {
    throw new BackupError(MSG.corrupt);
  }

  if (!isPlainObject(envelope) || envelope.app !== APP_ID || !isPlainObject(envelope.data)) {
    throw new BackupError(MSG.notOurs);
  }
  if (envelope.format !== FORMAT_VERSION) throw new BackupError(MSG.newer);

  return {
    exportedAt: typeof envelope.exportedAt === 'string' ? envelope.exportedAt.slice(0, 10) : '',
    data: envelope.data,
  };
}

const startsWith = (bytes, signature, from = 0) => signature.every((byte, i) => bytes[from + i] === byte);

/**
 * Lee un archivo que la persona eligió y devuelve { exportedAt, data }.
 * Solo acepta PDF y Excel (.xlsx) generados por esta app; todo lo demás se rechaza.
 */
export async function readBackupFile(file) {
  if (!file || typeof file.name !== 'string' || typeof file.size !== 'number') throw new BackupError(MSG.read);

  const name = file.name.toLowerCase();
  const isPdfName = name.endsWith('.pdf');
  const isExcelName = name.endsWith('.xlsx');
  if (!isPdfName && !isExcelName) throw new BackupError(MSG.notAllowed);
  if (file.size === 0) throw new BackupError(MSG.mismatch);
  if (file.size > MAX_FILE_BYTES) throw new BackupError(MSG.tooBig);

  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new BackupError(MSG.read);
  }

  // Se revisa el contenido real, no solo el nombre: un PDF empieza con "%PDF-"
  // y un .xlsx es un archivo ZIP (empieza con "PK").
  const looksLikePdf = findPdfHeader(bytes);
  const looksLikeZip = startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
  if ((isPdfName && !looksLikePdf) || (isExcelName && !looksLikeZip)) throw new BackupError(MSG.mismatch);

  let found;
  if (isPdfName) {
    found = findInPdf(bytes);
  } else {
    await loadLib('backup-tools.min.js');
    found = findInExcel(bytes);
  }
  if (!found) throw new BackupError(MSG.notOurs);

  return decodePayload(found);
}

/** "%PDF-" en los primeros 1024 bytes (así lo permite el formato PDF). */
function findPdfHeader(bytes) {
  const limit = Math.min(bytes.length - 5, 1024);
  for (let i = 0; i <= limit; i++) {
    if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d], i)) return true;
  }
  return false;
}
