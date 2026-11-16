// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Model Context Protocol (MCP) stdio server adapter powered by `rmcp`.

use anyhow::Result;
use rmcp::{
    ServerHandler, ServiceExt,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerInfo},
    tool, tool_handler, tool_router,
};
use serde::Serialize;
use std::sync::Arc;

use crate::auth::LoginParams;
use crate::service::FlowService;

/// MCP stdio server that routes tool calls to [`FlowService`].
#[derive(Clone)]
pub(crate) struct FlowMcpServer {
    /// Application service instance.
    service: Arc<FlowService>,
    /// Generated `rmcp` router for registered tools.
    tool_router: ToolRouter<Self>,
}

impl FlowMcpServer {
    /// Creates a [`FlowMcpServer`] that delegates tool calls to `service`.
    pub(crate) fn new(service: Arc<FlowService>) -> Self {
        Self {
            service,
            tool_router: Self::tool_router(),
        }
    }

    /// Serializes `value` as pretty JSON inside an MCP tool success result.
    fn ok_json<T: Serialize>(value: &T) -> CallToolResult {
        match serde_json::to_string_pretty(value) {
            Ok(body) => CallToolResult::success(vec![ContentBlock::text(body)]),
            Err(e) => CallToolResult::error(vec![ContentBlock::text(format!(
                "Failed to serialize response JSON: {}",
                e
            ))]),
        }
    }

    /// Formats a fallible service result as an MCP tool success or error response.
    fn format_result<T: Serialize>(res: Result<T>) -> CallToolResult {
        match res {
            Ok(v) => Self::ok_json(&v),
            Err(e) => CallToolResult::error(vec![ContentBlock::text(e.to_string())]),
        }
    }

    /// Serves the MCP server over standard input and output until the client disconnects.
    pub(crate) async fn serve_stdio(self) -> Result<()> {
        self.serve(rmcp::transport::stdio())
            .await?
            .waiting()
            .await?;
        Ok(())
    }
}

#[tool_router]
impl FlowMcpServer {
    /// Signs in to Google Flow through Chrome and manages session cookies.
    #[tool(description = "Sign in to Google Flow through Google Chrome and save session cookies.")]
    async fn flow_login(&self, Parameters(req): Parameters<LoginParams>) -> CallToolResult {
        Self::format_result(self.service.login(req).await)
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for FlowMcpServer {
    /// Returns MCP server capabilities and version metadata.
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("flow-mcp", env!("CARGO_PKG_VERSION")))
    }
}
