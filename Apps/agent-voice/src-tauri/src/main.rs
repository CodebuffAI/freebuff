// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `agent-voice mcp` runs the stdio MCP companion instead of the GUI.
    if let Some(arg) = std::env::args().nth(1) {
        if arg == "mcp" {
            std::process::exit(agent_voice_lib::mcp::run_stdio());
        }
    }
    agent_voice_lib::run()
}
