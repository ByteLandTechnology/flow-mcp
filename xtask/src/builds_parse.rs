// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Lightweight TypeScript scanner and literal parser for `ts/frontend_builds.ts`.

use std::collections::BTreeMap;

/// Path to the TypeScript front-end build registry relative to the workspace root.
pub(crate) const BUILDS_REL_PATH: &str = "ts/frontend_builds.ts";

/// Token kind produced by the lightweight TypeScript scanner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TsTokKind {
    /// Identifier or keyword.
    Ident(String),
    /// Decoded string literal.
    Str(String),
    /// Single punctuation character.
    Punct(char),
}

/// Token with its 1-based line number in `ts/frontend_builds.ts`.
#[derive(Debug, Clone)]
pub(crate) struct TsTok {
    /// Kind and text payload.
    pub(crate) kind: TsTokKind,
    /// Line number starting at 1.
    pub(crate) line: usize,
}

/// Parsed TypeScript value literal or identifier reference.
#[derive(Debug, Clone)]
pub(crate) enum TsVal {
    /// String literal and line number.
    Str(String, usize),
    /// Identifier reference and line number.
    Ident(String, usize),
    /// Array literal and line number.
    Array(Vec<TsVal>, usize),
    /// Object literal with `(key, value, line)` entries and opening line number.
    Object(Vec<(String, TsVal, usize)>, usize),
}

/// Top-level `const` binding in `ts/frontend_builds.ts`.
pub(crate) struct ConstDef {
    /// Optional declared type identifier (for example `ProjectStoreFormat`).
    pub(crate) type_name: Option<String>,
    /// Assigned value expression.
    pub(crate) value: TsVal,
    /// Declaration line number.
    pub(crate) line: usize,
}

/// Formats one validation error with file and line context.
pub(crate) fn err_at(line: usize, msg: impl Into<String>) -> String {
    format!("{BUILDS_REL_PATH}:{line}: {}", msg.into())
}

/// Scans `src` into comment-stripped TypeScript tokens.
pub(crate) fn tokenize_ts(src: &str) -> Result<Vec<TsTok>, String> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    let mut line = 1usize;

    while i < chars.len() {
        let c = chars[i];
        if c == '\n' {
            line += 1;
            i += 1;
            continue;
        }
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'/') {
            i += 2;
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            let start_line = line;
            i += 2;
            let mut closed = false;
            while i + 1 < chars.len() {
                if chars[i] == '\n' {
                    line += 1;
                }
                if chars[i] == '*' && chars[i + 1] == '/' {
                    i += 2;
                    closed = true;
                    break;
                }
                i += 1;
            }
            if !closed {
                return Err(format!("{start_line}: unterminated block comment"));
            }
            continue;
        }
        if c == '"' || c == '\'' {
            let (text, next_i, next_line) = scan_string(&chars, i, line)?;
            out.push(TsTok {
                kind: TsTokKind::Str(text),
                line,
            });
            i = next_i;
            line = next_line;
            continue;
        }
        if c == '_' || c == '$' || c.is_ascii_alphabetic() {
            let start_line = line;
            let mut ident = String::from(c);
            i += 1;
            while let Some(&ch) = chars.get(i) {
                if ch == '_' || ch == '$' || ch.is_ascii_alphanumeric() {
                    ident.push(ch);
                    i += 1;
                } else {
                    break;
                }
            }
            out.push(TsTok {
                kind: TsTokKind::Ident(ident),
                line: start_line,
            });
            continue;
        }
        out.push(TsTok {
            kind: TsTokKind::Punct(c),
            line,
        });
        i += 1;
    }

    Ok(out)
}

/// Scans a quoted string literal starting at `start_idx`.
fn scan_string(
    chars: &[char],
    start_idx: usize,
    start_line: usize,
) -> Result<(String, usize, usize), String> {
    let quote = chars[start_idx];
    let mut i = start_idx + 1;
    let mut line = start_line;
    let mut text = String::new();

    while i < chars.len() {
        let ch = chars[i];
        if ch == '\n' {
            line += 1;
        }
        if ch == '\\' {
            let Some(&esc) = chars.get(i + 1) else {
                return Err(format!("{start_line}: unterminated string escape"));
            };
            if esc == '\n' {
                line += 1;
            }
            text.push(esc);
            i += 2;
            continue;
        }
        if ch == quote {
            return Ok((text, i + 1, line));
        }
        text.push(ch);
        i += 1;
    }

    Err(format!("{start_line}: unterminated string literal"))
}

/// Checks whether token `idx` matches punctuation `expected`.
pub(crate) fn is_punct(tokens: &[TsTok], idx: usize, expected: char) -> bool {
    matches!(tokens.get(idx), Some(TsTok { kind: TsTokKind::Punct(c), .. }) if *c == expected)
}

/// Checks whether token `idx` matches identifier `expected`.
pub(crate) fn is_ident(tokens: &[TsTok], idx: usize, expected: &str) -> bool {
    matches!(tokens.get(idx), Some(TsTok { kind: TsTokKind::Ident(s), .. }) if s == expected)
}

/// Advances past balanced `<...>`, `(...)`, `{...}`, or `[...]` starting at `idx`.
pub(crate) fn skip_balanced(
    tokens: &[TsTok],
    idx: usize,
    open: char,
    close: char,
) -> Option<usize> {
    if !is_punct(tokens, idx, open) {
        return None;
    }
    let mut depth = 0usize;
    let mut i = idx;
    while i < tokens.len() {
        if is_punct(tokens, i, open) {
            depth += 1;
        } else if is_punct(tokens, i, close) {
            depth -= 1;
            if depth == 0 {
                return Some(i + 1);
            }
        }
        i += 1;
    }
    None
}

/// Parses a literal or identifier value expression starting at `idx`.
pub(crate) fn parse_value(tokens: &[TsTok], idx: usize) -> Result<(TsVal, usize), String> {
    let Some(tok) = tokens.get(idx) else {
        return Err(err_at(1, "unexpected end of file while parsing value"));
    };
    let mut val_and_next = match &tok.kind {
        TsTokKind::Str(s) => (TsVal::Str(s.clone(), tok.line), idx + 1),
        TsTokKind::Ident(name) if name == "new" => {
            if is_ident(tokens, idx + 1, "Map") && is_punct(tokens, idx + 2, '(') {
                let (inner, after_inner) = parse_value(tokens, idx + 3)?;
                if !is_punct(tokens, after_inner, ')') {
                    return Err(err_at(tok.line, "expected `)` after `new Map(...)`"));
                }
                (inner, after_inner + 1)
            } else {
                return Err(err_at(tok.line, "unsupported `new` expression"));
            }
        }
        TsTokKind::Ident(name) => (TsVal::Ident(name.clone(), tok.line), idx + 1),
        TsTokKind::Punct('[') => parse_array(tokens, idx)?,
        TsTokKind::Punct('{') => parse_object(tokens, idx)?,
        TsTokKind::Punct(c) => {
            return Err(err_at(tok.line, format!("unexpected punctuation `{c}`")));
        }
    };
    while is_ident(tokens, val_and_next.1, "as") || is_ident(tokens, val_and_next.1, "satisfies") {
        let mut j = val_and_next.1 + 1;
        while j < tokens.len() {
            if is_punct(tokens, j, ',')
                || is_punct(tokens, j, ';')
                || is_punct(tokens, j, ']')
                || is_punct(tokens, j, '}')
                || is_punct(tokens, j, ')')
            {
                break;
            }
            if is_punct(tokens, j, '[')
                && let Some(after) = skip_balanced(tokens, j, '[', ']')
            {
                j = after;
                continue;
            }
            if is_punct(tokens, j, '<')
                && let Some(after) = skip_balanced(tokens, j, '<', '>')
            {
                j = after;
                continue;
            }
            j += 1;
        }
        val_and_next.1 = j;
    }
    Ok(val_and_next)
}

/// Parses `[...]` starting at `idx`.
pub(crate) fn parse_array(tokens: &[TsTok], idx: usize) -> Result<(TsVal, usize), String> {
    let start_line = tokens.get(idx).map_or(1, |t| t.line);
    let mut i = idx + 1;
    let mut items = Vec::new();
    while i < tokens.len() {
        if is_punct(tokens, i, ']') {
            return Ok((TsVal::Array(items, start_line), i + 1));
        }
        let (item, next) = parse_value(tokens, i)?;
        items.push(item);
        i = next;
        if is_punct(tokens, i, ',') {
            i += 1;
        } else if !is_punct(tokens, i, ']') {
            let line = tokens.get(i).map_or(start_line, |t| t.line);
            return Err(err_at(line, "expected `,` or `]` in array literal"));
        }
    }
    Err(err_at(start_line, "unterminated array literal"))
}

/// Parses `{ key: value, ... }` starting at `idx`.
pub(crate) fn parse_object(tokens: &[TsTok], idx: usize) -> Result<(TsVal, usize), String> {
    let start_line = tokens.get(idx).map_or(1, |t| t.line);
    let mut i = idx + 1;
    let mut entries = Vec::new();
    while i < tokens.len() {
        if is_punct(tokens, i, '}') {
            return Ok((TsVal::Object(entries, start_line), i + 1));
        }
        let Some(key_tok) = tokens.get(i) else {
            break;
        };
        let key_line = key_tok.line;
        let key = match &key_tok.kind {
            TsTokKind::Ident(s) | TsTokKind::Str(s) => s.clone(),
            TsTokKind::Punct(_) => {
                return Err(err_at(key_line, "expected property name in object literal"));
            }
        };
        i += 1;
        let (val, next) = if is_punct(tokens, i, ':') {
            parse_value(tokens, i + 1)?
        } else {
            (TsVal::Ident(key.clone(), key_line), i)
        };
        entries.push((key, val, key_line));
        i = next;
        if is_punct(tokens, i, ',') {
            i += 1;
        } else if !is_punct(tokens, i, '}') {
            let line = tokens.get(i).map_or(key_line, |t| t.line);
            return Err(err_at(line, "expected `,` or `}` in object literal"));
        }
    }
    Err(err_at(start_line, "unterminated object literal"))
}

/// Collects all top-level `const` object and array declarations in `ts/frontend_builds.ts`.
pub(crate) fn collect_top_level_consts(
    tokens: &[TsTok],
    errors: &mut Vec<String>,
) -> BTreeMap<String, ConstDef> {
    let mut consts = BTreeMap::new();
    let mut depth = 0usize;
    let mut i = 0usize;

    while i < tokens.len() {
        if is_punct(tokens, i, '{') || is_punct(tokens, i, '(') || is_punct(tokens, i, '[') {
            depth += 1;
            i += 1;
            continue;
        }
        if is_punct(tokens, i, '}') || is_punct(tokens, i, ')') || is_punct(tokens, i, ']') {
            depth = depth.saturating_sub(1);
            i += 1;
            continue;
        }
        if depth == 0
            && is_ident(tokens, i, "const")
            && let Some(TsTok {
                kind: TsTokKind::Ident(name),
                line,
            }) = tokens.get(i + 1)
        {
            let name = name.clone();
            let decl_line = *line;
            let mut j = i + 2;
            let mut type_name = None;
            if is_punct(tokens, j, ':') {
                j += 1;
                if let Some(TsTok {
                    kind: TsTokKind::Ident(tn),
                    ..
                }) = tokens.get(j)
                {
                    type_name = Some(tn.clone());
                }
                while j < tokens.len() && !is_punct(tokens, j, '=') {
                    if is_punct(tokens, j, '<')
                        && let Some(after) = skip_balanced(tokens, j, '<', '>')
                    {
                        j = after;
                        continue;
                    }
                    j += 1;
                }
            }
            if is_punct(tokens, j, '=') {
                match parse_value(tokens, j + 1) {
                    Ok((value, next)) => {
                        consts.insert(
                            name,
                            ConstDef {
                                type_name,
                                value,
                                line: decl_line,
                            },
                        );
                        i = next;
                        continue;
                    }
                    Err(err) => errors.push(err),
                }
            }
        }
        i += 1;
    }

    consts
}

/// Resolves an identifier reference to its top-level `const` value if present.
pub(crate) fn resolve<'a>(val: &'a TsVal, consts: &'a BTreeMap<String, ConstDef>) -> &'a TsVal {
    let mut cur = val;
    for _ in 0..8 {
        if let TsVal::Ident(name, _) = cur
            && let Some(def) = consts.get(name)
        {
            cur = &def.value;
            continue;
        }
        break;
    }
    cur
}

/// Map from property name to `(value, key_line)` inside a TypeScript object literal.
pub(crate) type ObjectEntries<'a> = BTreeMap<&'a str, (&'a TsVal, usize)>;

/// Returns a lookup map for an object literal, recording duplicate key errors.
pub(crate) fn object_map<'a>(
    ctx: &str,
    val: &'a TsVal,
    consts: &'a BTreeMap<String, ConstDef>,
    errors: &mut Vec<String>,
) -> Option<(ObjectEntries<'a>, usize)> {
    let resolved = resolve(val, consts);
    let TsVal::Object(entries, line) = resolved else {
        errors.push(err_at(
            val_line(val),
            format!("{ctx} must be an object literal"),
        ));
        return None;
    };
    let mut map = BTreeMap::new();
    for (k, v, k_line) in entries {
        if map.insert(k.as_str(), (v, *k_line)).is_some() {
            errors.push(err_at(*k_line, format!("{ctx} duplicates key `{k}`")));
        }
    }
    Some((map, *line))
}

/// Returns the 1-based source line of `val`.
pub(crate) fn val_line(val: &TsVal) -> usize {
    match val {
        TsVal::Str(_, l) | TsVal::Ident(_, l) | TsVal::Array(_, l) | TsVal::Object(_, l) => *l,
    }
}
