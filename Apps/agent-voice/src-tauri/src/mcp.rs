//! `agent-voice mcp` — a stdio MCP server that lets coding agents ask the
//! user questions by voice (newline-delimited JSON-RPC 2.0).
//!
//! Pro-gated: without an active entitlement the server starts but exposes no
//! tools, so agent configs fail visibly instead of silently misbehaving.

use crate::state::EntitlementFile;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

pub const SERVER_NAME: &str = "agent-voice";
/// MCP protocol revision we implement.
pub const PROTOCOL_VERSION: &str = "2024-11-05";

pub fn ask_tool() -> Value {
    json!({
        "name": "ask_user_by_voice",
        "description": "Dictate a question and wait for the user's spoken answer. Use when you need clarification (or confirmation) and the user is at their machine. The overlay appears, the user speaks, and their exact words are returned as text.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "Short question or instruction to show the user before they speak."
                },
                "timeout_ms": {
                    "type": "number",
                    "description": "Maximum time to wait for the answer in milliseconds (default 30000, max 300000)."
                }
            },
            "required": ["prompt"]
        }
    })
}

fn response(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn text_result(text: &str, is_error: bool) -> Value {
    json!({"content": [{"type": "text", "text": text}], "isError": is_error})
}

/// Handle a single JSON-RPC message. Returns `None` for notifications.
pub fn handle_message(message: &Value, pro: bool, bridge_port: Option<u16>) -> Option<Value> {
    let id = message.get("id")?.clone(); // notifications have no id
    let method = message["method"].as_str().unwrap_or("");
    match method {
        "initialize" => Some(response(
            &id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION")}
            }),
        )),
        "ping" => Some(response(&id, json!({}))),
        "tools/list" => {
            let tools: Vec<Value> = if pro { vec![ask_tool()] } else { vec![] };
            Some(response(&id, json!({"tools": tools})))
        }
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or("");
            if name != "ask_user_by_voice" {
                return Some(error(&id, -32602, &format!("unknown tool '{name}'")));
            }
            if !pro {
                return Some(response(
                    &id,
                    text_result("ask_user_by_voice requires an active Pro license.", true),
                ));
            }
            let Some(port) = bridge_port else {
                return Some(response(
                    &id,
                    text_result("agent-voice desktop app is not running.", true),
                ));
            };
            let prompt = message["params"]["arguments"]["prompt"]
                .as_str()
                .unwrap_or("");
            if prompt.is_empty() {
                return Some(response(&id, text_result("prompt is required", true)));
            }
            let timeout_ms = message["params"]["arguments"]["timeout_ms"]
                .as_u64()
                .unwrap_or(30_000);
            let payload = json!({"type": "ask", "prompt": prompt, "timeout_ms": timeout_ms});
            match crate::bridge::http_post_json(port, &payload) {
                Ok((status, body)) if status == 200 && body["ok"] == true => {
                    let text = body["text"].as_str().unwrap_or("").to_string();
                    Some(response(&id, text_result(&text, false)))
                }
                Ok((_, body)) => {
                    let msg = body["error"]
                        .as_str()
                        .unwrap_or("dictation failed")
                        .to_string();
                    Some(response(&id, text_result(&msg, true)))
                }
                Err(e) => Some(response(
                    &id,
                    text_result(&format!("bridge error: {e}"), true),
                )),
            }
        }
        other => Some(error(&id, -32601, &format!("method '{other}' not found"))),
    }
}

/// The bridge port published by a running GUI, if any.
pub fn bridge_port() -> Option<u16> {
    let raw = std::fs::read_to_string(crate::paths::bridge_path()).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let port = value["port"].as_u64()? as u16;
    // A stale file from a dead process is worse than none: probe the socket.
    let addr = format!("127.0.0.1:{port}")
        .parse::<std::net::SocketAddr>()
        .ok()?;
    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(150))
        .ok()
        .map(|_| port)
}

pub fn current_tier() -> String {
    let raw = match std::fs::read_to_string(crate::paths::entitlement_path()) {
        Ok(r) => r,
        Err(_) => return "free".to_string(),
    };
    match serde_json::from_str::<EntitlementFile>(&raw) {
        Ok(ent) => ent.tier().to_string(),
        Err(_) => "free".to_string(),
    }
}

/// Run the stdio loop. Returns a process exit code.
pub fn run_stdio() -> i32 {
    let _ = crate::paths::ensure_home();
    let pro = current_tier() == "pro";
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            // Cannot answer without an id; JSON-RPC requires dropping garbage.
            continue;
        };
        if let Some(reply) = handle_message(&message, pro, bridge_port()) {
            if writeln!(stdout, "{reply}").is_err() {
                break;
            }
            let _ = stdout.flush();
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_advertises_protocol_and_tools_capability() {
        let msg = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}});
        let reply = handle_message(&msg, false, None).unwrap();
        assert_eq!(reply["id"], 1);
        assert_eq!(reply["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(reply["result"]["serverInfo"]["name"], SERVER_NAME);
        assert!(reply["result"]["capabilities"]["tools"].is_object());
    }

    #[test]
    fn tools_list_is_pro_gated() {
        let msg = json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"});
        let free = handle_message(&msg, false, None).unwrap();
        assert_eq!(free["result"]["tools"].as_array().unwrap().len(), 0);
        let pro = handle_message(&msg, true, None).unwrap();
        let tools = pro["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "ask_user_by_voice");
        // Tool schema requires prompt.
        assert_eq!(tools[0]["inputSchema"]["required"][0], "prompt");
    }

    #[test]
    fn notifications_produce_no_reply() {
        let msg = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        assert!(handle_message(&msg, true, None).is_none());
    }

    #[test]
    fn unknown_method_and_tool_error() {
        let msg = json!({"jsonrpc": "2.0", "id": 3, "method": "prompts/get"});
        let reply = handle_message(&msg, true, None).unwrap();
        assert_eq!(reply["error"]["code"], -32601);

        let msg = json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                         "params": {"name": "nope", "arguments": {}}});
        let reply = handle_message(&msg, true, Some(1)).unwrap();
        assert_eq!(reply["error"]["code"], -32602);
    }

    #[test]
    fn call_on_free_tier_returns_actionable_error() {
        let msg = json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                         "params": {"name": "ask_user_by_voice", "arguments": {"prompt": "hi"}}});
        let reply = handle_message(&msg, false, Some(9)).unwrap();
        assert_eq!(reply["result"]["isError"], true);
        let text = reply["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("Pro license"), "got: {text}");
    }

    #[test]
    fn call_without_running_app_is_actionable() {
        let msg = json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call",
                         "params": {"name": "ask_user_by_voice", "arguments": {"prompt": "hi"}}});
        let reply = handle_message(&msg, true, None).unwrap();
        assert_eq!(reply["result"]["isError"], true);
        let text = reply["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("not running"), "got: {text}");
    }

    #[test]
    fn empty_prompt_is_rejected_before_touching_the_bridge() {
        let msg = json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                         "params": {"name": "ask_user_by_voice", "arguments": {"prompt": ""}}});
        let reply = handle_message(&msg, true, Some(12345)).unwrap();
        assert_eq!(reply["result"]["isError"], true);
    }
}
