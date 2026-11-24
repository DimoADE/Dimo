import { createSemanticHook } from './useSemanticKey';
import { Action } from './registry';

/**
 * Semantic keyboard shortcut hooks
 *
 * These hooks provide a clean, semantic interface for common keyboard actions.
 * All key bindings are centrally managed in the registry.
 */

/**
 * Exit/Close action - typically Esc key
 *
 * @example
 * // In a dialog
 * useKeyExit(() => closeDialog(), { scope: Scope.DIALOG });
 */
export const useKeyExit = createSemanticHook(Action.EXIT);

/**
 * Submit action - typically Enter key
 *
 * @example
 * // Submit form in dialog
 * useKeySubmit(() => submitForm(), { scope: Scope.DIALOG });
 */
export const useKeySubmit = createSemanticHook(Action.SUBMIT);

/**
 * Approve pending approval action - typically Enter key
 *
 * @example
 * useKeyApproveRequest(() => approvePendingRequest(), { scope: Scope.APPROVALS });
 */
export const useKeyApproveRequest = createSemanticHook(Action.APPROVE_REQUEST);

/**
 * Deny pending approval action - typically Cmd/Ctrl+Enter
 *
 * @example
 * useKeyDenyApproval(() => denyPendingRequest(), { scope: Scope.GLOBAL });
 */
export const useKeyDenyApproval = createSemanticHook(Action.DENY_APPROVAL);

/**
 * Submit task action - typically Cmd+Enter
 * Primary submit action in task dialog (Create & Start or Update)
 *
 * @example
 * useKeySubmitTask(() => handleSubmit(), { scope: Scope.DIALOG, when: canSubmit });
 */
export const useKeySubmitTask = createSemanticHook(Action.SUBMIT_TASK);

/**
 * Submit comment action - typically Cmd+Enter
 * Submit review comment in diff view
 *
 * @example
 * useKeySubmitComment(() => handleSave(), { scope: Scope.EDIT_COMMENT, when: hasContent });
 */
export const useKeySubmitComment = createSemanticHook(Action.SUBMIT_COMMENT);
