import { CustomEditor, getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { readHistory, saveInput } from './storage.mjs';

interface BuildTopicHistory {
  load(): Promise<string[]>;
  save(text: string): Promise<void>;
}

export default function (pi: ExtensionAPI) {
  const directory = join(getAgentDir(), 'global-input-history');
  let snapshot: string[] | undefined;

  pi.events.on('global-input-history:build-topic', (request: { ctx: ExtensionContext; history?: BuildTopicHistory }) => {
    const { ctx } = request;
    if (ctx.mode !== 'tui') return;
    request.history = {
      async load() {
        try { return await readHistory(directory); }
        catch {
          ctx.ui.notify('Global input history could not be read; existing data was left untouched.', 'warning');
          return [];
        }
      },
      async save(text) {
        if (ctx.mode !== 'tui' || !ctx.sessionManager.getSessionFile()) return;
        try { await saveInput(directory, text); }
        catch { ctx.ui.notify('Global input history could not be saved; your prompt will continue normally.', 'warning'); }
      },
    };
  });

  pi.on('session_start', async (event, ctx) => {
    snapshot = undefined;
    if (ctx.mode !== 'tui') return;
    try { snapshot = await readHistory(directory); }
    catch { ctx.ui.notify('Global input history could not be read; existing data was left untouched.', 'warning'); }
    // Pi 0.86.1 renders replacement sessions BEFORE extension rebinding.
    // Reconstruct only that already-loaded active replay in the new editor;
    // no session-file discovery, and this array is NEVER used by the writer.
    // Reload rebuilds chat without populating history; restore its recall too.
    // Only startup renders history AFTER binding and needs no extra replay.
    if (snapshot && event.reason !== 'startup') {
      for (const entry of ctx.sessionManager.buildContextEntries()) {
        if (entry.type !== 'message' || entry.message.role !== 'user') continue;
        const content = entry.message.content;
        snapshot.push(typeof content === 'string' ? content : content
          .filter(block => block.type === 'text').map(block => block.text).join(''));
      }
    }
  });

  // Return no resources; history must never become a prompt, skill, or context.
  pi.on('resources_discover', (_event, ctx) => {
    if (ctx.mode !== 'tui' || snapshot === undefined) return;
    const entries = snapshot;
    snapshot = undefined; // Only once per session-start, not repeated discoveries.
    const previous = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = previous
        ? previous(tui, theme, keybindings)
        : new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
      if (typeof editor.addToHistory === 'function') {
        for (const entry of entries) editor.addToHistory(entry);
      } else {
        ctx.ui.notify('Global input history: this editor does not support native recall.', 'warning');
      }
      return editor;
    });
  });

  pi.on('input', async (event, ctx) => {
    // getSessionFile is public on ReadonlySessionManager and is allocated before
    // the first flush. Unlike checking file existence, this admits first prompts.
    if (ctx.mode !== 'tui' || event.source !== 'interactive' || !ctx.sessionManager.getSessionFile()) return;
    try { await saveInput(directory, event.text); }
    catch { ctx.ui.notify('Global input history could not be saved; your prompt will continue normally.', 'warning'); }
    // No transforms, editor snapshots, replay capture, or context API calls.
  });
}
