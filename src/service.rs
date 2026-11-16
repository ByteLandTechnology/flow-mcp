// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Application service routing Google Flow tools through [`ChromeEngine`].

use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;

use crate::auth::{self, LoginParams};
use crate::engine::ChromeEngine;

/// Application service that coordinates browser authentication and Flow automation tools.
pub(crate) struct FlowService {
    /// Managed Chrome CDP browser engine.
    engine: Arc<ChromeEngine>,
}

impl FlowService {
    /// Creates a [`FlowService`] connected to `engine`.
    pub(crate) fn new(engine: Arc<ChromeEngine>) -> Arc<Self> {
        Arc::new(Self { engine })
    }

    /// Runs `flow_login` actions for Google Sign-In, cookie synchronization, status, and logout.
    pub(crate) async fn login(&self, req: LoginParams) -> Result<Value> {
        auth::handle_login(&self.engine, req).await
    }
}
