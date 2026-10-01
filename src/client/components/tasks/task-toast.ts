/**
 * Undo and confirmation toasts for task actions.
 *
 * Integration shim: the toast primitive is `components/ui/toast.tsx`
 * (track X), whose `useToast()` returns `{ show(options) }` with this
 * option shape and throws outside its `ToastProvider` (mounted once in
 * `app/App.tsx`). Until it lands this hook accepts the same calls and
 * shows nothing; when integrating, import `useToast` at the call sites in
 * TasksPanel.tsx and delete this file. Tests that render the content then
 * mock `../ui/toast.js` or wrap it in `ToastProvider`.
 */

export interface TaskToastOptions {
  readonly message: string;
  readonly action?: { readonly label: string; readonly onAction: () => void };
  readonly duration?: number;
}

export interface TaskToaster {
  show(options: TaskToastOptions): void;
}

const pendingToaster: TaskToaster = { show: () => undefined };

export function useTaskToast(): TaskToaster {
  return pendingToaster;
}
