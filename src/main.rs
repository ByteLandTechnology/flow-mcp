// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Binary entry point for `flow-mcp`.

mod assets;
mod auth;
mod cdp;
mod characters;
mod chrome;
mod cli;
mod collections;
mod config;
mod cookies;
mod db;
mod download;
mod engine;
mod generation;
mod mcp;
mod media_files;
mod project;
mod queue;
mod scenes;
mod service;

use anyhow::Result;
use clap::Parser;

/// Parses the command line and runs the selected subcommand.
#[tokio::main]
async fn main() -> Result<()> {
    cli::run(cli::Cli::parse()).await
}
