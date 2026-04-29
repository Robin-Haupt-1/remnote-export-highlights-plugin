import {
  BuiltInPowerupCodes,
  declareIndexPlugin,
  SelectionType,
  type ReactRNPlugin,
  type Rem,
} from '@remnote/plugin-sdk';
import '../style.css';
import '../index.css';

type HighlightRow = {
  fileName: string;
  fullText: string;
  pageNumber: string;
  updatedTimestamp: string;
};

type DetectiveFocusSnapshot = {
  documentHasFocus: boolean;
  visibilityState: DocumentVisibilityState;
  hidden: boolean;
};

type DetectiveSurfaceGuess = {
  source: string;
  kind: 'document' | 'pdf' | 'file' | 'rem' | 'none' | 'unknown';
  paneId?: string;
  remId?: string;
  remText?: string;
  isDocument?: boolean;
  hasUploadedFile?: boolean;
  hasPdfHighlight?: boolean;
  fileName?: string;
  fileTitle?: string;
  fileType?: string;
  fileUrl?: string;
  viewerData?: unknown;
  extra?: Record<string, unknown>;
};

type DetectiveSnapshot = {
  observedAt: string;
  focus: DetectiveFocusSnapshot;
  guesses: DetectiveSurfaceGuess[];
};

type DetectiveEvent = {
  timestamp: string;
  reason: string;
  snapshot: DetectiveSnapshot;
};

const DETECTIVE_LATEST_SYNC_KEY = 'detective.latest.sync.v1';
const DETECTIVE_LOG_LOCAL_KEY = 'detective.log.local.v1';
const DETECTIVE_ENABLED_LOCAL_KEY = 'detective.enabled.local.v1';
const MAX_DETECTIVE_EVENTS = 150;

function detectiveLog(title: string, payload?: unknown): void {
  const prefix = '🕵️ [RemNote Detective]';
  if (payload === undefined) {
    console.log(`${prefix} ${title}`);
  } else {
    console.log(`${prefix} ${title}`, payload);
  }
}

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

async function stringifyRemText(plugin: ReactRNPlugin, rem: Rem | undefined | null): Promise<string | undefined> {
  if (!rem) return undefined;
  try {
    return await plugin.richText.toString(rem.text);
  } catch {
    return undefined;
  }
}

async function inspectRem(
  plugin: ReactRNPlugin,
  remId: string | undefined,
  source: string,
  extra?: Record<string, unknown>,
): Promise<DetectiveSurfaceGuess> {
  if (!remId) {
    return {
      source,
      kind: 'none',
      remId,
      extra,
    };
  }

  try {
    const rem = await plugin.rem.findOne(remId);

    if (!rem) {
      return {
        source,
        kind: 'unknown',
        remId,
        extra: {
          ...extra,
          note: 'plugin.rem.findOne returned undefined',
        },
      };
    }

    const isDocument = await rem.isDocument().catch(() => false);
    const hasUploadedFile = await rem
      .hasPowerup(BuiltInPowerupCodes.UploadedFile)
      .catch(() => false);
    const hasPdfHighlight = await rem
      .hasPowerup(BuiltInPowerupCodes.PDFHighlight)
      .catch(() => false);

    let fileName: string | undefined;
    let fileTitle: string | undefined;
    let fileType: string | undefined;
    let fileUrl: string | undefined;
    let viewerData: unknown;
    let kind: DetectiveSurfaceGuess['kind'] = 'rem';

    if (hasUploadedFile) {
      fileName = await rem
        .getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'Name')
        .catch(() => undefined);
      fileTitle = await rem
        .getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'Title')
        .catch(() => undefined);
      fileType = await rem
        .getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'Type')
        .catch(() => undefined);
      fileUrl = await rem
        .getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'URL')
        .catch(() => undefined);
      viewerData = await rem
        .getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'ViewerData')
        .catch(() => undefined);
    }

    if (hasPdfHighlight) {
      kind = 'pdf';
    } else if (hasUploadedFile) {
      const looksLikePdf =
        /pdf/i.test(fileType ?? '') || /\.pdf($|\?)/i.test(fileUrl ?? '') || /pdf/i.test(fileName ?? '');
      kind = looksLikePdf ? 'pdf' : 'file';
    } else if (isDocument) {
      kind = 'document';
    }

    return {
      source,
      kind,
      remId,
      remText: await stringifyRemText(plugin, rem),
      isDocument,
      hasUploadedFile,
      hasPdfHighlight,
      fileName,
      fileTitle,
      fileType,
      fileUrl,
      viewerData,
      extra,
    };
  } catch (error) {
    return {
      source,
      kind: 'unknown',
      remId,
      extra: {
        ...extra,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function detectFocusSnapshot(): Promise<DetectiveFocusSnapshot> {
  return {
    documentHasFocus: document.hasFocus(),
    visibilityState: document.visibilityState,
    hidden: document.hidden,
  };
}

async function collectDetectiveSnapshot(plugin: ReactRNPlugin): Promise<DetectiveSnapshot> {
  const focus = await detectFocusSnapshot();
  const guesses: DetectiveSurfaceGuess[] = [];

  // Method 1: focused pane -> open pane rem
  const focusedPaneId = await plugin.window.getFocusedPaneId().catch(() => undefined);
  const focusedPaneRemId = focusedPaneId
    ? await plugin.window.getOpenPaneRemId(focusedPaneId).catch(() => undefined)
    : undefined;

  guesses.push(
    await inspectRem(plugin, focusedPaneRemId, 'window.getFocusedPaneId + window.getOpenPaneRemId', {
      focusedPaneId,
    }),
  );

  // Method 2: current window tree
  const currentWindowTree = await plugin.window.getCurrentWindowTree().catch(() => undefined);
  const openPaneRemIds = await plugin.window.getOpenPaneRemIds().catch(() => []);
  guesses.push({
    source: 'window.getCurrentWindowTree + window.getOpenPaneRemIds',
    kind: 'unknown',
    extra: {
      currentWindowTree,
      openPaneRemIds,
    },
  });

  // Method 3: focused rem
  const focusedRem = await plugin.focus.getFocusedRem().catch(() => undefined);
  const focusedRemId = focusedRem?._id;
  guesses.push(
    await inspectRem(plugin, focusedRemId, 'focus.getFocusedRem', {
      hasFocusedRem: Boolean(focusedRem),
    }),
  );

  // Method 4: selected rem
  const selectedRem = await plugin.editor.getSelectedRem().catch(() => undefined);
  const selectedRemId = selectedRem?._id;
  guesses.push(
    await inspectRem(plugin, selectedRemId, 'editor.getSelectedRem', {
      hasSelectedRem: Boolean(selectedRem),
    }),
  );

  // Method 5: selection object
  const selection = await plugin.editor.getSelection().catch(() => undefined);
  const selectionRemId =
    selection && typeof selection === 'object' && 'remId' in selection
      ? (selection.remId as string | undefined)
      : undefined;

  guesses.push(
    await inspectRem(plugin, selectionRemId, 'editor.getSelection', {
      selection,
      selectionType:
        selection && typeof selection === 'object' && 'type' in selection ? selection.type : undefined,
      selectionSaysPdf:
        selection && typeof selection === 'object' && 'type' in selection
          ? selection.type === SelectionType.PDF
          : false,
    }),
  );

  // Method 6: focused portal
  const focusedPortal = await plugin.focus.getFocusedPortal().catch(() => undefined);
  guesses.push({
    source: 'focus.getFocusedPortal',
    kind: 'unknown',
    extra: {
      focusedPortal,
    },
  });

  return {
    observedAt: new Date().toISOString(),
    focus,
    guesses,
  };
}

async function persistDetectiveSnapshot(
  plugin: ReactRNPlugin,
  reason: string,
  snapshot: DetectiveSnapshot,
): Promise<void> {
  await plugin.storage.setSynced(DETECTIVE_LATEST_SYNC_KEY, snapshot).catch((error) => {
    detectiveLog('Failed to store latest synced snapshot', error);
  });

  const existing =
    (await plugin.storage.getLocal<DetectiveEvent[]>(DETECTIVE_LOG_LOCAL_KEY).catch(() => [])) ?? [];

  const next: DetectiveEvent[] = [
    ...existing,
    {
      timestamp: new Date().toISOString(),
      reason,
      snapshot,
    },
  ].slice(-MAX_DETECTIVE_EVENTS);

  await plugin.storage.setLocal(DETECTIVE_LOG_LOCAL_KEY, next).catch((error) => {
    detectiveLog('Failed to store local detective log', error);
  });
}

async function runDetective(plugin: ReactRNPlugin, reason: string): Promise<void> {
  const snapshot = await collectDetectiveSnapshot(plugin);

  detectiveLog(`CASE UPDATE: ${reason}`);
  detectiveLog('Focus clues', snapshot.focus);

  for (const guess of snapshot.guesses) {
    detectiveLog(`Suspect from ${guess.source}`, guess);
  }

  await persistDetectiveSnapshot(plugin, reason, snapshot);
}

function debounceAsync<T extends unknown[]>(
  fn: (...args: T) => Promise<void>,
  waitMs: number,
): (...args: T) => void {
  let timeout: number | undefined;

  return (...args: T) => {
    if (timeout) {
      window.clearTimeout(timeout);
    }

    timeout = window.setTimeout(() => {
      void fn(...args);
    }, waitMs);
  };
}

async function installDetectiveMode(plugin: ReactRNPlugin): Promise<() => void> {
  const runDebounced = debounceAsync(async (reason: string) => {
    await runDetective(plugin, reason);
  }, 250);

  const onWindowFocus = () => runDebounced('window focus');
  const onWindowBlur = () => runDebounced('window blur');
  const onVisibilityChange = () => runDebounced(`visibilitychange:${document.visibilityState}`);
  const onPageShow = () => runDebounced('pageshow');
  const onPageHide = () => runDebounced('pagehide');

  window.addEventListener('focus', onWindowFocus, true);
  window.addEventListener('blur', onWindowBlur, true);
  window.addEventListener('pageshow', onPageShow, true);
  window.addEventListener('pagehide', onPageHide, true);
  document.addEventListener('visibilitychange', onVisibilityChange, true);

  const stopTracking = plugin.track(async (reactivePlugin) => {
    // These reactive reads are intentionally noisy so that the tracker reruns
    // when the UI context changes in ways RemNote exposes.
    await reactivePlugin.window.getFocusedPaneId().catch(() => undefined);
    await reactivePlugin.window.getOpenPaneRemIds().catch(() => []);
    await reactivePlugin.focus.getFocusedRem().catch(() => undefined);
    await reactivePlugin.focus.getFocusedPortal().catch(() => undefined);
    await reactivePlugin.editor.getSelection().catch(() => undefined);
    await reactivePlugin.editor.getSelectedRem().catch(() => undefined);

    await runDetective(reactivePlugin, 'plugin.track reactive rerun');
  });

  await plugin.storage.setLocal(DETECTIVE_ENABLED_LOCAL_KEY, true).catch(() => undefined);
  await runDetective(plugin, 'detective mode installed');

  return () => {
    window.removeEventListener('focus', onWindowFocus, true);
    window.removeEventListener('blur', onWindowBlur, true);
    window.removeEventListener('pageshow', onPageShow, true);
    window.removeEventListener('pagehide', onPageHide, true);
    document.removeEventListener('visibilitychange', onVisibilityChange, true);
    stopTracking();

    void plugin.storage.setLocal(DETECTIVE_ENABLED_LOCAL_KEY, false).catch(() => undefined);
    detectiveLog('Detective mode shut down');
  };
}

let stopDetectiveMode: (() => void) | undefined;

async function startDetectiveMode(plugin: ReactRNPlugin): Promise<void> {
  if (stopDetectiveMode) {
    await plugin.app.toast('Detective mode is already running.');
    await runDetective(plugin, 'manual probe while already running');
    return;
  }

  stopDetectiveMode = await installDetectiveMode(plugin);
  await plugin.app.toast('Detective mode started. Check the console for clues.');
}

async function stopDetective(plugin: ReactRNPlugin): Promise<void> {
  if (!stopDetectiveMode) {
    await plugin.app.toast('Detective mode is not running.');
    return;
  }

  stopDetectiveMode();
  stopDetectiveMode = undefined;
  await plugin.app.toast('Detective mode stopped.');
}

async function showLatestDetectiveSnapshot(plugin: ReactRNPlugin): Promise<void> {
  const latest = await plugin.storage
    .getSynced<DetectiveSnapshot | undefined>(DETECTIVE_LATEST_SYNC_KEY)
    .catch(() => undefined);

  detectiveLog('Latest synced detective snapshot', latest);

  if (!latest) {
    await plugin.app.toast('No detective snapshot has been stored yet.');
    return;
  }

  await plugin.app.toast(
    `Latest clue: ${latest.guesses[0]?.kind ?? 'unknown'} at ${new Date(latest.observedAt).toLocaleTimeString()}`,
  );
}

async function clearDetectiveLog(plugin: ReactRNPlugin): Promise<void> {
  await plugin.storage.setLocal(DETECTIVE_LOG_LOCAL_KEY, []);
  await plugin.app.toast('Detective log cleared.');
  detectiveLog('Local detective log cleared');
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

  await plugin.app.registerCommand({
    id: `${pluginId}:start-detective-mode`,
    name: 'Start Detective Mode',
    description: 'Try many ways of detecting focus and active document/PDF, then log and store the clues.',
    keywords: 'debug detective focus pdf document active window tab',
    action: async () => {
      await startDetectiveMode(plugin);
    },
  });

  await plugin.app.registerCommand({
    id: `${pluginId}:probe-now`,
    name: 'Run Detective Probe Now',
    description: 'Run one immediate detective probe and log all clues.',
    keywords: 'debug detective probe inspect focus pdf document',
    action: async () => {
      await runDetective(plugin, 'manual probe');
      await plugin.app.toast('Detective probe complete. Check console.');
    },
  });

  await plugin.app.registerCommand({
    id: `${pluginId}:show-latest-detective-snapshot`,
    name: 'Show Latest Detective Snapshot',
    description: 'Load the latest persisted detective snapshot from plugin storage.',
    keywords: 'debug detective storage snapshot',
    action: async () => {
      await showLatestDetectiveSnapshot(plugin);
    },
  });

  await plugin.app.registerCommand({
    id: `${pluginId}:clear-detective-log`,
    name: 'Clear Detective Log',
    description: 'Clear the rolling detective log stored in local plugin storage.',
    keywords: 'debug detective clear log storage',
    action: async () => {
      await clearDetectiveLog(plugin);
    },
  });

  await plugin.app.registerCommand({
    id: `${pluginId}:stop-detective-mode`,
    name: 'Stop Detective Mode',
    description: 'Stop live detective logging.',
    keywords: 'debug detective stop',
    action: async () => {
      await stopDetective(plugin);
    },
  });

  const shouldAutoResume =
    (await plugin.storage.getLocal<boolean>(DETECTIVE_ENABLED_LOCAL_KEY).catch(() => false)) ?? false;

  if (shouldAutoResume) {
    detectiveLog('Auto-resuming detective mode from local storage flag');
    await startDetectiveMode(plugin);
  }
}

async function onDeactivate(_: ReactRNPlugin) {
  if (stopDetectiveMode) {
    stopDetectiveMode();
    stopDetectiveMode = undefined;
  }
}

declareIndexPlugin(onActivate, onDeactivate);