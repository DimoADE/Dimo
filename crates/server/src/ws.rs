use std::{collections::HashMap, sync::Arc, time::Duration};

use application::{
    ApplicationError, ConversationRepository, ConversationSubscriptionRegistrar, Principal,
};
use async_trait::async_trait;
use axum::{
    extract::{
        Extension, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::Response,
};
use futures::{SinkExt, StreamExt};
use remote_protocol::{
    ConversationId, ErrorCode, ErrorEnvelope, OperationId, RemoteEvent, SubscriptionBootstrap,
    SubscriptionClientMessage, SubscriptionId, SubscriptionResource, SubscriptionServerMessage,
};

use crate::{AuthenticatedCredential, runtime::ServerState};

const LIVE_RECONCILE_INTERVAL: Duration = Duration::from_millis(300);
const REVOCATION_POLL_INTERVAL: Duration = Duration::from_millis(500);
const KEEP_ALIVE_INTERVAL: Duration = Duration::from_secs(15);
const KEEP_ALIVE_TIMEOUT: Duration = Duration::from_secs(45);
const WS_WRITE_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CLIENT_FRAME_BYTES: usize = 1024 * 1024;

struct DurablePollingRegistration;

#[async_trait]
impl ConversationSubscriptionRegistrar for DurablePollingRegistration {
    async fn register(
        &self,
        _subscription_id: SubscriptionId,
        _conversation_id: ConversationId,
    ) -> Result<(), ApplicationError> {
        Ok(())
    }
}

#[derive(Clone)]
enum ActiveSubscription {
    Conversation {
        conversation_id: ConversationId,
        after_sequence: i64,
    },
    WorkflowRun {
        run_id: uuid::Uuid,
        after_sequence: i64,
    },
    HostEvent {
        channel: String,
        after_sequence: i64,
        exact: bool,
    },
    PatchStream {
        channel: String,
        after_sequence: i64,
    },
}

impl ActiveSubscription {
    const fn after_sequence(&self) -> i64 {
        match self {
            Self::Conversation { after_sequence, .. }
            | Self::WorkflowRun { after_sequence, .. }
            | Self::HostEvent { after_sequence, .. }
            | Self::PatchStream { after_sequence, .. } => *after_sequence,
        }
    }

    fn advance(&mut self, sequence: i64) {
        match self {
            Self::Conversation { after_sequence, .. }
            | Self::WorkflowRun { after_sequence, .. }
            | Self::HostEvent { after_sequence, .. }
            | Self::PatchStream { after_sequence, .. } => *after_sequence = sequence,
        }
    }
}

struct PatchStreamRegistry<'a> {
    bus: &'a crate::HostEventBus,
    keys: HashMap<SubscriptionId, String>,
}

impl<'a> PatchStreamRegistry<'a> {
    fn new(bus: &'a crate::HostEventBus) -> Self {
        Self {
            bus,
            keys: HashMap::new(),
        }
    }

    fn track(&mut self, subscription_id: SubscriptionId, task_key: String) {
        self.release(&subscription_id);
        self.bus.retain_stream_task(&task_key);
        self.keys.insert(subscription_id, task_key);
    }

    fn release(&mut self, subscription_id: &SubscriptionId) {
        if let Some(previous_key) = self.keys.remove(subscription_id) {
            self.bus.release_stream_task(&previous_key);
        }
    }
}

impl Drop for PatchStreamRegistry<'_> {
    fn drop(&mut self) {
        for (_, task_key) in self.keys.drain() {
            self.bus.release_stream_task(&task_key);
        }
    }
}

fn has_durable_subscriptions(subscriptions: &HashMap<SubscriptionId, ActiveSubscription>) -> bool {
    subscriptions.values().any(|sub| {
        matches!(
            sub,
            ActiveSubscription::Conversation { .. } | ActiveSubscription::WorkflowRun { .. }
        )
    })
}

pub(crate) async fn ws_handler<R>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
    e2ee_session: Option<Extension<crate::e2ee::E2eeSession>>,
    upgrade: WebSocketUpgrade,
) -> Response
where
    R: ConversationRepository + Send + Sync + 'static,
{
    let e2ee = e2ee_session.map(|ext| ext.0);
    upgrade
        .max_frame_size(MAX_CLIENT_FRAME_BYTES)
        .max_message_size(MAX_CLIENT_FRAME_BYTES)
        .protocols(["dimo.v1"])
        .on_upgrade(move |socket| handle_socket(socket, state, credential, e2ee))
}

async fn handle_socket<R>(
    socket: WebSocket,
    state: Arc<ServerState<R>>,
    credential: AuthenticatedCredential,
    e2ee_session: Option<crate::e2ee::E2eeSession>,
) where
    R: ConversationRepository + Send + Sync + 'static,
{
    let (mut sender, mut receiver) = socket.split();
    let mut ws_e2ee_key: Option<[u8; 32]> = e2ee_session
        .as_ref()
        .filter(|s| s.active_e2ee)
        .map(|s| s.key);
    let mut subscriptions = HashMap::<SubscriptionId, ActiveSubscription>::new();
    let mut patch_streams = PatchStreamRegistry::new(&state.events);
    let mut live_ticker = tokio::time::interval(LIVE_RECONCILE_INTERVAL);
    live_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut idle_reconcile_skip_ticks: u8 = 0;
    let mut revocation_ticker = tokio::time::interval(REVOCATION_POLL_INTERVAL);
    revocation_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut keepalive_ticker = tokio::time::interval_at(
        tokio::time::Instant::now() + KEEP_ALIVE_INTERVAL,
        KEEP_ALIVE_INTERVAL,
    );
    keepalive_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_client_activity = tokio::time::Instant::now();
    let principal = credential.principal();
    let mut host_events = state.events.subscribe();
    let mut patch_events = state.events.subscribe_patch_streams();

    loop {
        tokio::select! {
            incoming = receiver.next() => {
                let Some(Ok(message)) = incoming else {
                    break;
                };
                last_client_activity = tokio::time::Instant::now();
                let text = match message {
                    Message::Close(_) => break,
                    Message::Ping(payload) => {
                        if send_frame(&mut sender, Message::Pong(payload)).await.is_err() {
                            break;
                        }
                        continue;
                    }
                    Message::Pong(_) => continue,
                    Message::Text(text) => text,
                    Message::Binary(_) => continue,
                };
                let Ok(decoded_text) = decode_ws_text(
                    &text,
                    e2ee_session.as_ref(),
                    &mut ws_e2ee_key,
                ) else {
                    break;
                };
                let message = match serde_json::from_str::<SubscriptionClientMessage>(&decoded_text) {
                    Ok(message) => message,
                    Err(error) => {
                        if send_message(
                            &mut sender,
                            SubscriptionServerMessage::Error {
                                error: ErrorEnvelope::new(
                                    ErrorCode::BadRequest,
                                    format!("invalid subscription message: {error}"),
                                    false,
                                    OperationId::new(),
                                ),
                                subscription_id: None,
                            },
                            ws_e2ee_key.as_ref(),
                        )
                        .await
                        .is_err()
                        {
                            break;
                        }
                        continue;
                    }
                };
                idle_reconcile_skip_ticks = 0;
                if handle_client_message(
                    state.as_ref(),
                    &principal,
                    message,
                    &mut subscriptions,
                    &mut patch_streams,
                    &mut sender,
                    ws_e2ee_key.as_ref(),
                )
                .await
                .is_err()
                {
                    break;
                }
            }
            _ = revocation_ticker.tick() => {
                match state.is_credential_active(&credential).await {
                    Ok(true) => {}
                    Ok(false) => {
                        let _ = send_message(
                            &mut sender,
                            SubscriptionServerMessage::Error {
                                error: ErrorEnvelope::new(
                                    ErrorCode::Unauthorized,
                                    "credential has been revoked",
                                    false,
                                    OperationId::new(),
                                ),
                                subscription_id: None,
                            },
                            ws_e2ee_key.as_ref(),
                        )
                        .await;
                        break;
                    }
                    Err(_) => break,
                }
            }
            patch_event = patch_events.recv() => {
                let event = match patch_event {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(
                            skipped,
                            "websocket patch stream receiver lagged; detaching active patch streams for snapshot resync"
                        );
                        if detach_lagged_patch_streams(
                            skipped,
                            &mut subscriptions,
                            &mut patch_streams,
                            &mut sender,
                            ws_e2ee_key.as_ref(),
                        )
                        .await
                        .is_err()
                        {
                            break;
                        }
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                let matches = subscriptions
                    .iter()
                    .filter(|(_, subscription)| match subscription {
                        ActiveSubscription::PatchStream {
                            channel,
                            after_sequence,
                        } => event.sequence > *after_sequence && *channel == event.channel,
                        _ => false,
                    })
                    .map(|(id, _)| *id)
                    .collect::<Vec<_>>();
                for subscription_id in matches {
                    if let Some(subscription) = subscriptions.get_mut(&subscription_id) {
                        subscription.advance(event.sequence);
                    }
                    if send_message(
                        &mut sender,
                        SubscriptionServerMessage::Event {
                            subscription_id,
                            event: RemoteEvent {
                                sequence: event.sequence,
                                kind: event.channel.clone(),
                                payload: event.payload.clone(),
                            },
                        },
                        ws_e2ee_key.as_ref(),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                }
            }
            host_event = host_events.recv() => {
                let event = match host_event {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(
                            skipped,
                            "websocket host event receiver lagged; reconciling durable subscriptions and invalidations"
                        );
                        if has_durable_subscriptions(&subscriptions)
                            && reconcile_durable_subscriptions(
                                state.as_ref(),
                                &principal,
                                &mut subscriptions,
                                None,
                                &mut sender,
                                ws_e2ee_key.as_ref(),
                            )
                            .await
                            .is_err()
                        {
                            break;
                        }
                        if recover_lagged_host_events(
                            state.as_ref(),
                            skipped,
                            &mut subscriptions,
                            &mut sender,
                            ws_e2ee_key.as_ref(),
                        )
                        .await
                        .is_err()
                        {
                            break;
                        }
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                let matches = subscriptions
                    .iter()
                    .filter(|(_, subscription)| match subscription {
                        ActiveSubscription::HostEvent {
                            channel,
                            after_sequence,
                            exact,
                        } => {
                            event.sequence > *after_sequence
                                && (*channel == event.channel
                                    || (!*exact
                                        && event
                                            .channel
                                            .strip_prefix(channel.as_str())
                                            .is_some_and(|rest| rest.starts_with(':'))))
                        }
                        _ => false,
                    })
                    .map(|(id, _)| *id)
                    .collect::<Vec<_>>();
                for subscription_id in matches {
                    if let Some(subscription) = subscriptions.get_mut(&subscription_id) {
                        subscription.advance(event.sequence);
                    }
                    if send_message(
                        &mut sender,
                        SubscriptionServerMessage::Event {
                            subscription_id,
                            event: RemoteEvent {
                                sequence: event.sequence,
                                kind: event.channel.clone(),
                                payload: event.payload.clone(),
                            },
                        },
                        ws_e2ee_key.as_ref(),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                }
                if let Some(target_conv) = conversation_wake_target(&event.channel)
                    && subscriptions.values().any(|sub| match sub {
                        ActiveSubscription::Conversation { conversation_id, .. } => {
                            target_conv.is_none_or(|cid| cid == conversation_id.as_uuid())
                        }
                        _ => false,
                    })
                {
                    idle_reconcile_skip_ticks = 0;
                    if reconcile_durable_subscriptions(
                        state.as_ref(),
                        &principal,
                        &mut subscriptions,
                        Some(target_conv),
                        &mut sender,
                        ws_e2ee_key.as_ref(),
                    )
                    .await
                    .is_err()
                    {
                        break;
                    }
                }
            }
            _ = keepalive_ticker.tick() => {
                if last_client_activity.elapsed() >= KEEP_ALIVE_TIMEOUT {
                    break;
                }
                if send_frame(&mut sender, Message::Ping(Default::default()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            _ = live_ticker.tick(), if has_durable_subscriptions(&subscriptions) => {
                let has_workflow_runs = subscriptions
                    .values()
                    .any(|sub| matches!(sub, ActiveSubscription::WorkflowRun { .. }));
                if !has_workflow_runs && idle_reconcile_skip_ticks > 0 {
                    idle_reconcile_skip_ticks -= 1;
                    continue;
                }
                match reconcile_durable_subscriptions(
                    state.as_ref(),
                    &principal,
                    &mut subscriptions,
                    None,
                    &mut sender,
                    ws_e2ee_key.as_ref(),
                )
                .await
                {
                    Ok(emitted_any) => {
                        idle_reconcile_skip_ticks = if emitted_any || has_workflow_runs {
                            0
                        } else {
                            4
                        };
                    }
                    Err(()) => break,
                }
            }
        }
    }
}

async fn detach_lagged_patch_streams<S>(
    skipped: u64,
    subscriptions: &mut HashMap<SubscriptionId, ActiveSubscription>,
    patch_streams: &mut PatchStreamRegistry<'_>,
    sender: &mut S,
    e2ee_key: Option<&[u8; 32]>,
) -> Result<(), ()>
where
    S: futures::Sink<Message> + Unpin,
{
    let lagged_ids = subscriptions
        .iter()
        .filter_map(|(id, subscription)| {
            matches!(subscription, ActiveSubscription::PatchStream { .. }).then_some(*id)
        })
        .collect::<Vec<_>>();
    for subscription_id in lagged_ids {
        subscriptions.remove(&subscription_id);
        patch_streams.release(&subscription_id);
        send_message(
            sender,
            SubscriptionServerMessage::Detached {
                subscription_id,
                reason: format!(
                    "patch stream lagged by {skipped} messages; reconnect to resync snapshot"
                ),
            },
            e2ee_key,
        )
        .await?;
    }
    Ok(())
}

async fn recover_lagged_host_events<R, S>(
    state: &ServerState<R>,
    skipped: u64,
    subscriptions: &mut HashMap<SubscriptionId, ActiveSubscription>,
    sender: &mut S,
    e2ee_key: Option<&[u8; 32]>,
) -> Result<(), ()>
where
    R: ConversationRepository + Send + Sync + 'static,
    S: futures::Sink<Message> + Unpin,
{
    let host_subs = subscriptions
        .iter()
        .filter_map(|(id, subscription)| match subscription {
            ActiveSubscription::HostEvent {
                channel,
                after_sequence,
                exact,
            } => Some((*id, channel.clone(), *after_sequence, *exact)),
            _ => None,
        })
        .collect::<Vec<_>>();

    for (subscription_id, channel, after_sequence, exact) in host_subs {
        if crate::HostEventBus::is_patch_stream_channel(&channel) {
            subscriptions.remove(&subscription_id);
            send_message(
                sender,
                SubscriptionServerMessage::Detached {
                    subscription_id,
                    reason: format!(
                        "event stream lagged by {skipped} messages; reconnect to resync snapshot"
                    ),
                },
                e2ee_key,
            )
            .await?;
            continue;
        }
        for event in state
            .events
            .latest_invalidations_for(&channel, exact, after_sequence)
        {
            if let Some(subscription) = subscriptions.get_mut(&subscription_id) {
                subscription.advance(event.sequence);
            }
            send_message(
                sender,
                SubscriptionServerMessage::Event {
                    subscription_id,
                    event: RemoteEvent {
                        sequence: event.sequence,
                        kind: event.channel,
                        payload: event.payload,
                    },
                },
                e2ee_key,
            )
            .await?;
        }
    }
    Ok(())
}

fn conversation_wake_target(channel: &str) -> Option<Option<uuid::Uuid>> {
    if channel == "conversation-events" {
        return Some(None);
    }
    channel
        .strip_prefix("conversation-events:")
        .and_then(|raw| uuid::Uuid::parse_str(raw).ok())
        .map(Some)
}

async fn reconcile_durable_subscriptions<R, S>(
    state: &ServerState<R>,
    principal: &Principal,
    subscriptions: &mut HashMap<SubscriptionId, ActiveSubscription>,
    conversation_filter: Option<Option<uuid::Uuid>>,
    sender: &mut S,
    e2ee_key: Option<&[u8; 32]>,
) -> Result<bool, ()>
where
    R: ConversationRepository + Send + Sync + 'static,
    S: futures::Sink<Message> + Unpin,
{
    let active = subscriptions
        .iter()
        .filter(
            |(_, subscription)| match (subscription, conversation_filter) {
                (
                    ActiveSubscription::HostEvent { .. } | ActiveSubscription::PatchStream { .. },
                    _,
                ) => false,
                (
                    ActiveSubscription::Conversation {
                        conversation_id, ..
                    },
                    Some(Some(target)),
                ) => conversation_id.as_uuid() == target,
                (ActiveSubscription::Conversation { .. }, Some(None)) => true,
                (ActiveSubscription::WorkflowRun { .. }, Some(_)) => false,
                (_, None) => true,
            },
        )
        .map(|(id, subscription)| (*id, subscription.clone()))
        .collect::<Vec<_>>();
    let mut emitted_any = false;
    for (subscription_id, subscription) in active {
        let bootstrap = match subscription {
            ActiveSubscription::HostEvent { .. } | ActiveSubscription::PatchStream { .. } => {
                continue;
            }
            ActiveSubscription::Conversation {
                conversation_id,
                after_sequence,
            } => {
                state
                    .core
                    .attach_conversation(
                        principal,
                        subscription_id,
                        conversation_id,
                        after_sequence,
                        &DurablePollingRegistration,
                    )
                    .await
            }
            ActiveSubscription::WorkflowRun {
                run_id,
                after_sequence,
            } => {
                state
                    .core
                    .attach_workflow_run(principal, subscription_id, run_id, after_sequence)
                    .await
            }
        };
        let Ok(bootstrap) = bootstrap else {
            continue;
        };
        let high_water_mark = bootstrap.high_water_mark;
        let mut cursor = subscription.after_sequence();
        for event in live_events(bootstrap) {
            emitted_any = true;
            cursor = cursor.max(event.sequence);
            send_message(
                sender,
                SubscriptionServerMessage::Event {
                    subscription_id,
                    event,
                },
                e2ee_key,
            )
            .await?;
        }
        if let Some(active) = subscriptions.get_mut(&subscription_id) {
            active.advance(cursor.max(high_water_mark));
        }
    }
    Ok(emitted_any)
}

async fn handle_client_message<R, S>(
    state: &ServerState<R>,
    principal: &Principal,
    message: SubscriptionClientMessage,
    subscriptions: &mut HashMap<SubscriptionId, ActiveSubscription>,
    patch_streams: &mut PatchStreamRegistry<'_>,
    sender: &mut S,
    e2ee_key: Option<&[u8; 32]>,
) -> Result<(), ()>
where
    R: ConversationRepository + Send + Sync + 'static,
    S: futures::Sink<Message> + Unpin,
{
    match message {
        SubscriptionClientMessage::Attach { request } => {
            let subscription_id = request.subscription_id;
            patch_streams.release(&subscription_id);
            let attached =
                attach_resource(state, principal, request, subscriptions, patch_streams).await;
            let (bootstrap, active) = match attached {
                Ok(attached) => attached,
                Err(error) => {
                    send_message(
                        sender,
                        SubscriptionServerMessage::Error {
                            error,
                            subscription_id: Some(subscription_id),
                        },
                        e2ee_key,
                    )
                    .await?;
                    return Ok(());
                }
            };
            send_message(
                sender,
                SubscriptionServerMessage::Ready { subscription_id },
                e2ee_key,
            )
            .await?;
            let mut cursor = active.after_sequence();
            if let Some(snapshot) = bootstrap.snapshot {
                cursor = cursor.max(snapshot.through_sequence);
                send_message(
                    sender,
                    SubscriptionServerMessage::Snapshot {
                        subscription_id,
                        snapshot,
                    },
                    e2ee_key,
                )
                .await?;
            }
            for event in bootstrap.replay {
                cursor = cursor.max(event.sequence);
                send_message(
                    sender,
                    SubscriptionServerMessage::Event {
                        subscription_id,
                        event,
                    },
                    e2ee_key,
                )
                .await?;
            }
            send_message(
                sender,
                SubscriptionServerMessage::Live {
                    subscription_id,
                    high_water_mark: bootstrap.high_water_mark,
                },
                e2ee_key,
            )
            .await?;
            subscriptions.insert(subscription_id, {
                let mut active = active;
                active.advance(cursor.max(bootstrap.high_water_mark));
                active
            });
        }
        SubscriptionClientMessage::Detach { subscription_id } => {
            subscriptions.remove(&subscription_id);
            patch_streams.release(&subscription_id);
        }
        SubscriptionClientMessage::Ping => {
            send_message(sender, SubscriptionServerMessage::Pong, e2ee_key).await?;
        }
    }
    Ok(())
}

async fn attach_resource<R>(
    state: &ServerState<R>,
    principal: &Principal,
    request: remote_protocol::SubscriptionRequest,
    subscriptions: &mut HashMap<SubscriptionId, ActiveSubscription>,
    patch_streams: &mut PatchStreamRegistry<'_>,
) -> Result<(SubscriptionBootstrap, ActiveSubscription), ErrorEnvelope>
where
    R: ConversationRepository + Send + Sync + 'static,
{
    match request.resource {
        SubscriptionResource::Conversation {
            conversation_id,
            after_sequence,
        } => {
            let bootstrap = state
                .core
                .attach_conversation(
                    principal,
                    request.subscription_id,
                    conversation_id,
                    after_sequence,
                    &DurablePollingRegistration,
                )
                .await
                .map_err(application::ApplicationError::into_envelope)?;
            Ok((
                bootstrap,
                ActiveSubscription::Conversation {
                    conversation_id,
                    after_sequence,
                },
            ))
        }
        SubscriptionResource::WorkflowRun {
            run_id,
            after_sequence,
        } => {
            let bootstrap = state
                .core
                .attach_workflow_run(principal, request.subscription_id, run_id, after_sequence)
                .await
                .map_err(application::ApplicationError::into_envelope)?;
            Ok((
                bootstrap,
                ActiveSubscription::WorkflowRun {
                    run_id,
                    after_sequence,
                },
            ))
        }
        SubscriptionResource::HostEvent {
            channel,
            after_sequence,
        } => {
            authorize_host_channel(principal, &channel)?;
            let bootstrap = state
                .events
                .attach_bootstrap(request.subscription_id, &channel, after_sequence)
                .map_err(|message| {
                    ErrorEnvelope::new(ErrorCode::BadRequest, message, false, OperationId::new())
                })?;
            let after_sequence = bootstrap.high_water_mark;
            Ok((
                bootstrap,
                ActiveSubscription::HostEvent {
                    channel,
                    after_sequence,
                    exact: false,
                },
            ))
        }
        SubscriptionResource::PatchStream { stream, args } => {
            let command = crate::patch_stream_subscribe_command(&stream).ok_or_else(|| {
                ErrorEnvelope::new(
                    ErrorCode::BadRequest,
                    format!("unknown patch stream `{stream}`"),
                    false,
                    OperationId::new(),
                )
            })?;
            let channel = crate::patch_stream_channel(&stream, &args).map_err(|message| {
                ErrorEnvelope::new(ErrorCode::BadRequest, message, false, OperationId::new())
            })?;
            authorize_host_channel(principal, &channel)?;
            let bootstrap = state
                .events
                .attach_bootstrap(request.subscription_id, &channel, 0)
                .map_err(|message| {
                    ErrorEnvelope::new(ErrorCode::BadRequest, message, false, OperationId::new())
                })?;
            let after_sequence = bootstrap.high_water_mark;
            subscriptions.insert(
                request.subscription_id,
                ActiveSubscription::PatchStream {
                    channel: channel.clone(),
                    after_sequence,
                },
            );
            let task_key =
                crate::patch_stream_task_key(&stream, &args).unwrap_or_else(|_| channel.clone());
            // Track before awaiting so dropping/cancelling the socket mid-attach still
            // releases the producer task via `PatchStreamRegistry::drop`.
            patch_streams.track(request.subscription_id, task_key);
            if let Err(error) = state
                .commands
                .execute_name(principal, command, OperationId::new(), args)
                .await
            {
                patch_streams.release(&request.subscription_id);
                subscriptions.remove(&request.subscription_id);
                return Err(error);
            }
            Ok((
                bootstrap,
                ActiveSubscription::PatchStream {
                    channel,
                    after_sequence,
                },
            ))
        }
    }
}

fn authorize_host_channel(principal: &Principal, channel: &str) -> Result<(), ErrorEnvelope> {
    let Some(scope) = crate::HostEventBus::required_scope(channel) else {
        return Err(ErrorEnvelope::new(
            ErrorCode::NotFound,
            format!("host event channel `{channel}` is not registered"),
            false,
            OperationId::new(),
        ));
    };
    if !principal.allows(scope) {
        return Err(ErrorEnvelope::new(
            ErrorCode::Forbidden,
            format!("principal lacks {scope}"),
            false,
            OperationId::new(),
        ));
    }
    Ok(())
}

fn decode_ws_text(
    text: &str,
    e2ee_session: Option<&crate::e2ee::E2eeSession>,
    ws_e2ee_key: &mut Option<[u8; 32]>,
) -> Result<String, ()> {
    if let Some(session) = e2ee_session
        && let Ok(wrapper) = serde_json::from_str::<serde_json::Value>(text)
        && wrapper.get("type").and_then(|v| v.as_str()) == Some("e2ee")
    {
        let cipher_b64 = wrapper.get("d").and_then(|v| v.as_str()).ok_or(())?;
        let plain_bytes =
            crate::e2ee::decrypt_payload(&session.key, crate::e2ee::AAD_WS, cipher_b64)
                .map_err(|_| ())?;
        let plain_str = String::from_utf8(plain_bytes).map_err(|_| ())?;
        *ws_e2ee_key = Some(session.key);
        crate::e2ee::mark_session_active_e2ee(&session.session_id);
        return Ok(plain_str);
    }

    if ws_e2ee_key.is_some() || e2ee_session.is_some_and(|session| session.active_e2ee) {
        return Err(());
    }

    Ok(text.to_string())
}

async fn send_frame<S>(sender: &mut S, frame: Message) -> Result<(), ()>
where
    S: futures::Sink<Message> + Unpin,
{
    match tokio::time::timeout(WS_WRITE_TIMEOUT, sender.send(frame)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) | Err(_) => Err(()),
    }
}

async fn send_message<S>(
    sender: &mut S,
    message: SubscriptionServerMessage,
    e2ee_key: Option<&[u8; 32]>,
) -> Result<(), ()>
where
    S: futures::Sink<Message> + Unpin,
{
    let text = serde_json::to_string(&message).map_err(|_| ())?;
    let wire_text = if let Some(key) = e2ee_key {
        let encrypted = crate::e2ee::encrypt_payload(key, crate::e2ee::AAD_WS, text.as_bytes())
            .map_err(|_| ())?;
        serde_json::json!({
            "type": "e2ee",
            "d": encrypted,
        })
        .to_string()
    } else {
        text
    };
    send_frame(sender, Message::Text(wire_text.into())).await
}

/// Live polling reuses `attach`, which parks `after_sequence == 0` events in
/// `snapshot` and leaves `replay` empty. A brand-new conversation attaches at
/// sequence 0 before any events exist; the first turn would then be captured
/// in a snapshot the poll loop never forwarded, and the cursor would skip it.
fn live_events(bootstrap: SubscriptionBootstrap) -> Vec<RemoteEvent> {
    if !bootstrap.replay.is_empty() {
        return bootstrap.replay;
    }
    bootstrap
        .snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.payload.get("events").cloned())
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_e2ee_socket_rejects_plaintext_frames() {
        let session = crate::e2ee::E2eeSession {
            session_id: "sess-ws-test".into(),
            key: [0x2a; 32],
            client_pub_b64: String::new(),
            server_pub_b64: String::new(),
            active_e2ee: true,
            last_used: std::time::Instant::now(),
        };
        let mut active_key = Some(session.key);
        let plaintext = r#"{"type":"ping"}"#;
        assert!(decode_ws_text(plaintext, Some(&session), &mut active_key).is_err());

        let encrypted =
            crate::e2ee::encrypt_payload(&session.key, crate::e2ee::AAD_WS, plaintext.as_bytes())
                .expect("encrypt ws payload");
        let wrapped = serde_json::json!({ "type": "e2ee", "d": encrypted }).to_string();
        assert_eq!(
            decode_ws_text(&wrapped, Some(&session), &mut active_key).expect("decrypt ws frame"),
            plaintext
        );
    }

    #[test]
    fn socket_without_e2ee_allows_plaintext_until_e2ee_frame_arrives() {
        let session = crate::e2ee::E2eeSession {
            session_id: "sess-ws-upgrade".into(),
            key: [0x11; 32],
            client_pub_b64: String::new(),
            server_pub_b64: String::new(),
            active_e2ee: false,
            last_used: std::time::Instant::now(),
        };
        let mut active_key = None;
        let plaintext = r#"{"type":"ping"}"#;
        assert_eq!(
            decode_ws_text(plaintext, Some(&session), &mut active_key).expect("initial plaintext"),
            plaintext
        );

        let encrypted =
            crate::e2ee::encrypt_payload(&session.key, crate::e2ee::AAD_WS, plaintext.as_bytes())
                .expect("encrypt ws payload");
        let wrapped = serde_json::json!({ "type": "e2ee", "d": encrypted }).to_string();
        assert!(decode_ws_text(&wrapped, Some(&session), &mut active_key).is_ok());
        assert!(active_key.is_some());
        assert!(decode_ws_text(plaintext, Some(&session), &mut active_key).is_err());
    }

    #[tokio::test]
    async fn desktop_token_websocket_stays_active_and_streams_project_creation() {
        use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
        use tokio_tungstenite::{
            connect_async,
            tungstenite::{Message as ClientMessage, client::IntoClientRequest, http::HeaderValue},
        };

        let data_dir = tempfile::tempdir().expect("temp data dir");
        let project_dir = tempfile::tempdir().expect("temp project dir");
        let desktop_token = "desktop-owner-token-with-at-least-32-bytes";

        let headless = crate::HeadlessServer::bootstrap(
            crate::ServerBootstrapConfig::new(data_dir.path())
                .with_desktop_mode(true)
                .with_desktop_token(crate::ServerToken::new(desktop_token))
                .with_autostart_web_service(false),
        )
        .await
        .expect("bootstrap desktop headless server");

        let app = headless.runtime().router();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move { axum::serve(listener, app).await });

        let mut request = format!("ws://{address}/api/v1/ws")
            .into_client_request()
            .expect("request");
        let encoded = URL_SAFE_NO_PAD.encode(desktop_token);
        request.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_str(&format!("dimo.v1, dimo.token.{encoded}")).expect("protocol"),
        );
        let (mut socket, _) = connect_async(request).await.expect("websocket connect");

        async fn next_msg(
            socket: &mut tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            stage: &str,
        ) -> SubscriptionServerMessage {
            let frame = tokio::time::timeout(Duration::from_secs(3), socket.next())
                .await
                .unwrap_or_else(|_| panic!("websocket message timeout while {stage}"))
                .expect("websocket open")
                .expect("valid websocket frame");
            serde_json::from_slice(&frame.into_data()).expect("server message")
        }

        let subscription_id = SubscriptionId::new();
        socket
            .send(ClientMessage::Text(
                serde_json::to_string(&SubscriptionClientMessage::Attach {
                    request: remote_protocol::SubscriptionRequest {
                        subscription_id,
                        resource: SubscriptionResource::PatchStream {
                            stream: "projects".to_string(),
                            args: serde_json::json!({}),
                        },
                    },
                })
                .expect("attach projects stream")
                .into(),
            ))
            .await
            .expect("send attach");

        let mut saw_initial_ready_patch = false;
        for _ in 0..8 {
            match next_msg(&mut socket, "waiting for initial Ready patch").await {
                SubscriptionServerMessage::Error { error, .. } => {
                    panic!("desktop websocket unexpectedly errored: {error:?}");
                }
                SubscriptionServerMessage::Event {
                    subscription_id: event_sub_id,
                    event,
                } if event_sub_id == subscription_id => {
                    if event.payload == serde_json::json!("Ready") {
                        saw_initial_ready_patch = true;
                        break;
                    }
                }
                SubscriptionServerMessage::Ready { .. }
                | SubscriptionServerMessage::Live { .. }
                | SubscriptionServerMessage::Snapshot { .. }
                | SubscriptionServerMessage::Pong => {}
                other => panic!("unexpected server message before Ready patch: {other:?}"),
            }
        }
        assert!(
            saw_initial_ready_patch,
            "expected initial projects patch stream Ready event"
        );

        // Allow the initial revocation poll tick to execute and ensure the desktop owner
        // credential is never treated as revoked.
        tokio::time::sleep(Duration::from_millis(400)).await;

        socket
            .send(ClientMessage::Text(
                serde_json::to_string(&SubscriptionClientMessage::Ping)
                    .expect("ping")
                    .into(),
            ))
            .await
            .expect("send ping");

        let mut saw_pong = false;
        for _ in 0..4 {
            match next_msg(&mut socket, "waiting for Pong after revocation tick").await {
                SubscriptionServerMessage::Pong => {
                    saw_pong = true;
                    break;
                }
                SubscriptionServerMessage::Error { error, .. } => {
                    panic!("desktop websocket revoked after poll interval: {error:?}");
                }
                SubscriptionServerMessage::Event { .. } => {}
                other => panic!("unexpected message waiting for Pong: {other:?}"),
            }
        }
        assert!(saw_pong, "expected Pong on live desktop websocket");

        let client = reqwest::Client::new();
        let create_response = client
            .post(format!("http://{address}/api/v1/call/create_project"))
            .bearer_auth(desktop_token)
            .json(&remote_protocol::CommandRequest {
                operation_id: OperationId::new(),
                args: serde_json::json!({
                    "payload": {
                        "name": "Desktop Folder Test",
                        "rootPath": project_dir.path().to_string_lossy(),
                        "repositories": []
                    }
                }),
            })
            .send()
            .await
            .expect("call create_project");
        let status = create_response.status();
        let create_text = create_response
            .text()
            .await
            .expect("read create_project response body");
        assert!(
            status.is_success(),
            "create_project failed with status {status}: {create_text}"
        );
        let create_body: serde_json::Value =
            serde_json::from_str(&create_text).expect("parse create_project response JSON");
        let created_project_id = create_body
            .pointer("/result/id")
            .or_else(|| create_body.pointer("/data/id"))
            .or_else(|| create_body.get("id"))
            .and_then(|value| value.as_str())
            .unwrap_or_else(|| panic!("missing created project id in response: {create_body}"))
            .to_string();

        let mut saw_created_project_patch = false;
        let mut seen_after_create = Vec::new();
        for _ in 0..8 {
            let msg = next_msg(
                &mut socket,
                &format!(
                    "waiting for project {created_project_id} patch (seen so far: {seen_after_create:?})"
                ),
            )
            .await;
            match msg {
                SubscriptionServerMessage::Error { error, .. } => {
                    panic!("desktop websocket errored during project creation: {error:?}");
                }
                SubscriptionServerMessage::Event {
                    subscription_id: event_sub_id,
                    event,
                } if event_sub_id == subscription_id => {
                    seen_after_create.push(event.payload.clone());
                    if event.payload.to_string().contains(&created_project_id) {
                        saw_created_project_patch = true;
                        break;
                    }
                }
                other => seen_after_create.push(serde_json::json!(format!("{other:?}"))),
            }
        }
        assert!(
            saw_created_project_patch,
            "expected live projects patch containing created project id {created_project_id}; seen: {seen_after_create:?}"
        );

        server.abort();
        drop(headless);
    }

    #[tokio::test]
    async fn patch_stream_receiver_is_isolated_from_terminal_output_bursts() {
        let bus = crate::HostEventBus::new();
        let mut host_rx = bus.subscribe();
        let mut patch_rx = bus.subscribe_patch_streams();

        bus.emit("projects-stream", serde_json::json!({ "seq": "before" }));
        for i in 0..(crate::host::events::BUS_CAPACITY + 64) {
            bus.emit("terminal-output:00000000-0000-0000-0000-000000000000", i);
        }
        bus.emit("projects-stream", serde_json::json!({ "seq": "after" }));

        // The general host receiver lags under the terminal burst,
        // while the dedicated patch receiver retains both patch events intact.
        assert!(matches!(
            host_rx.recv().await,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_))
        ));
        let first = patch_rx.recv().await.expect("first patch event");
        let second = patch_rx.recv().await.expect("second patch event");
        assert_eq!(first.payload, serde_json::json!({ "seq": "before" }));
        assert_eq!(second.payload, serde_json::json!({ "seq": "after" }));
    }

    #[tokio::test]
    async fn detach_lagged_patch_streams_emits_detached_and_keeps_non_patch_subscriptions() {
        let bus = crate::HostEventBus::new();
        let mut patch_streams = PatchStreamRegistry::new(&bus);
        let patch_sub_id = SubscriptionId::new();
        let host_sub_id = SubscriptionId::new();
        patch_streams.track(patch_sub_id, "projects-stream".to_string());

        let mut subscriptions = HashMap::new();
        subscriptions.insert(
            patch_sub_id,
            ActiveSubscription::PatchStream {
                channel: "projects-stream".to_string(),
                after_sequence: 1,
            },
        );
        subscriptions.insert(
            host_sub_id,
            ActiveSubscription::HostEvent {
                channel: "theme-changed".to_string(),
                after_sequence: 1,
                exact: false,
            },
        );

        let (mut sink, rx) = futures::channel::mpsc::unbounded::<Message>();
        detach_lagged_patch_streams(42, &mut subscriptions, &mut patch_streams, &mut sink, None)
            .await
            .expect("detach lagged patch streams");
        drop(sink);
        let sent = rx.collect::<Vec<_>>().await;

        assert!(!subscriptions.contains_key(&patch_sub_id));
        assert!(subscriptions.contains_key(&host_sub_id));
        assert_eq!(sent.len(), 1);
        let Message::Text(text) = &sent[0] else {
            panic!("expected text websocket frame");
        };
        let parsed: SubscriptionServerMessage =
            serde_json::from_str(text).expect("parse server message");
        match parsed {
            SubscriptionServerMessage::Detached {
                subscription_id,
                reason,
            } => {
                assert_eq!(subscription_id, patch_sub_id);
                assert!(
                    reason.contains("42"),
                    "reason should mention skipped message count"
                );
            }
            other => panic!("expected Detached message, got {other:?}"),
        }
    }
}
