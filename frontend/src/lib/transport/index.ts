export type {
  ApplicationCommandArgs,
  ApplicationCommandMap,
  ApplicationCommandName,
  ApplicationCommandResult,
  BackendEnvironment,
  BackendTransport,
  CapabilityId,
  CreateDevicePairingRequest,
  DevicePairingChallenge,
  RemoteEvent,
  ServerCapabilities,
  SubscriptionRequest,
} from './backendTransport';
export { callApplicationCommand } from './backendTransport';
export {
  BackendTransportProvider,
  useBackendTransport,
} from './BackendTransportProvider';
export { useBackendCapabilities } from './useBackendCapabilities';
export {
  ElectronTransport,
  getElectronBackendTransport,
  type ElectronTransportOptions,
} from './electronTransport';
export { WebTransport, type WebTransportOptions } from './webTransport';
export {
  RemoteDesktopTransport,
  type RemoteDesktopProfile,
} from './remoteDesktopTransport';
export { BoundHostTransport } from './boundHostTransport';
export {
  configureBackendTransport,
  configuredBackendTransport,
  fallbackDesktopTransport,
  getBackendTransport,
  getLocalDesktopTransport,
  mountBackendTransport,
} from './transportRegistry';
