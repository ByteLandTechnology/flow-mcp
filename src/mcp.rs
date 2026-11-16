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
use serde_json::json;
use std::sync::Arc;
use tokio::time::Duration;

use crate::auth::LoginParams;
use crate::project::{NewProjectParams, ProjectsParams, StatusParams};
use crate::queue::{JobIdParams, WaitParams};
use crate::service::FlowService;

/// Inline wait limit (`45_000` ms) before slow tools return a pending task handle.
const PATIENCE_MS: u64 = 45_000;

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
    /// Checks Google Flow session state, active project, queue, SQLite index count, and browser readiness.
    #[tool(
        description = "Check Google Flow session state, active project, job queue, SQLite index count, and browser readiness."
    )]
    async fn flow_status(&self, Parameters(req): Parameters<StatusParams>) -> CallToolResult {
        Self::format_result(self.service.status(req.probe.unwrap_or(false)).await)
    }

    /// Waits for queued or running Google Flow jobs to finish, returning early after 45 seconds if still pending.
    #[tool(description = "Wait for queued or running Google Flow jobs to finish.")]
    async fn flow_wait(&self, Parameters(req): Parameters<WaitParams>) -> CallToolResult {
        match tokio::time::timeout(Duration::from_millis(PATIENCE_MS), self.service.wait(req)).await
        {
            Ok(res) => Self::format_result(res),
            Err(_) => {
                let jobs = self.service.list_jobs().await;
                let pending = json!({
                    "pending": true,
                    "jobs": jobs,
                    "message": "Jobs are still running in the background. Check flow_status or call flow_wait again later."
                });
                Self::ok_json(&pending)
            }
        }
    }

    /// Cancels a queued or running Google Flow job.
    #[tool(description = "Cancel a queued or running Google Flow job.")]
    async fn flow_cancel(&self, Parameters(req): Parameters<JobIdParams>) -> CallToolResult {
        Self::format_result(self.service.cancel(&req.id).await)
    }

    /// Retries a failed or cancelled Google Flow job.
    #[tool(description = "Retry a failed or cancelled Google Flow job.")]
    async fn flow_retry(&self, Parameters(req): Parameters<JobIdParams>) -> CallToolResult {
        Self::format_result(self.service.retry(&req.id).await)
    }

    /// Creates a new Google Flow project.
    #[tool(description = "Create a new Google Flow project.")]
    async fn flow_new_project(
        &self,
        Parameters(req): Parameters<NewProjectParams>,
    ) -> CallToolResult {
        Self::format_result(self.service.new_project(req.title.as_deref()).await)
    }

    /// Lists, creates, opens, renames, or deletes Google Flow projects.
    #[tool(description = "List, create, open, rename, or delete Google Flow projects.")]
    async fn flow_projects(&self, Parameters(req): Parameters<ProjectsParams>) -> CallToolResult {
        Self::format_result(self.service.projects(req).await)
    }

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
