// Project-related dialogs
export {
  ProjectFormDialog,
  type ProjectFormDialogProps,
  type ProjectFormDialogResult,
} from './projects/ProjectFormDialog';
export {
  ProjectEditorSelectionDialog,
  type ProjectEditorSelectionDialogProps,
} from './projects/ProjectEditorSelectionDialog';

// Workspace/session-related dialogs
export { CreatePRDialog } from './tasks/CreatePRDialog';
export {
  ChangeTargetBranchDialog,
  type ChangeTargetBranchDialogProps,
  type ChangeTargetBranchDialogResult,
} from './tasks/ChangeTargetBranchDialog';
export {
  RebaseDialog,
  type RebaseDialogProps,
  type RebaseDialogResult,
} from './tasks/RebaseDialog';
export {
  RestoreLogsDialog,
  type RestoreLogsDialogProps,
  type RestoreLogsDialogResult,
} from './tasks/RestoreLogsDialog';
export {
  GitActionsDialog,
  type GitActionsDialogProps,
} from './tasks/GitActionsDialog';

// Auth dialogs
export { GhCliSetupDialog } from './auth/GhCliSetupDialog';

// Shared/Generic dialogs
export { ConfirmDialog, type ConfirmDialogProps } from './shared/ConfirmDialog';
export {
  ResendCheckpointDialog,
  shouldConfirmResendCheckpoint,
  type ResendCheckpointDialogProps,
  type ResendCheckpointResult,
  type RollbackSafetyReport,
} from './shared/ResendCheckpointDialog';
export {
  FolderPickerDialog,
  type FolderPickerDialogProps,
} from './shared/FolderPickerDialog';
