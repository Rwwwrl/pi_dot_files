# Bug: `question_tool` mode-switch choices do not switch modes

## Problem

When the assistant asks a `question_tool` question with an option such as:

> Switch to auto/normal and implement

selecting that option does not actually change the active mode.

The selected option is returned only as user input. It does not execute `/auto`, `/normal`, or call the modes extension mode-switching logic.

## Why this is confusing

The option wording implies that selecting it will switch the session mode. In reality, the assistant remains in the previous mode, such as research mode.

This can lead to invalid follow-up behavior where the assistant believes it has permission to modify files, but the active mode has not changed.

## Desired behavior

When the current mode/tool policy does not allow an action, state that limitation as a fact. Do not offer a `question_tool` option to switch modes or choose a blocked-tool path.

The user can decide later whether to manually switch modes, change the request, or do something else.

## Recommended wording

Instead of:

> Switch to auto/normal and implement

Use:

> Current mode does not allow that action.

## Notes

`question_tool` is only for collecting a choice; it is not a mode-switching command.
