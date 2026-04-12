import { BuiltInPowerupCodes, declareIndexPlugin, type ReactRNPlugin, type Rem } from '@remnote/plugin-sdk';
import '../style.css';
import '../index.css';

type HighlightRow = {
  fileName: string;
  fullText: string;
  pageNumber: string;
  updatedTimestamp: string;
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
      </Row>`;

  const body = rows
    .map(
      (row) => `
      <Row>
        <Cell><Data ss:Type="String">${escapeXml(row.fileName)}</Data></Cell>
        <Cell><Data ss:Type="String">${escapeXml(row.fullText)}</Data></Cell>
        <Cell><Data ss:Type="String">${escapeXml(row.pageNumber)}</Data></Cell>
        <Cell><Data ss:Type="String">${escapeXml(row.updatedTimestamp)}</Data></Cell>
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

      rows.push({
        fileName,
        fullText,
        pageNumber,
        updatedTimestamp,
      });
    }

    await collectHighlightsForRem(child, plugin, fileName, rows);
  }
}

async function exportHighlights(plugin: ReactRNPlugin): Promise<void> {
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

  await plugin.app.toast(`Exported ${rows.length} highlights to Excel.`);
}

async function onActivate(plugin: ReactRNPlugin) {
  const pluginId = plugin.manifest?.id ?? 'remnote-export-highlights-plugin';

  await plugin.app.registerCommand({
    id: `${pluginId}:export-highlights-excel`,
    name: 'Export PDF Highlights to Excel',
    description: 'Export all PDF highlights with file name, text, page number, and updated timestamp.',
    keywords: 'pdf highlight export excel xls',
    action: async () => {
      await exportHighlights(plugin);
    },
  });
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
