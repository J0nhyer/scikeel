use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_FRAME: usize = 65_536;
pub type Result<T> = std::result::Result<T, &'static str>;

pub fn identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.len() <= maximum
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
pub fn digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|v| v.len() == 64
        && v.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Frame {
    schema: u32,
    request_id: String,
    op: String,
    args: Value,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", content = "args", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum Operation {
    Register { instance_id: String, user_id: String },
    Start { instance_id: String, generation: u64, image_digest: String },
    Stop { instance_id: String, generation: u64, reason: String },
    Inspect { instance_id: String },
}
impl Operation {
    pub fn instance_id(&self) -> &str {
        match self { Self::Register { instance_id, .. } | Self::Start { instance_id, .. }
            | Self::Stop { instance_id, .. } | Self::Inspect { instance_id } => instance_id }
    }
}
#[derive(Debug)]
pub struct Request { pub request_id: String, pub operation: Operation }

pub fn parse(bytes: &[u8], peer_uid: u32, platform_uid: u32) -> Result<Request> {
    // Authentication precedes JSON parsing and account lookup.
    if peer_uid != platform_uid { return Err("unauthorized_peer"); }
    if bytes.len() > MAX_FRAME || !bytes.ends_with(b"\n") || bytes[..bytes.len()-1].contains(&b'\n') {
        return Err("invalid_frame");
    }
    let frame: Frame = serde_json::from_slice(bytes).map_err(|_| "invalid_frame")?;
    if frame.schema != 1 || !identifier(&frame.request_id, 128) { return Err("invalid_frame"); }
    let operation: Operation = serde_json::from_value(serde_json::json!({"op": frame.op, "args": frame.args}))
        .map_err(|_| "invalid_operation")?;
    if !identifier(operation.instance_id(), 64) { return Err("invalid_instance"); }
    match &operation {
        Operation::Register { user_id, .. } if !identifier(user_id, 64) => return Err("invalid_user"),
        Operation::Start { generation, image_digest, .. } if *generation == 0 || *generation > 9_007_199_254_740_991 || !digest(image_digest) => return Err("invalid_start"),
        Operation::Stop { generation, reason, .. } if *generation == 0 || *generation > 9_007_199_254_740_991 || !identifier(reason, 64) => return Err("invalid_stop"),
        _ => (),
    }
    Ok(Request { request_id: frame.request_id, operation })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub schema: u32,
    pub request_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
}
impl Response {
    pub fn new(request_id: String, result: Result<Value>) -> Self {
        match result {
            Ok(result) => Self { schema: 1, request_id, ok: true, result: Some(result), error: None },
            Err(error) => Self { schema: 1, request_id, ok: false, result: None, error: Some(error) },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(op: &str, args: Value) -> Vec<u8> {
        (serde_json::json!({"schema":1,"requestId":"request-a","op":op,"args":args}).to_string()+"\n").into_bytes()
    }
    #[test]
    fn fixed_operations_reject_execution_mount_injection_and_unknown_fields() {
        assert!(parse(&frame("register",serde_json::json!({"instanceId":"user-a","userId":"a"})),1000,1000).is_ok());
        for (op,args) in [("exec",serde_json::json!({"command":"id"})),
            ("register",serde_json::json!({"instanceId":"a","userId":"a","mounts":[]})),
            ("inspect",serde_json::json!({"instanceId":"../b"})),
            ("start",serde_json::json!({"instanceId":"a","generation":1,"imageDigest":"science:latest"}))] {
            assert!(parse(&frame(op,args),1000,1000).is_err());
        }
    }
    #[test]
    fn peer_authentication_precedes_parsing_and_rejects_root_as_platform() {
        assert_eq!(parse(b"garbage",0,1000).unwrap_err(),"unauthorized_peer");
        assert_eq!(parse(b"garbage",1001,1000).unwrap_err(),"unauthorized_peer");
    }
    #[test]
    fn frames_are_bounded_single_messages_with_safe_generations() {
        assert!(parse(&vec![b'x'; MAX_FRAME+1],1000,1000).is_err());
        let valid=frame("inspect",serde_json::json!({"instanceId":"a"}));
        assert!(parse(&valid[..valid.len()-1],1000,1000).is_err());
        assert!(parse(&[valid.clone(), valid].concat(),1000,1000).is_err());
        for generation in [0u64,9_007_199_254_740_992] {
            assert!(parse(&frame("stop",serde_json::json!({"instanceId":"a","generation":generation,"reason":"idle"})),1000,1000).is_err());
        }
        let unknown=b"{\"schema\":1,\"requestId\":\"a\",\"op\":\"inspect\",\"args\":{\"instanceId\":\"a\"},\"env\":{}}\n";
        assert!(parse(unknown,1000,1000).is_err());
    }
}
