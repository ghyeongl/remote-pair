use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

pub const CONTROL_ACK_DEADLINE: Duration = Duration::from_secs(5);
const CONTROL_PROTOCOL_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureErrorKind {
    NoDisplay,
    StartFailed,
    AddOutputFailed,
    EncoderFailed,
    EncodeFailed,
    HelperFailed,
    Unknown,
}

#[derive(Clone, Copy)]
pub struct CaptureConfig {
    pub fps: u32,
    pub bitrate: u32,
    pub scale: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ControlOp {
    Start {
        gen: u64,
        rid: String,
        fps: u32,
        bitrate: u32,
        scale: f32,
    },
    Stop {
        gen: u64,
        rid: String,
    },
    Keyframe {
        gen: u64,
        rid: String,
    },
    Bitrate {
        gen: u64,
        rid: String,
        bitrate: u32,
    },
}

impl ControlOp {
    pub fn start(gen: u64, rid: String, config: CaptureConfig) -> Self {
        Self::Start {
            gen,
            rid,
            fps: config.fps,
            bitrate: config.bitrate,
            scale: config.scale,
        }
    }

    pub fn stop(gen: u64, rid: String) -> Self {
        Self::Stop { gen, rid }
    }

    pub fn keyframe(gen: u64, rid: String) -> Self {
        Self::Keyframe { gen, rid }
    }

    pub fn bitrate(gen: u64, rid: String, bitrate: u32) -> Self {
        Self::Bitrate { gen, rid, bitrate }
    }

    fn op(&self) -> AckOp {
        match self {
            Self::Start { .. } => AckOp::Start,
            Self::Stop { .. } => AckOp::Stop,
            Self::Keyframe { .. } => AckOp::Keyframe,
            Self::Bitrate { .. } => AckOp::Bitrate,
        }
    }

    fn gen(&self) -> u64 {
        match self {
            Self::Start { gen, .. }
            | Self::Stop { gen, .. }
            | Self::Keyframe { gen, .. }
            | Self::Bitrate { gen, .. } => *gen,
        }
    }

    fn rid(&self) -> &str {
        match self {
            Self::Start { rid, .. }
            | Self::Stop { rid, .. }
            | Self::Keyframe { rid, .. }
            | Self::Bitrate { rid, .. } => rid,
        }
    }
}

impl Serialize for ControlOp {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Start {
                gen,
                rid,
                fps,
                bitrate,
                scale,
            } => {
                let mut state = serializer.serialize_struct("ControlOp", 7)?;
                state.serialize_field("v", &CONTROL_PROTOCOL_VERSION)?;
                state.serialize_field("op", "start")?;
                state.serialize_field("gen", gen)?;
                state.serialize_field("rid", rid)?;
                state.serialize_field("fps", fps)?;
                state.serialize_field("bitrate", bitrate)?;
                state.serialize_field("scale", scale)?;
                state.end()
            }
            Self::Stop { gen, rid } => {
                let mut state = serializer.serialize_struct("ControlOp", 4)?;
                state.serialize_field("v", &CONTROL_PROTOCOL_VERSION)?;
                state.serialize_field("op", "stop")?;
                state.serialize_field("gen", gen)?;
                state.serialize_field("rid", rid)?;
                state.end()
            }
            Self::Keyframe { gen, rid } => {
                let mut state = serializer.serialize_struct("ControlOp", 4)?;
                state.serialize_field("v", &CONTROL_PROTOCOL_VERSION)?;
                state.serialize_field("op", "keyframe")?;
                state.serialize_field("gen", gen)?;
                state.serialize_field("rid", rid)?;
                state.end()
            }
            Self::Bitrate { gen, rid, bitrate } => {
                let mut state = serializer.serialize_struct("ControlOp", 5)?;
                state.serialize_field("v", &CONTROL_PROTOCOL_VERSION)?;
                state.serialize_field("op", "bitrate")?;
                state.serialize_field("gen", gen)?;
                state.serialize_field("rid", rid)?;
                state.serialize_field("bitrate", bitrate)?;
                state.end()
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AckOp {
    Start,
    Stop,
    Keyframe,
    Bitrate,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum AckResult {
    Started {
        #[serde(rename = "displayId")]
        display_id: Option<u32>,
        width: Option<f64>,
        height: Option<f64>,
    },
    Stopped,
    Superseded {
        #[serde(rename = "activeGen")]
        active_gen: u64,
    },
    Error {
        kind: CaptureErrorKind,
        reason: String,
    },
    Accepted,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ControlAck {
    pub v: u8,
    pub ack: AckOp,
    pub gen: u64,
    pub rid: String,
    pub result: AckResult,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StartedInfo {
    pub display_id: Option<u32>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

#[derive(Debug, Deserialize, PartialEq)]
pub struct CaptureErrorEvent {
    pub v: u8,
    pub gen: u64,
    pub kind: CaptureErrorKind,
    pub reason: String,
}

#[derive(Debug, PartialEq)]
pub enum AppControlFrame {
    Ack(ControlAck),
    CaptureError(CaptureErrorEvent),
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ControlError {
    #[error("control ack timed out for {op:?} gen={gen} rid={rid}")]
    AckTimeout { op: AckOp, gen: u64, rid: String },
    #[error("host reported capture error: {kind:?}: {reason}")]
    CaptureFailed {
        kind: CaptureErrorKind,
        reason: String,
    },
    #[error("op gen={gen} superseded by active gen {active_gen}")]
    Superseded { gen: u64, active_gen: u64 },
    #[error("control channel closed before ack")]
    ChannelClosed,
    #[error("control serialize: {0}")]
    Serialize(String),
}

pub trait ControlWriter: Send + Sync {
    fn write_frame(&self, payload: &[u8]) -> Result<(), ControlError>;
}

#[derive(Default)]
pub struct StdoutControlWriter;

impl ControlWriter for StdoutControlWriter {
    fn write_frame(&self, payload: &[u8]) -> Result<(), ControlError> {
        let len =
            u32::try_from(payload.len()).map_err(|e| ControlError::Serialize(e.to_string()))?;
        let out = std::io::stdout();
        let mut guard = out.lock();
        guard
            .write_all(&len.to_be_bytes())
            .and_then(|_| guard.write_all(payload))
            .and_then(|_| guard.flush())
            .map_err(|_| ControlError::ChannelClosed)
    }
}

type PendingAcks = Arc<tokio::sync::Mutex<HashMap<String, oneshot::Sender<ControlAck>>>>;

#[derive(Clone)]
pub struct ControlClient {
    writer: Arc<dyn ControlWriter>,
    pending: PendingAcks,
    rid_counter: Arc<AtomicU64>,
}

impl ControlClient {
    pub fn stdout() -> Self {
        Self::new(Arc::new(StdoutControlWriter))
    }

    pub fn new(writer: Arc<dyn ControlWriter>) -> Self {
        Self {
            writer,
            pending: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            rid_counter: Arc::new(AtomicU64::new(0)),
        }
    }

    pub async fn start(
        &self,
        gen: u64,
        config: CaptureConfig,
    ) -> Result<StartedInfo, ControlError> {
        let rid = self.next_rid(gen);
        let op = ControlOp::start(gen, rid, config);
        match self.send_op(op).await? {
            AckResult::Started {
                display_id,
                width,
                height,
            } => Ok(StartedInfo {
                display_id,
                width,
                height,
            }),
            AckResult::Error { kind, reason } => Err(ControlError::CaptureFailed { kind, reason }),
            AckResult::Superseded { active_gen } => {
                Err(ControlError::Superseded { gen, active_gen })
            }
            AckResult::Stopped | AckResult::Accepted => Err(ControlError::CaptureFailed {
                kind: CaptureErrorKind::Unknown,
                reason: "host returned non-started result for start op".to_string(),
            }),
        }
    }

    pub fn stop_noack(&self, gen: u64) {
        let rid = self.next_rid(gen);
        if let Err(e) = self.write_op(&ControlOp::stop(gen, rid)) {
            tracing::warn!("serve-webrtc: failed to write stop control op: {e}");
        }
    }

    pub fn keyframe_noack(&self, gen: u64) {
        let rid = self.next_rid(gen);
        if let Err(e) = self.write_op(&ControlOp::keyframe(gen, rid)) {
            tracing::warn!("serve-webrtc: failed to write keyframe control op: {e}");
        }
    }

    pub fn bitrate_noack(&self, gen: u64, bitrate: u32) {
        let rid = self.next_rid(gen);
        if let Err(e) = self.write_op(&ControlOp::bitrate(gen, rid, bitrate)) {
            tracing::warn!("serve-webrtc: failed to write bitrate control op: {e}");
        }
    }

    pub fn deliver_ack(&self, ack: ControlAck) {
        let rid = ack.rid.clone();
        let mut pending = self.pending.blocking_lock();
        if let Some(tx) = pending.remove(&rid) {
            let _ = tx.send(ack);
        } else {
            tracing::debug!("serve-webrtc: dropping control ack with no waiter rid={rid}");
        }
    }

    #[cfg(test)]
    pub async fn deliver_ack_async(&self, ack: ControlAck) {
        let rid = ack.rid.clone();
        let mut pending = self.pending.lock().await;
        if let Some(tx) = pending.remove(&rid) {
            let _ = tx.send(ack);
        } else {
            tracing::debug!("serve-webrtc: dropping control ack with no waiter rid={rid}");
        }
    }

    #[cfg(test)]
    pub async fn pending_count(&self) -> usize {
        self.pending.lock().await.len()
    }

    async fn send_op(&self, op: ControlOp) -> Result<AckResult, ControlError> {
        let op_name = op.op();
        let gen = op.gen();
        let rid = op.rid().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(rid.clone(), tx);
        if let Err(e) = self.write_op(&op) {
            self.pending.lock().await.remove(&rid);
            return Err(e);
        }

        let ack = match tokio::time::timeout(CONTROL_ACK_DEADLINE, rx).await {
            Ok(Ok(ack)) => ack,
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&rid);
                return Err(ControlError::ChannelClosed);
            }
            Err(_) => {
                self.pending.lock().await.remove(&rid);
                return Err(ControlError::AckTimeout {
                    op: op_name,
                    gen,
                    rid,
                });
            }
        };

        if ack.gen != gen || ack.rid != rid || ack.ack != op_name {
            tracing::debug!(
                "serve-webrtc: ignoring mismatched control ack op={:?} gen={} rid={}",
                ack.ack,
                ack.gen,
                ack.rid
            );
            return Err(ControlError::ChannelClosed);
        }
        Ok(ack.result)
    }

    fn write_op(&self, op: &ControlOp) -> Result<(), ControlError> {
        let payload = serde_json::to_vec(op).map_err(|e| ControlError::Serialize(e.to_string()))?;
        self.writer.write_frame(&payload)
    }

    fn next_rid(&self, gen: u64) -> String {
        let seq = self.rid_counter.fetch_add(1, Ordering::Relaxed) + 1;
        format!("{gen}-{seq}")
    }
}

pub fn app_control_frame(frame: &[u8]) -> Option<AppControlFrame> {
    if frame.first().is_none_or(|b| *b != b'{') {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(frame).ok()?;
    if value.get("ack").is_some() {
        return deserialize_value(value).map(AppControlFrame::Ack);
    }
    if value.get("event").and_then(serde_json::Value::as_str) == Some("capture-error") {
        return deserialize_value(value).map(AppControlFrame::CaptureError);
    }
    None
}

fn deserialize_value<T: DeserializeOwned>(value: serde_json::Value) -> Option<T> {
    serde_json::from_value(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct CapturingWriter {
        frames: Mutex<Vec<Vec<u8>>>,
    }

    impl ControlWriter for CapturingWriter {
        fn write_frame(&self, payload: &[u8]) -> Result<(), ControlError> {
            self.frames
                .lock()
                .expect("test lock")
                .push(payload.to_vec());
            Ok(())
        }
    }

    fn config() -> CaptureConfig {
        CaptureConfig {
            fps: 30,
            bitrate: 4_000_000,
            scale: 1.0,
        }
    }

    #[test]
    fn op_serializes_to_versioned_schema() {
        let op = ControlOp::start(42, "42-1".to_string(), config());
        let json = serde_json::to_string(&op).expect("op serializes");
        assert_eq!(
            json,
            r#"{"v":1,"op":"start","gen":42,"rid":"42-1","fps":30,"bitrate":4000000,"scale":1.0}"#
        );

        let op = ControlOp::bitrate(42, "42-2".to_string(), 1_500_000);
        let json = serde_json::to_string(&op).expect("op serializes");
        assert_eq!(
            json,
            r#"{"v":1,"op":"bitrate","gen":42,"rid":"42-2","bitrate":1500000}"#
        );
    }

    #[test]
    fn ack_deserializes_each_result_variant() {
        let cases = [
            r#"{"v":1,"ack":"start","gen":42,"rid":"42-1","result":{"status":"started","displayId":69734662,"width":2560,"height":1440}}"#,
            r#"{"v":1,"ack":"stop","gen":42,"rid":"42-2","result":{"status":"stopped"}}"#,
            r#"{"v":1,"ack":"start","gen":42,"rid":"42-3","result":{"status":"superseded","activeGen":43}}"#,
            r#"{"v":1,"ack":"start","gen":42,"rid":"42-4","result":{"status":"error","kind":"start-failed","reason":"no grant"}}"#,
            r#"{"v":1,"ack":"keyframe","gen":42,"rid":"42-5","result":{"status":"accepted"}}"#,
            r#"{"v":1,"ack":"bitrate","gen":42,"rid":"42-6","result":{"status":"accepted"}}"#,
        ];
        for case in cases {
            let ack: ControlAck = serde_json::from_str(case).expect("ack variant deserializes");
            assert_eq!(ack.v, 1);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn control_client_times_out_when_no_ack() {
        let writer = Arc::new(CapturingWriter::default());
        let client = ControlClient::new(writer);
        let result = client.start(42, config()).await;
        assert!(matches!(
            result,
            Err(ControlError::AckTimeout {
                op: AckOp::Start,
                gen: 42,
                rid
            }) if rid == "42-1"
        ));
        assert_eq!(client.pending_count().await, 0);
    }

    #[tokio::test]
    async fn control_client_ignores_foreign_rid_ack() {
        let writer = Arc::new(CapturingWriter::default());
        let client = ControlClient::new(writer);
        let waiter = {
            let client = client.clone();
            tokio::spawn(async move { client.start(42, config()).await })
        };
        tokio::task::yield_now().await;
        client
            .deliver_ack_async(ControlAck {
                v: 1,
                ack: AckOp::Start,
                gen: 42,
                rid: "42-foreign".to_string(),
                result: AckResult::Started {
                    display_id: Some(1),
                    width: Some(2.0),
                    height: Some(3.0),
                },
            })
            .await;
        assert_eq!(client.pending_count().await, 1);
        client
            .deliver_ack_async(ControlAck {
                v: 1,
                ack: AckOp::Start,
                gen: 42,
                rid: "42-1".to_string(),
                result: AckResult::Started {
                    display_id: Some(69_734_662),
                    width: Some(2560.0),
                    height: Some(1440.0),
                },
            })
            .await;
        let info = waiter.await.expect("join").expect("start resolves");
        assert_eq!(info.display_id, Some(69_734_662));
        assert_eq!(client.pending_count().await, 0);
    }

    #[test]
    fn app_control_frame_deserializes_ack_and_event() {
        let ack =
            br#"{"v":1,"ack":"keyframe","gen":42,"rid":"42-1","result":{"status":"accepted"}}"#;
        assert!(matches!(
            app_control_frame(ack),
            Some(AppControlFrame::Ack(ControlAck {
                ack: AckOp::Keyframe,
                gen: 42,
                ..
            }))
        ));

        let event =
            br#"{"v":1,"event":"capture-error","gen":42,"kind":"encode-failed","reason":"vt"}"#;
        assert!(matches!(
            app_control_frame(event),
            Some(AppControlFrame::CaptureError(CaptureErrorEvent {
                gen: 42,
                kind: CaptureErrorKind::EncodeFailed,
                ..
            }))
        ));
    }
}
