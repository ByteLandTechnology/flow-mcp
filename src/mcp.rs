// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Model Context Protocol (MCP) stdio server adapter powered by `rmcp`.

use anyhow::Result;
use rmcp::{
    ErrorData, ServerHandler, ServiceExt,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, ContentBlock, Implementation, ListResourceTemplatesResult,
        ListResourcesResult, PaginatedRequestParams, ProtocolVersion, ReadResourceRequestParams,
        ReadResourceResponse, ReadResourceResult, ResourceTemplate, ServerCapabilities, ServerInfo,
    },
    service::{RequestContext, RoleServer},
    tool, tool_handler, tool_router,
};
use serde::Serialize;
use serde_json::json;
use std::future::Future;
use std::sync::Arc;
use tokio::time::Duration;

use crate::assets::{AssetsParams, DownloadParams, RenameParams, TrashParams};
use crate::auth::LoginParams;
use crate::characters::{CharacterEditParams, CharacterParams, VoicesParams};
use crate::collections::CollectionsParams;
use crate::db::{DOWNLOAD_ASSET_RESOURCE_PREFIX, DOWNLOAD_RESOURCE_PREFIX, DownloadsParams};
use crate::generation::{AgentImagesParams, EditParams, GenerateParams};
use crate::project::{NewProjectParams, ProjectsParams, StatusParams};
use crate::queue::{JobIdParams, WaitParams};
use crate::scenes::{ScenesParams, VideoParams};
use crate::service::{self, FlowService, ResourceReadError};

/// Inline wait limit (`45_000` ms) before slow tools return a pending task handle.
const PATIENCE_MS: u64 = 45_000;

/// Maximum resource entries returned per `resources/list` page.
const RESOURCE_PAGE_SIZE: usize = 100;

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

    /// Runs `fut` in a background task and waits up to 45 seconds before returning a pending payload.
    async fn run_patiently<F>(&self, tool: &str, fut: F) -> CallToolResult
    where
        F: Future<Output = Result<Vec<ContentBlock>>> + Send + 'static,
    {
        let task_id = format!("task_{}", &uuid::Uuid::new_v4().to_string()[..8]);
        let (tx, rx) =
            tokio::sync::oneshot::channel::<std::result::Result<Vec<ContentBlock>, String>>();
        tokio::spawn(async move {
            let payload = fut.await.map_err(|e| e.to_string());
            let _ = tx.send(payload);
        });

        match tokio::time::timeout(Duration::from_millis(PATIENCE_MS), rx).await {
            Ok(Ok(Ok(blocks))) => CallToolResult::success(blocks),
            Ok(Ok(Err(e))) => CallToolResult::error(vec![ContentBlock::text(e)]),
            Ok(Err(_)) => CallToolResult::error(vec![ContentBlock::text(format!(
                "{} failed unexpectedly before returning a result",
                tool
            ))]),
            Err(_) => {
                let pending = json!({
                    "pending": true,
                    "task_id": task_id,
                    "message": format!("{} continues in the background. Check flow_status or flow_downloads later.", tool)
                });
                Self::ok_json(&pending)
            }
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

    /// Lists assets in the active Google Flow project.
    #[tool(
        description = "List assets in the active Google Flow project with optional query, kind, collection, and limit filters."
    )]
    async fn flow_assets(&self, Parameters(req): Parameters<AssetsParams>) -> CallToolResult {
        Self::format_result(self.service.assets(req).await)
    }

    /// Renames assets or collections in the active Google Flow project.
    #[tool(description = "Rename assets or collections in the active Google Flow project.")]
    async fn flow_rename(&self, Parameters(req): Parameters<RenameParams>) -> CallToolResult {
        Self::format_result(self.service.rename(req.items).await)
    }

    /// Lists, creates, renames, populates, uncollects, or deletes collections.
    #[tool(
        description = "List, create, rename, populate, uncollect, or delete asset collections in the active Google Flow project."
    )]
    async fn flow_collections(
        &self,
        Parameters(req): Parameters<CollectionsParams>,
    ) -> CallToolResult {
        Self::format_result(self.service.collections(req).await)
    }

    /// Moves a matching asset or collection to trash in the active Google Flow project.
    #[tool(description = "Move a matching asset to trash in the active Google Flow project.")]
    async fn flow_trash(&self, Parameters(req): Parameters<TrashParams>) -> CallToolResult {
        Self::format_result(self.service.trash(&req.r#match).await)
    }

    /// Downloads an image or video asset from the active Google Flow project.
    #[tool(description = "Download an image or video asset from the active Google Flow project.")]
    async fn flow_download(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(req): Parameters<DownloadParams>,
    ) -> CallToolResult {
        let service = Arc::clone(&self.service);
        let include_link = context
            .protocol_version()
            .is_none_or(|v| v.as_str() >= ProtocolVersion::V_2025_06_18.as_str());
        self.run_patiently("flow_download", async move {
            let record = service.download(req).await?;
            let payload = json!({
                "file": record.file_path,
                "resource_uri": record.resource_uri,
                "record": record,
            });
            let text = serde_json::to_string_pretty(&payload)?;
            let mut blocks = vec![ContentBlock::text(text)];
            if include_link {
                blocks.push(ContentBlock::resource_link(
                    service::record_to_mcp_resource(&record),
                ));
            }
            Ok(blocks)
        })
        .await
    }

    /// Queries, inspects, reads chunks from, prunes, deletes, or clears local downloads.
    #[tool(
        description = "List, inspect, read binary chunks, prune, delete, or clear locally downloaded media files."
    )]
    async fn flow_downloads(&self, Parameters(req): Parameters<DownloadsParams>) -> CallToolResult {
        Self::format_result(self.service.downloads(req).await)
    }

    /// Signs in to Google Flow through Chrome and manages session cookies.
    #[tool(description = "Sign in to Google Flow through Google Chrome and save session cookies.")]
    async fn flow_login(&self, Parameters(req): Parameters<LoginParams>) -> CallToolResult {
        Self::format_result(self.service.login(req).await)
    }

    /// Queues an image or video generation job in Google Flow.
    #[tool(description = "Queue an image or video generation job in Google Flow.")]
    async fn flow_generate(&self, Parameters(req): Parameters<GenerateParams>) -> CallToolResult {
        Self::format_result(self.service.generate(req).await)
    }

    /// Queues a Flow Agent Mode batch image job.
    #[tool(description = "Queue a Flow Agent Mode batch image job.")]
    async fn flow_agent_images(
        &self,
        Parameters(req): Parameters<AgentImagesParams>,
    ) -> CallToolResult {
        Self::format_result(self.service.agent_images(req).await)
    }

    /// Queues an edit job for a matching asset in Google Flow.
    #[tool(description = "Queue an edit job for a matching asset in Google Flow.")]
    async fn flow_edit(&self, Parameters(req): Parameters<EditParams>) -> CallToolResult {
        Self::format_result(self.service.edit(req).await)
    }

    /// Lists, creates, adds clips to, renames, or trashes Google Flow scenes.
    #[tool(description = "List, create, add clips to, rename, or trash Google Flow scenes.")]
    async fn flow_scenes(&self, Parameters(req): Parameters<ScenesParams>) -> CallToolResult {
        Self::format_result(self.service.scenes(req).await)
    }

    /// Trims a video immediately or queues a video extension job.
    #[tool(description = "Trim a Google Flow video immediately or queue a video extension job.")]
    async fn flow_video(&self, Parameters(req): Parameters<VideoParams>) -> CallToolResult {
        Self::format_result(self.service.video(req).await)
    }

    /// Queues a character reference sheet job in the active Google Flow project.
    #[tool(
        description = "Queue a character reference sheet job in the active Google Flow project."
    )]
    async fn flow_character(&self, Parameters(req): Parameters<CharacterParams>) -> CallToolResult {
        Self::format_result(self.service.character(req).await)
    }

    /// Queues an edit job for a character asset in Google Flow.
    #[tool(description = "Queue an edit job for a character asset in Google Flow.")]
    async fn flow_character_edit(
        &self,
        Parameters(req): Parameters<CharacterEditParams>,
    ) -> CallToolResult {
        Self::format_result(self.service.character_edit(req).await)
    }

    /// Lists character entities in the active Google Flow project.
    #[tool(description = "List character entities in the active Google Flow project.")]
    async fn flow_characters(&self) -> CallToolResult {
        Self::format_result(self.service.characters().await)
    }

    /// Lists available Google Flow character voices.
    #[tool(description = "List available Google Flow character voices.")]
    async fn flow_voices(&self, Parameters(req): Parameters<VoicesParams>) -> CallToolResult {
        Self::format_result(self.service.voices(req).await)
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for FlowMcpServer {
    /// Returns MCP server capabilities and version metadata.
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_server_info(Implementation::new("flow-mcp", env!("CARGO_PKG_VERSION")))
    }

    /// Lists downloaded media files as paginated MCP resources.
    async fn list_resources(
        &self,
        request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> std::result::Result<ListResourcesResult, ErrorData> {
        let all = self
            .service
            .list_download_resources()
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let offset = match request.and_then(|p| p.cursor) {
            Some(c) => c.parse::<usize>().map_err(|_| {
                ErrorData::invalid_params("Invalid pagination cursor for resources/list", None)
            })?,
            None => 0,
        };
        if offset > all.len() || (offset == all.len() && offset > 0) {
            return Err(ErrorData::invalid_params(
                "Pagination cursor out of range for resources/list",
                None,
            ));
        }
        let end = (offset + RESOURCE_PAGE_SIZE).min(all.len());
        let page = all[offset..end].to_vec();
        let mut res = ListResourcesResult::with_all_items(page);
        if end < all.len() {
            res.next_cursor = Some(end.to_string());
        }
        Ok(res)
    }

    /// Advertises MCP resource URI templates for record IDs and Google Flow asset IDs.
    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> std::result::Result<ListResourceTemplatesResult, ErrorData> {
        let by_id = ResourceTemplate::new(
            format!("{}{{id}}", DOWNLOAD_RESOURCE_PREFIX),
            "flow-download-by-id",
        )
        .with_title("Downloaded Media by Record ID")
        .with_description("Read a downloaded media file by its SQLite row ID.");

        let by_asset = ResourceTemplate::new(
            format!("{}{{asset_id}}", DOWNLOAD_ASSET_RESOURCE_PREFIX),
            "flow-download-by-asset-id",
        )
        .with_title("Downloaded Media by Asset ID")
        .with_description("Read the latest downloaded media file for a Google Flow asset ID.");

        Ok(ListResourceTemplatesResult::with_all_items(vec![
            by_id, by_asset,
        ]))
    }

    /// Reads one downloaded media file addressed by a `flow://downloads/...` URI.
    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> std::result::Result<ReadResourceResponse, ErrorData> {
        match self.service.read_download_resource(&request.uri).await {
            Ok(contents) => Ok(ReadResourceResult::new(vec![contents]).into()),
            Err(ResourceReadError::NotFound(msg)) => Err(ErrorData::resource_not_found(msg, None)),
            Err(ResourceReadError::InvalidUri(msg) | ResourceReadError::TooLarge(msg)) => {
                Err(ErrorData::invalid_params(msg, None))
            }
            Err(ResourceReadError::Internal(msg)) => Err(ErrorData::internal_error(msg, None)),
        }
    }
}
