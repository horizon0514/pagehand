import { sessionRegistry } from '../lib/debugger-bridge/sessionRegistry';
import { tools } from '../lib/tools';
import { activateLedger, getActiveLedger } from '../lib/ledger/activeLedger';
import {
  deleteTask,
  loadTasks,
  runExportTask,
  saveTask,
  taskFromExtraction,
  type ExportTask,
} from '../lib/tasks/exportTasks';
// Only the side panel ever loads this module (see sidepanel/main.tsx), so
// reaching into its store here is safe — and it is the only place the tool-call
// sequence of a real agent turn exists in one piece.
import { useConversationStore } from '../sidepanel/state/conversationStore';

/**
 * Test-only bridge. Playwright can load this page (an extension page, so it has
 * full chrome.* access) and drive the real tool layer against a real tab —
 * covering actual chrome.debugger attachment, live CDP responses, and genuine
 * input dispatch, none of which the Vitest suite can reach.
 *
 * Attachment is explicit rather than going through ensureSession()'s
 * "active tab" lookup, because under Playwright the panel page is itself a tab
 * and focus is not a reliable way to pick the target.
 *
 * Only reachable in builds made with VITE_E2E=true; installExposedTestApi is
 * dead code eliminated otherwise.
 */
export function installExposedTestApi(): void {
  Object.assign(window, {
    __cdp: {
      attach: (tabId: number) => sessionRegistry.attach(tabId),
      detach: () => sessionRegistry.detach(),
      attachedTabId: () => sessionRegistry.getAttached()?.getTabId() ?? null,

      /** Invoke a tool exactly as the agent loop would. */
      call: async (name: string, args: unknown = {}) => {
        const registry = tools as unknown as Record<
          string,
          { execute: (input: unknown, options: unknown) => Promise<unknown> }
        >;
        const tool = registry[name];
        if (!tool) throw new Error(`No such tool: ${name}`);
        return tool.execute(args, { toolCallId: 'e2e', messages: [] });
      },

      toolNames: () => Object.keys(tools),

      /**
       * The transcript of the current thread, reduced to what a measurement
       * needs: which tools ran, in order, and how the turn ended. Reading the
       * store beats scraping the rendered transcript — the DOM collapses and
       * re-orders tool cards, and a round-trip count has to be exact.
       */
      transcript: () => {
        const { messages, isStreaming } = useConversationStore.getState();
        return {
          isStreaming,
          messages: messages.map((m) => ({
            role: m.role,
            text: m.text,
            toolCalls: m.toolCalls.map((tc) => ({ name: tc.name, status: tc.status })),
            stop: m.stop ?? null,
            error: m.error ?? null,
          })),
        };
      },

      // The ledger tools write to whichever ledger is active. In the app the
      // side panel activates one per thread; tests set it explicitly for the
      // same reason attachment is explicit — deterministic control beats
      // depending on React mount timing.
      ledger: {
        activate: (threadId: string) => activateLedger(threadId),
        get: () => getActiveLedger(),
      },

      // Saved exports. saveCurrent mirrors what LedgerPanel's save button does,
      // so the test exercises the path the user has rather than one built for it.
      tasks: {
        list: () => loadTasks(),
        remove: (id: string) => deleteTask(id),
        run: (task: ExportTask) => runExportTask(task),
        saveCurrent: (name: string) => {
          const ledger = getActiveLedger();
          if (!ledger?.extraction) throw new Error('The active ledger has no extraction to save.');
          return saveTask(
            taskFromExtraction(
              name,
              ledger.extraction.url,
              ledger.extraction.schema,
              ledger.findings.length,
              ledger.findings.map((f) => f.key),
            ),
          );
        },
      },
    },
  });
}
