// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Flow Agent session and turn operations.
//!
//! Keep the Agent connection in a separate Chrome page. Reserve the job queue
//! while a turn can change project assets.

use anyhow::{Context, Result, ensure};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio::time::{Duration, sleep};

use crate::config::FLOW_URL;
use crate::engine::{BackgroundPage, ChromeEngine, checked_runtime_result, validate_local_files};
use crate::project::project_workspace_url;
use crate::queue::JobQueue;

/// Action ID for a permission request that starts a new turn when it gets a response.
const LEGACY_PERMISSION_ID: &str = "legacy-permission";

/// Number of checks for the Agent runtime after navigation.
const BIND_ATTEMPTS: u32 = 48;

/// Time between checks for the Agent runtime.
const BIND_INTERVAL: Duration = Duration::from_millis(250);

/// Time between checks for turn completion.
const TURN_POLL_INTERVAL: Duration = Duration::from_millis(300);

/// Number of consecutive failed turn checks before the queue releases the lock.
const TURN_POLL_ERROR_LIMIT: u32 = 3;

/// Time for the page to upload attachments and submit the message.
const ATTACHMENT_CALL_TIMEOUT: Duration = Duration::from_secs(120);

/// Operation on a Flow Agent session or turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum AgentAction {
    /// Lists the sessions in the specified project.
    ListSessions,
    /// Creates a session and submits its first message.
    CreateSession,
    /// Changes the title of a saved session.
    RenameSession,
    /// Deletes a saved session and its conversation history.
    DeleteSession,
    /// Reads conversation history, including the active turn.
    ListMessages,
    /// Sends a message to an existing session.
    SendMessage,
    /// Reads the specified turn.
    GetTurn,
    /// Reconnects to a pending turn after a page disconnect.
    Resume,
    /// Answers a question, sets a permission, or selects a plan.
    Respond,
    /// Stops the active turn.
    Stop,
}

/// Decision on an Agent permission request or plan.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum AgentDecision {
    /// Approves the current permission request.
    Approve,
    /// Approves the request and remembers the decision in Flow.
    ApproveAndRemember,
    /// Denies the current permission request.
    Deny,
    /// Runs the full proposed plan in a new turn.
    RunFullPlan,
    /// Generates a preview of the plan in a new turn.
    Previz,
}

/// Answer to one question in the Agent turn.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
struct AgentAnswer {
    /// Question ID from the turn result.
    question_id: String,
    /// Selected option IDs from the question.
    #[serde(default)]
    option_ids: Vec<String>,
    /// Optional free text for the question.
    text: Option<String>,
}

/// Parameters for `flow_agent`.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub(crate) struct AgentParams {
    /// Agent operation to perform.
    action: AgentAction,
    /// Google Flow project ID.
    project_id: String,
    /// Session ID for all actions except listing and creation.
    session_id: Option<String>,
    /// Text to send on creation or on a new turn.
    message: Option<String>,
    /// Existing image or video IDs in the specified project.
    asset_ids: Option<Vec<String>>,
    /// Local image or video file paths to upload to the specified project.
    files: Option<Vec<String>>,
    /// New session title for rename.
    title: Option<String>,
    /// Number of the turn to read, resume, respond to, or stop. Starts at one.
    turn: Option<u32>,
    /// ID of the pending action to respond to.
    action_id: Option<String>,
    /// Decision to send for a permission or plan request.
    decision: Option<AgentDecision>,
    /// Answers to an Agent question request.
    answers: Option<Vec<AgentAnswer>>,
    /// Maximum number of turns to list. Default is 20.
    #[schemars(range(min = 1, max = 100))]
    limit: Option<u32>,
    /// Exclusive upper limit on turn numbers in the list.
    before_turn: Option<u32>,
}

impl AgentParams {
    /// Checks the required fields before opening or changing the browser page.
    fn validate(&self) -> Result<()> {
        ensure!(valid_id(&self.project_id), "Invalid project_id");
        match self.action {
            AgentAction::ListSessions | AgentAction::CreateSession => {
                ensure!(
                    self.session_id.is_none(),
                    "This action does not accept session_id"
                );
            }
            _ => ensure!(
                self.session_id.as_deref().is_some_and(valid_id),
                "A valid session_id is required"
            ),
        }
        if matches!(
            self.action,
            AgentAction::CreateSession | AgentAction::SendMessage
        ) {
            ensure!(
                self.message.as_deref().is_some_and(has_text),
                "A non-empty message is required"
            );
            ensure!(
                self.asset_ids
                    .as_ref()
                    .is_none_or(|ids| ids.iter().all(|id| has_text(id))),
                "Each asset ID must contain text"
            );
        } else {
            ensure!(
                self.asset_ids.is_none() && self.files.is_none(),
                "Use attachments with create_session or send_message"
            );
        }
        if self.action == AgentAction::RenameSession {
            ensure!(
                self.title.as_deref().is_some_and(has_text),
                "A non-empty title is required"
            );
        }
        if matches!(
            self.action,
            AgentAction::GetTurn | AgentAction::Resume | AgentAction::Respond | AgentAction::Stop
        ) {
            ensure!(
                self.turn.is_some_and(|turn| turn > 0),
                "A positive turn number is required"
            );
        }
        if self.action == AgentAction::Respond {
            ensure!(
                self.action_id.as_deref().is_some_and(has_text),
                "action_id is required"
            );
            ensure!(
                self.decision.is_some() != self.answers.is_some(),
                "Supply one of decision or answers"
            );
        }
        ensure!(
            self.limit.is_none_or(|limit| (1..=100).contains(&limit)),
            "limit must be between 1 and 100"
        );
        ensure!(
            self.before_turn.is_none_or(|turn| turn > 0),
            "before_turn must be positive"
        );
        Ok(())
    }

    /// Returns true when the action starts or reconnects a turn.
    fn starts_turn(&self) -> bool {
        matches!(
            self.action,
            AgentAction::CreateSession | AgentAction::SendMessage | AgentAction::Resume
        ) || (self.action == AgentAction::Respond
            && (self.action_id.as_deref() == Some(LEGACY_PERMISSION_ID)
                || matches!(
                    self.decision,
                    Some(AgentDecision::RunFullPlan | AgentDecision::Previz)
                )))
    }

    /// Returns true when the action can change remote state.
    fn writes(&self) -> bool {
        !matches!(
            self.action,
            AgentAction::ListSessions | AgentAction::ListMessages | AgentAction::GetTurn
        )
    }
}

/// Returns true for IDs that can be one Flow URL segment.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// Returns true when the value contains a character other than white space.
fn has_text(s: &str) -> bool {
    !s.trim().is_empty()
}

/// Owns the Agent page and serializes requests to its runtime.
pub(crate) struct AgentChat {
    /// Page and project currently used for chat.
    state: Mutex<Option<AgentPage>>,
}

/// Agent page for a project.
struct AgentPage {
    /// Browser page that holds the Agent connection.
    page: Arc<BackgroundPage>,
    /// Project loaded in this page.
    project_id: String,
}

impl AgentChat {
    /// Creates the chat controller. Chrome starts on the first request.
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(None),
        }
    }

    /// Runs a chat operation in a page bound to the requested project.
    pub(crate) async fn run(
        &self,
        engine: &ChromeEngine,
        queue: &JobQueue,
        request: AgentParams,
    ) -> Result<Value> {
        request.validate()?;
        let files = attachment_paths(request.files.as_deref()).await?;
        let mut state = self.state.lock().await;
        if state.as_ref().is_none_or(|agent| !agent.page.is_alive()) {
            let page = Arc::new(engine.open_background_page().await?);
            *state = Some(AgentPage {
                page,
                project_id: String::new(),
            });
        }
        let agent = state.as_mut().context("Agent page unavailable")?;
        agent.open(&request.project_id).await?;
        let mut args = serde_json::to_value(&request)?;
        if let Some(fields) = args.as_object_mut() {
            fields.remove("files");
        }
        let execution = if request.starts_turn() {
            ensure!(
                !agent.busy().await?,
                "An Agent turn is active. Read it or stop it before you start another turn"
            );
            Some(queue.try_lock_execution()?)
        } else {
            None
        };
        if request.action == AgentAction::CreateSession {
            let result = checked_runtime_result(
                agent
                    .page
                    .call("agentAllocate", json!([request.project_id]))
                    .await?,
            )?;
            args["session_id"] = Value::String(
                result["session_id"]
                    .as_str()
                    .context("Flow did not allocate a session ID")?
                    .to_string(),
            );
        }
        let session_id = args["session_id"].clone();
        if !files.is_empty() {
            agent.page.stage_agent_files(&files).await?;
            args["file_count"] = json!(files.len());
        }
        let result = if !files.is_empty()
            || request
                .asset_ids
                .as_ref()
                .is_some_and(|ids| !ids.is_empty())
        {
            agent
                .page
                .call_with_timeout("agentOp", json!([args]), ATTACHMENT_CALL_TIMEOUT)
                .await
        } else {
            agent.page.call("agentOp", json!([args])).await
        };
        if let Some(guard) = execution {
            tokio::spawn(hold_while_active(
                Arc::clone(&agent.page),
                request.project_id.clone(),
                guard,
            ));
        }
        match result {
            Ok(value) => {
                let mut value = checked_runtime_result(value)?;
                value["project_id"] = Value::String(request.project_id);
                Ok(value)
            }
            Err(error) if request.writes() => anyhow::bail!(
                "outcome_unknown (project {}, session {session_id}): {error:#}",
                request.project_id
            ),
            Err(error) => Err(error),
        }
    }
}

/// Checks the local attachments and returns absolute paths for Chrome.
async fn attachment_paths(files: Option<&[String]>) -> Result<Vec<String>> {
    validate_local_files(files, "Agent attachment").await?;
    let mut paths = Vec::new();
    for file in files.unwrap_or_default() {
        let path = tokio::fs::canonicalize(file)
            .await
            .with_context(|| format!("Cannot open Agent attachment {file}"))?;
        paths.push(
            path.into_os_string()
                .into_string()
                .map_err(|_| anyhow::anyhow!("Agent attachment path must use UTF-8: {file}"))?,
        );
    }
    Ok(paths)
}

impl AgentPage {
    /// Loads the project and binds its Agent service.
    async fn open(&mut self, project_id: &str) -> Result<()> {
        if self.project_id == project_id
            && self.page.call("agentBound", json!([project_id])).await? == Value::Bool(true)
        {
            return Ok(());
        }
        if !self.project_id.is_empty() {
            ensure!(
                !self.busy().await?,
                "An Agent turn is active in project {}",
                self.project_id
            );
        }
        let route = project_workspace_url(FLOW_URL, project_id);
        self.page.navigate(&route).await?;
        self.project_id.clear();
        let mut last = Value::Null;
        for _ in 0..BIND_ATTEMPTS {
            if let Ok(status) = self.page.call("agentStatus", json!([project_id])).await {
                if status["ok"].as_bool() == Some(true) {
                    if self.page.bind_agent(project_id).await? {
                        self.project_id = project_id.to_string();
                        return Ok(());
                    }
                } else if status["error"].as_str() == Some("unsupported_front_end") {
                    checked_runtime_result(status)?;
                } else {
                    last = status;
                }
            }
            sleep(BIND_INTERVAL).await;
        }
        anyhow::bail!(
            "Cannot open the Flow Agent page. Check Flow sign-in and project access. {last}"
        );
    }

    /// Returns true while any turn is active in the bound project.
    async fn busy(&self) -> Result<bool> {
        let result = self
            .page
            .call("agentBusy", json!([self.project_id]))
            .await?;
        result
            .as_bool()
            .context("Could not read the Agent turn state")
    }
}

/// Holds the job queue lock while the browser reports an active turn.
async fn hold_while_active(
    page: Arc<BackgroundPage>,
    project_id: String,
    _guard: OwnedMutexGuard<()>,
) {
    let mut errors = 0;
    while page.is_alive() {
        match page.call("agentBusy", json!([project_id])).await {
            Ok(Value::Bool(false)) => break,
            Ok(Value::Bool(true)) => errors = 0,
            _ => {
                errors += 1;
                if errors == TURN_POLL_ERROR_LIMIT {
                    break;
                }
            }
        }
        sleep(TURN_POLL_INTERVAL).await;
    }
}
