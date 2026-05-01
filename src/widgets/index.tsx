import { BuiltInPowerupCodes, declareIndexPlugin, type ReactRNPlugin, type Rem } from '@remnote/plugin-sdk';
import '../style.css';
import '../index.css';

type HighlightRow = {
  fileName: string;
  fullText: string;
  pageNumber: string;
  updatedTimestamp: string;
  notes: string[];
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildExcelXml(rows: HighlightRow[]): string {
  const header = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
  <Worksheet ss:Name="Highlights">
    <Table>
      <Row>
        <Cell><Data ss:Type="String">File Name</Data></Cell>
        <Cell><Data ss:Type="String">Full Text</Data></Cell>
        <Cell><Data ss:Type="String">Page Number</Data></Cell>
        <Cell><Data ss:Type="String">Updated Timestamp</Data></Cell>
        <Cell><Data ss:Type="String">Notes</Data></Cell>
      </Row>`;

  const body = rows
    .map(
      (row) => `
      <Row>
        <Cell><Data ss:Type="String">${escapeXml(row.fileName)}</Data></Cell>
        <Cell><Data ss:Type="String">${escapeXml(row.fullText)}</Data></Cell>
        <Cell><Data ss:Type="String">${escapeXml(row.pageNumber)}</Data></Cell>
        <Cell><Data ss:Type="String">${escapeXml(row.updatedTimestamp)}</Data></Cell>
        <Cell><Data ss:Type="String">${escapeXml(JSON.stringify(row.notes))}</Data></Cell>
      </Row>`,
    )
    .join('');

  const footer = `
    </Table>
  </Worksheet>
</Workbook>`;

  return `${header}${body}${footer}`;
}

function downloadExcel(xml: string): void {
  const encoded = btoa(unescape(encodeURIComponent(xml)));
  const href = `data:application/vnd.ms-excel;base64,${encoded}`;
  const now = new Date().toISOString().replace(/[:.]/g, '-');

  const link = document.createElement('a');
  link.href = href;
  link.download = `remnote-highlights-${now}.xls`;
  link.target = '_blank';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function collectNotesForHighlight(
  highlight: Rem,
  plugin: ReactRNPlugin,
): Promise<string[]> {
  const noteChildren = await highlight.getChildrenRem();
  const notes: string[] = [];

  for (const child of noteChildren) {
    // PDFHighlight Rems carry their powerup properties (Color, PDF, Data, …) as
    // child Rems. Those are not user notes — filter them out.
    if (await child.isPowerupProperty()) continue;

    // Defensive: skip nested highlights too, just in case.
    if (await child.hasPowerup(BuiltInPowerupCodes.PDFHighlight)) continue;

    const noteText = (await plugin.richText.toString(child.text)).trim();
    if (noteText.length > 0) {
      notes.push(noteText);
    }
  }

  return notes;
}

async function collectHighlightsForRem(
  rem: Rem,
  plugin: ReactRNPlugin,
  fileName: string,
  rows: HighlightRow[],
): Promise<void> {
  const children = await rem.getChildrenRem();

  for (const child of children) {
    const isPdfHighlight = await child.hasPowerup(BuiltInPowerupCodes.PDFHighlight);

    if (isPdfHighlight) {
      const fullText = await plugin.richText.toString(child.text);
      const pageNumber = await plugin.richText.toString((await child.getParentRem())?.text ?? []);
      const updatedTimestamp = new Date(child.updatedAt).toISOString();
      const notes = await collectNotesForHighlight(child, plugin);

      rows.push({
        fileName,
        fullText,
        pageNumber,
        updatedTimestamp,
        notes,
      });
    }

    await collectHighlightsForRem(child, plugin, fileName, rows);
  }
}

async function exportHighlights(plugin: ReactRNPlugin): Promise<void> {
  await plugin.app.toast('Exporting PDF highlights to Excel...');

  const filePowerup = await plugin.powerup.getPowerupByCode(BuiltInPowerupCodes.UploadedFile);
  if (!filePowerup) {
    await plugin.app.toast('Unable to find uploaded file powerup.');
    return;
  }

  const pdfRems = await filePowerup.taggedRem();
  const rows: HighlightRow[] = [];

  for (const pdfRem of pdfRems) {
    const fileName =
      (await pdfRem.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'Name')) ||
      (await plugin.richText.toString(pdfRem.text)) ||
      'Unknown File';

    await collectHighlightsForRem(pdfRem, plugin, fileName, rows);
  }

  if (rows.length === 0) {
    await plugin.app.toast('No PDF highlights found to export.');
    return;
  }

  const xml = buildExcelXml(rows);
  downloadExcel(xml);

  await plugin.app.toast(`Excel download started for ${rows.length} highlights.`);
}

async function onActivate(plugin: ReactRNPlugin) {
  const pluginId = plugin.manifest?.id ?? 'remnote-export-highlights-plugin';

  await plugin.app.registerCommand({
    id: `${pluginId}:export-highlights-excel`,
    name: 'Export Highlights to CSV',
    description: 'Export all PDF highlights with file name, text, page number, updated timestamp, and notes.',
    keywords: 'pdf highlight export excel xls',
    action: async () => {
      await exportHighlights(plugin);
    },
  });
}

async function onDeactivate(_: ReactRNPlugin) {
}

declareIndexPlugin(onActivate, onDeactivate);