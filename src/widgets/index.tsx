import {
  BuiltInPowerupCodes,
  declareIndexPlugin,
  type RNPlugin,
  type ReactRNPlugin,
  type Rem,
} from '@remnote/plugin-sdk';

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

function detectiveLog(title: string, payload?: unknown): void {
  const prefix = '🕵️ [RemNote Detective]';
  if (payload === undefined) {
    console.log(`${prefix} ${title}`);
  } else {
    console.log(`${prefix} ${title}`, payload);
  }
}

async function stringifyRemText(plugin: RNPlugin, rem: Rem | undefined | null): Promise<string | undefined> {
  if (!rem) return undefined;
  try {
    return await plugin.richText.toString(rem.text);
  } catch {
    return undefined;
  }
}

async function inspectRem(
  plugin: RNPlugin,
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
    const hasUploadedFile = await rem.hasPowerup(BuiltInPowerupCodes.UploadedFile).catch(() => false);
    const hasPdfHighlight = await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight).catch(() => false);

    let fileName: string | undefined;
    let fileTitle: string | undefined;
    let fileType: string | undefined;
    let fileUrl: string | undefined;
    let viewerData: unknown;
    let kind: DetectiveSurfaceGuess['kind'] = 'rem';

    if (hasUploadedFile) {
      fileName = await rem.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'Name').catch(() => undefined);
      fileTitle = await rem.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'Title').catch(() => undefined);
      fileType = await rem.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'Type').catch(() => undefined);
      fileUrl = await rem.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'URL').catch(() => undefined);
      viewerData = await rem.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'ViewerData').catch(() => undefined);
    }

    if (hasPdfHighlight) {
      kind = 'pdf';
    } else if (hasUploadedFile) {
      const looksLikePdf =
        /pdf/i.test(fileType ?? '') ||
        /\.pdf($|\?)/i.test(fileUrl ?? '') ||
        /pdf/i.test(fileName ?? '');
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


async function getSelectionDebug(plugin: RNPlugin) {
  const selection = await plugin.editor.getSelection().catch(() => undefined);

  const selectionType =
    selection &&
    typeof selection === 'object' &&
    'type' in selection
      ? (selection.type as unknown)
      : undefined;

  const selectionRemId =
    selection &&
    typeof selection === 'object' &&
    'remId' in selection &&
    typeof selection.remId === 'string'
      ? selection.remId
      : undefined;

  const selectionLooksPdf =
    typeof selectionType === 'string' &&
    /pdf|reader/i.test(selectionType);

  return {
    selection,
    selectionType,
    selectionRemId,
    selectionLooksPdf,
  };
}

async function collectDetectiveSnapshot(plugin: RNPlugin): Promise<DetectiveSnapshot> {
  const focus = await detectFocusSnapshot();
  const guesses: DetectiveSurfaceGuess[] = [];

  const focusedPaneId = await plugin.window.getFocusedPaneId().catch(() => undefined);
  const focusedPaneRemId = focusedPaneId
    ? await plugin.window.getOpenPaneRemId(focusedPaneId).catch(() => undefined)
    : undefined;

  guesses.push(
    await inspectRem(plugin, focusedPaneRemId, 'window.getFocusedPaneId + window.getOpenPaneRemId', {
      focusedPaneId,
    }),
  );

  const focusedRem = await plugin.focus.getFocusedRem().catch(() => undefined);
  guesses.push(
    await inspectRem(plugin, focusedRem?._id, 'focus.getFocusedRem', {
      hasFocusedRem: Boolean(focusedRem),
    }),
  );


  const selectionInfo = await getSelectionDebug(plugin);
  guesses.push(
    await inspectRem(plugin, selectionInfo.selectionRemId, 'editor.getSelection', {
      selection: selectionInfo.selection,
      selectionType: selectionInfo.selectionType,
      selectionLooksPdf: selectionInfo.selectionLooksPdf,
    }),
  );

  const focusedPortal = await plugin.focus.getFocusedPortal().catch(() => undefined);
  guesses.push({
    source: 'focus.getFocusedPortal',
    kind: 'unknown',
    extra: {
      focusedPortal,
    },
  });

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

  return {
    observedAt: new Date().toISOString(),
    focus,
    guesses,
  };
}

async function runDetective(plugin: RNPlugin, reason: string): Promise<void> {
  const snapshot = await collectDetectiveSnapshot(plugin);

  detectiveLog(`CASE UPDATE: ${reason}`);
  detectiveLog('Focus clues', snapshot.focus);

  for (const guess of snapshot.guesses) {
    detectiveLog(`Suspect from ${guess.source}`, guess);
  }
}

async function onActivate(plugin: ReactRNPlugin) {
  const pluginId = plugin.manifest?.id ?? 'remnote-export-highlights-plugin';

  await plugin.app.registerCommand({
    id: `${pluginId}:probe-now`,
    name: 'Run Detective Probe Now',
    action: async () => {
      await runDetective(plugin, 'manual probe');
      await plugin.app.toast('Detective probe complete. Check console.');
    },
  });

  plugin.track(async (reactivePlugin) => {
    await reactivePlugin.window.getFocusedPaneId().catch(() => undefined);
    await reactivePlugin.window.getOpenPaneRemIds().catch(() => []);
    await reactivePlugin.focus.getFocusedRem().catch(() => undefined);
    await reactivePlugin.focus.getFocusedPortal().catch(() => undefined);
    await reactivePlugin.editor.getSelection().catch(() => undefined);
    await reactivePlugin.editor.getSelectedRem().catch(() => undefined);

    await runDetective(reactivePlugin, 'plugin.track reactive rerun');
  });
}

declareIndexPlugin(onActivate, async () => {});