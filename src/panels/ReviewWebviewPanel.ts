/**
 * Webview panel manager for the CoT deep review results.
 *
 * - Singleton: re-running the command reuses the open panel (state is kept
 *   across runs) instead of stacking new ones.
 * - Rendering: delegates to the pure buildWebviewHtml() so every state
 *   (loading / result / error) is just an HTML swap.
 * - Two-way messaging:
 *     webview ➜ host  { command: 'replaceCode', code }
 *     host ➜ webview  { command: 'replaceDone', success, message? }
 */
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { CoTReviewResult } from '../services/groqService';
import { buildWebviewHtml, type WebviewPayload } from './webviewHtml';

/** Where the reviewed selection lives so "Replace in Editor" can hit it. */
export interface ReviewTarget {
  uri: vscode.Uri;
  range: vscode.Range;
  languageId: string;
  /** Exact text at `range` when the review ran (drift detection). */
  originalText: string;
}

interface ReplaceCodeMessage {
  command: 'replaceCode';
  code?: string;
}

export class ReviewWebviewPanel {
  private static current: ReviewWebviewPanel | undefined;
  private static readonly VIEW_TYPE = 'cotDeepReview.reviewPanel';

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private payload: WebviewPayload = { status: 'loading' };
  private target: ReviewTarget | undefined;

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.onMessage(message),
      null,
      this.disposables
    );
  }

  /**
   * Open the review panel in its loading state, or reveal the existing
   * instance (reuse across re-runs).
   */
  static open(context: vscode.ExtensionContext): ReviewWebviewPanel {
    const existing = ReviewWebviewPanel.current;
    if (existing) {
      existing.renderLoading();
      existing.panel.reveal(vscode.ViewColumn.Beside, true);
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      ReviewWebviewPanel.VIEW_TYPE,
      'CoT Deep Review',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    const instance = new ReviewWebviewPanel(panel);
    ReviewWebviewPanel.current = instance;
    instance.renderLoading();
    context.subscriptions.push({ dispose: () => instance.dispose() });
    return instance;
  }

  /** Show the spinner/skeleton while inference runs. */
  renderLoading(): void {
    this.target = undefined;
    this.render({ status: 'loading' });
  }

  /** Populate the four accordions and arm the Replace in Editor button. */
  renderResult(result: CoTReviewResult, target: ReviewTarget): void {
    this.target = target;
    this.render({
      status: 'result',
      languageId: target.languageId,
      result: {
        executionTrace: result.executionTrace,
        vulnerabilityAnalysis: result.vulnerabilityAnalysis,
        impactAssessment: result.impactAssessment,
        refactoredCode: result.refactoredCode,
      },
    });
  }

  /** Surface a failed run inside the panel as well as via notification. */
  renderError(message: string): void {
    this.target = undefined;
    this.render({ status: 'error', message });
  }

  /* ───────────────────────── messaging bridge ─────────────────────────── */

  private async onMessage(raw: unknown): Promise<void> {
    const message = raw as ReplaceCodeMessage | undefined;
    if (!message || typeof message.command !== 'string') {
      return;
    }
    if (message.command === 'replaceCode') {
      const fallback =
        this.payload.status === 'result' ? this.payload.result.refactoredCode : '';
      const code = typeof message.code === 'string' && message.code ? message.code : fallback;
      await this.replaceInEditor(code);
    }
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  /**
   * Host ➜ active editor: replace the reviewed range via editor.edit(),
   * with drift detection when the buffer changed since the review.
   */
  private async replaceInEditor(code: string): Promise<void> {
    const fail = (message: string): void =>
      this.post({ command: 'replaceDone', success: false, message });

    const target = this.target;
    if (!target) {
      fail('No reviewed selection is linked to this panel — run the review again.');
      return;
    }
    if (!code) {
      fail('The refactored code is empty.');
      return;
    }

    try {
      let document =
        vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === target.uri.toString()
        ) ?? (await vscode.workspace.openTextDocument(target.uri));

      const currentText = document.getText(target.range);
      if (currentText !== target.originalText) {
        const choice = await vscode.window.showWarningMessage(
          'CoT Deep Review: the reviewed selection has changed since the analysis. Replace it anyway?',
          { modal: true },
          'Replace Anyway'
        );
        if (choice !== 'Replace Anyway') {
          fail('Replace cancelled — the selection no longer matches the reviewed code.');
          return;
        }
      }

      const editor = await vscode.window.showTextDocument(
        document,
        vscode.window.activeTextEditor?.viewColumn
      );

      const range = document.validateRange(target.range);
      const applied = await editor.edit((editBuilder) => editBuilder.replace(range, code));

      if (!applied) {
        fail('The editor rejected the edit — the buffer may have changed. Re-run the review.');
        return;
      }

      // Retarget so a second click replaces the freshly inserted code.
      const newLines = code.split('\n');
      const end = new vscode.Position(
        range.start.line + newLines.length - 1,
        newLines.length === 1
          ? range.start.character + newLines[newLines.length - 1].length
          : newLines[newLines.length - 1].length
      );
      this.target = { ...target, range: new vscode.Range(range.start, end), originalText: code };

      this.post({ command: 'replaceDone', success: true });
      void vscode.window.setStatusBarMessage(
        '$(check) CoT Deep Review: selection replaced with refactored code.',
        4000
      );
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  /* ───────────────────────────── rendering ─────────────────────────────── */

  private render(payload: WebviewPayload): void {
    this.payload = payload;
    this.panel.webview.html = buildWebviewHtml(payload, randomBytes(16).toString('hex'));
    this.panel.title =
      payload.status === 'result'
        ? `CoT Deep Review — ${payload.languageId}`
        : payload.status === 'error'
          ? 'CoT Deep Review: failed'
          : 'CoT Deep Review: analyzing…';
  }

  private dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    if (ReviewWebviewPanel.current === this) {
      ReviewWebviewPanel.current = undefined;
    }
  }
}
