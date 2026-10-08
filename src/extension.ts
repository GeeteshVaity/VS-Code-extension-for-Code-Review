import * as vscode from 'vscode';
import { ReviewWebviewPanel } from './panels/ReviewWebviewPanel';
import { GroqServiceError, runCoTReview } from './services/groqService';

/**
 * CoT Deep Code Review — extension entry point.
 *
 * PHASE 2: command handler pipeline
 *  1. Input Capture  — extract the highlighted selection (C) and the target
 *     language ID (L) from the active editor buffer, with graceful fallbacks.
 *  2. Key Resolution — read `cotReviewer.groqApiKey` from configuration, or
 *     prompt with a password-masked input box and persist the entered key.
 *
 * Phase 3 will hand the captured payload to `src/services/groqService.ts`.
 */

/** Snapshot of everything captured from the active editor. */
interface ReviewInput {
  selectedText: string;
  languageId: string;
  document: vscode.TextDocument;
  selection: vscode.Range;
}

const CONFIG_SECTION = 'cotReviewer';
const CONFIG_KEY = 'groqApiKey';

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand('cot.runDeepReview', () =>
    runDeepReview(context)
  );
  context.subscriptions.push(disposable);
}

/**
 * Top-level command handler. Never throws: all failures surface as a VS Code
 * notification so the async review pipeline can never crash the extension host.
 */
async function runDeepReview(context: vscode.ExtensionContext): Promise<void> {
  try {
    // ── Phase 2: Input Capture ────────────────────────────────────────────
    const input = captureSelection();
    if (!input) {
      return; // captureSelection() already told the user what went wrong
    }

    // ── Phase 2: Groq API Key resolution ──────────────────────────────────
    const apiKey = await resolveGroqApiKey();
    if (!apiKey) {
      void vscode.window.showWarningMessage(
        'CoT Deep Review: review cancelled — a Groq API key is required.'
      );
      return;
    }

    // ── Phase 4: open the panel immediately in its loading state ─────────
    const panel = ReviewWebviewPanel.open(context);

    // ── Phase 3: CoT prompt orchestration + Groq inference (async) ───────
    let result;
    try {
      result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'CoT Deep Review: reasoning about async execution…',
          cancellable: false,
        },
        () =>
          runCoTReview({
            selectedText: input.selectedText,
            languageId: input.languageId,
            apiKey,
          })
      );
    } catch (err) {
      const text =
        err instanceof GroqServiceError
          ? `[${err.kind}] ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      panel.renderError(text);
      void vscode.window.showErrorMessage(`CoT Deep Review failed: ${text}`);
      return;
    }

    panel.renderResult(result, {
      uri: input.document.uri,
      range: input.selection,
      languageId: input.languageId,
      originalText: input.selectedText,
    });
  } catch (err) {
    if (err instanceof GroqServiceError) {
      void vscode.window.showErrorMessage(`CoT Deep Review [${err.kind}]: ${err.message}`);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`CoT Deep Review failed: ${message}`);
  }
}

/**
 * Extract the active editor's highlighted text selection (C) and target
 * language ID (L). Alerts and bails out gracefully when there is no editor,
 * no selection, or only whitespace.
 */
function captureSelection(): ReviewInput | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage(
      'CoT Deep Review: no active editor — open a file and select code first.'
    );
    return undefined;
  }

  const { selection, document } = editor;

  if (selection.isEmpty) {
    void vscode.window.showWarningMessage(
      'CoT Deep Review: no text selected — highlight code, then right-click → ' +
        '"CoT: Run Deep Code Review".'
    );
    return undefined;
  }

  const selectedText = document.getText(selection);
  if (!selectedText.trim()) {
    void vscode.window.showWarningMessage(
      'CoT Deep Review: the selection contains only whitespace — select the code block to review.'
    );
    return undefined;
  }

  return {
    selectedText,
    languageId: document.languageId,
    document,
    selection,
  };
}

/**
 * Resolve the Groq Developer API key:
 *  1. Read `cotReviewer.groqApiKey` from workspace/machine configuration.
 *  2. If missing, prompt with a password-masked input box.
 *  3. Persist a successfully entered key so the prompt is one-time.
 *
 * Returns `undefined` only when the user cancels the prompt.
 */
async function resolveGroqApiKey(): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const stored = (config.get<string>(CONFIG_KEY) ?? '').trim();
  if (stored) {
    return stored;
  }

  const entered = await vscode.window.showInputBox({
    title: 'CoT Deep Review — Groq API Key',
    prompt:
      'Enter your Groq Cloud developer API key (console.groq.com/keys). ' +
      'It will be stored in your settings.',
    placeHolder: 'gsk_…',
    password: true, // never echo the key on screen
    ignoreFocusOut: true,
    validateInput: (value): string | undefined => {
      const v = value.trim();
      if (!v) {
        return 'API key cannot be empty.';
      }
      if (v.length < 16) {
        return 'That does not look like a Groq API key (expected a long gsk_… token).';
      }
      return undefined;
    },
  });

  if (entered === undefined) {
    return undefined; // user cancelled
  }

  const key = entered.trim();

  // Persist for future runs. The setting is machine-scoped via the manifest
  // ("scope": "machine"), so a Global-target update writes it to the user's
  // machine settings. On failure the key still works in-memory this session.
  try {
    await config.update(CONFIG_KEY, key, vscode.ConfigurationTarget.Global);
  } catch {
    // keep key in memory only for this session
  }

  void vscode.window.showInformationMessage(
    'CoT Deep Review: API key saved to settings (cotReviewer.groqApiKey).'
  );
  return key;
}

export function deactivate(): void {
  /* nothing to tear down */
}
